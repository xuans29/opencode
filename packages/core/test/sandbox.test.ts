import path from "path"
import fs from "fs/promises"
import { describe, expect, test } from "bun:test"
import { Deferred, Duration, Effect, Fiber, Ref } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { AppProcess } from "@opencode-ai/util/process"
import { Sandbox } from "../src/sandbox"
import { SessionSchema } from "../src/session/schema"
import { tmpdir } from "./fixture/tmpdir"

const options = {
  runtime: "docker",
  image: "opencode-sandbox:test",
  user: "65532:65532",
  timeout: 1_000,
} satisfies Sandbox.Options
const sessionID = SessionSchema.ID.make("ses_test")

const result = (input?: { readonly exitCode?: number; readonly output?: string; readonly truncated?: boolean }) =>
  ({
    command: "docker",
    exitCode: input?.exitCode ?? 0,
    output: Buffer.from(input?.output ?? ""),
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    outputTruncated: input?.truncated ?? false,
    stdoutTruncated: false,
    stderrTruncated: false,
  }) satisfies AppProcess.RunResult

const standard = (command: ChildProcess.Command) => {
  if (!ChildProcess.isStandardCommand(command)) throw new Error("Expected a standard command")
  return command
}

describe("Sandbox.dockerArgs", () => {
  test("builds a locked-down one-shot container invocation", () => {
    const projectDirectory = path.resolve("sandbox-project")
    const args = Sandbox.dockerArgs(
      {
        sessionID,
        profile: "script",
        projectDirectory,
        cwd: path.join(projectDirectory, "src"),
        command: "python3",
        args: ["-", "argument with spaces", "; rm -rf /"],
        stdin: "print('ok')",
      },
      {
        ...options,
        cpu: 0.5,
        memoryMb: 256,
        pids: 32,
        tmpfsMb: 16,
      },
      "opencode-sandbox-test",
    )

    expect(args).toContain("--rm")
    expect(args).toContain("--init")
    expect(args).toContain("--pull=never")
    expect(args).toContain("--log-driver=none")
    expect(args).toContain("--network=none")
    expect(args).toContain("--ipc=none")
    expect(args).toContain("--read-only")
    expect(args).toContain("--cap-drop=ALL")
    expect(args).toContain("--security-opt=no-new-privileges=true")
    expect(args).toContain("--interactive")
    expect(args).toContain(`type=bind,source=${projectDirectory},target=/workspace`)
    expect(args.slice(args.indexOf("--cpus"), args.indexOf("--cpus") + 2)).toEqual(["--cpus", "0.5"])
    expect(args.slice(args.indexOf("--memory"), args.indexOf("--memory") + 2)).toEqual(["--memory", "256m"])
    expect(args.slice(args.indexOf("--pids-limit"), args.indexOf("--pids-limit") + 2)).toEqual(["--pids-limit", "32"])
    expect(args).toContain("nofile=256:256")
    expect(args).toContain("core=0:0")
    expect(args).toContain(`fsize=${64 * 1024 * 1024}:${64 * 1024 * 1024}`)
    expect(args).toContain("ai.opencode.profile=script")
    for (const name of [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "FTP_PROXY",
      "ALL_PROXY",
      "NO_PROXY",
      "http_proxy",
      "https_proxy",
      "ftp_proxy",
      "all_proxy",
      "no_proxy",
    ]) {
      expect(args).toContain(`${name}=`)
    }
    expect(args.slice(args.indexOf("--workdir"), args.indexOf("--workdir") + 2)).toEqual([
      "--workdir",
      "/workspace/src",
    ])
    expect(args.slice(args.indexOf("--entrypoint"))).toEqual([
      "--entrypoint",
      "/usr/bin/timeout",
      "opencode-sandbox:test",
      "--signal=TERM",
      "--kill-after=3s",
      "0.9s",
      "python3",
      "-",
      "argument with spaces",
      "; rm -rf /",
    ])
    expect(args).not.toContain("--privileged")
  })

  test("hashes custom Session IDs before adding them to container labels", () => {
    const args = Sandbox.dockerArgs(
      {
        sessionID: SessionSchema.ID.make("ses/custom value"),
        profile: "shell",
        projectDirectory: path.resolve("sandbox-project"),
        command: "sh",
      },
      options,
      "safe",
    )
    const label = args.find((argument) => argument.startsWith("ai.opencode.session="))
    expect(label).toMatch(/^ai\.opencode\.session=[a-f0-9]{24}$/)
    expect(label).not.toContain("custom value")
  })

  test("rejects a working directory outside the project", () => {
    const projectDirectory = path.resolve("sandbox-project")
    expect(() =>
      Sandbox.dockerArgs(
        {
          sessionID,
          profile: "shell",
          projectDirectory,
          cwd: path.resolve(projectDirectory, "..", "outside"),
          command: "sh",
        },
        options,
        "opencode-sandbox-test",
      ),
    ).toThrow(Sandbox.InvalidWorkingDirectoryError)
  })

  test("requires a canonical numeric non-root UID and GID", () => {
    for (const user of ["root", "root:root", "root:1", "0", "0:0", "00:1", "1:0", "01:2", "1:02"]) {
      expect(() =>
        Sandbox.dockerArgs(
          {
            sessionID,
            profile: "shell",
            projectDirectory: path.resolve("sandbox-project"),
            command: "sh",
          },
          { ...options, user },
          "opencode-sandbox-test",
        ),
      ).toThrow("numeric, non-root UID:GID")
    }
  })

  test("rejects project paths that Docker mount syntax cannot express safely", () => {
    for (const projectDirectory of [path.resolve("sandbox,project"), `${path.resolve("sandbox-project")}\0suffix`]) {
      expect(() =>
        Sandbox.dockerArgs(
          {
            sessionID,
            profile: "shell",
            projectDirectory,
            command: "sh",
          },
          options,
          "opencode-sandbox-test",
        ),
      ).toThrow(Sandbox.InvalidInputError)
    }
  })

  test("rejects option-like images and invalid container names", () => {
    const input = {
      sessionID,
      profile: "shell" as const,
      projectDirectory: path.resolve("sandbox-project"),
      command: "sh",
    }
    for (const image of [
      "--privileged",
      "UPPER/repository:tag",
      "repository:",
      "repository@sha256:abc",
      "registry.example:70000/repository",
      "repository//child",
    ]) {
      expect(() => Sandbox.dockerArgs(input, { ...options, image }, "safe-name")).toThrow(RangeError)
    }
    expect(() =>
      Sandbox.dockerArgs(
        input,
        { ...options, image: `registry.example:5000/team/repository@sha256:${"a".repeat(64)}` },
        "safe-name",
      ),
    ).not.toThrow()
    expect(() => Sandbox.dockerArgs(input, options, "-unsafe-name")).toThrow(Sandbox.InvalidInputError)
  })

  test("bounds argument count, individual arguments, and total input bytes", () => {
    const input = {
      sessionID,
      profile: "script" as const,
      projectDirectory: path.resolve("sandbox-project"),
      command: "python3",
    }
    expect(() => Sandbox.dockerArgs({ ...input, args: ["-", "extra"] }, { ...options, maxArgs: 1 }, "safe")).toThrow(
      Sandbox.InvalidInputError,
    )
    expect(() =>
      Sandbox.dockerArgs(
        { ...input, projectDirectory: ".", command: "sh", args: ["12345"] },
        { ...options, maxArgBytes: 4 },
        "safe",
      ),
    ).toThrow("Sandbox argument exceeds the 4 byte limit")
    const fixedBytes =
      Buffer.byteLength(sessionID) + Buffer.byteLength(input.projectDirectory) + Buffer.byteLength(input.command)
    expect(() =>
      Sandbox.dockerArgs({ ...input, stdin: "12345" }, { ...options, maxInputBytes: fixedBytes + 4 }, "safe"),
    ).toThrow("Sandbox input exceeds")
  })

  test("bounds project and working-directory path bytes before resolving them", () => {
    const input = {
      sessionID,
      profile: "shell" as const,
      projectDirectory: ".",
      command: "sh",
    }
    expect(() =>
      Sandbox.dockerArgs({ ...input, projectDirectory: "12345" }, { ...options, maxArgBytes: 4 }, "safe"),
    ).toThrow("Sandbox project directory exceeds the 4 byte limit")
    expect(() => Sandbox.dockerArgs({ ...input, cwd: "12345" }, { ...options, maxArgBytes: 4 }, "safe")).toThrow(
      "Sandbox working directory exceeds the 4 byte limit",
    )
  })

  test("rejects unsafe path characters introduced by canonical symlink targets", async () => {
    await using tmp = await tmpdir()
    const projectTarget = path.join(tmp.path, "project,source=protected")
    const projectLink = path.join(tmp.path, "project-link")
    await fs.mkdir(projectTarget)
    await fs.symlink(projectTarget, projectLink, process.platform === "win32" ? "junction" : undefined)
    expect(() =>
      Sandbox.dockerArgs(
        { sessionID, profile: "shell", projectDirectory: projectLink, command: "sh" },
        options,
        "safe",
      ),
    ).toThrow("Sandbox paths must not contain commas")

    const cwdProject = path.join(tmp.path, "cwd-project")
    const cwdTarget = path.join(cwdProject, "cwd,source=protected")
    const cwdLink = path.join(cwdProject, "cwd-link")
    await fs.mkdir(cwdProject)
    await fs.mkdir(cwdTarget)
    await fs.symlink(cwdTarget, cwdLink, process.platform === "win32" ? "junction" : undefined)
    expect(() =>
      Sandbox.dockerArgs(
        { sessionID, profile: "shell", projectDirectory: cwdProject, cwd: cwdLink, command: "sh" },
        options,
        "safe",
      ),
    ).toThrow("Sandbox paths must not contain commas")
  })

  test("enforces configured workspace roots and rejects filesystem roots", () => {
    const allowed = path.resolve("allowed-workspaces")
    const input = {
      sessionID,
      profile: "shell" as const,
      command: "sh",
    }
    expect(() =>
      Sandbox.dockerArgs(
        { ...input, projectDirectory: path.join(allowed, "project") },
        { ...options, workspaceRoots: [allowed] },
        "safe",
      ),
    ).not.toThrow()
    expect(() =>
      Sandbox.dockerArgs(
        { ...input, projectDirectory: path.resolve("outside-workspace") },
        { ...options, workspaceRoots: [allowed] },
        "safe",
      ),
    ).toThrow("outside the configured workspace roots")
    expect(() =>
      Sandbox.dockerArgs({ ...input, projectDirectory: path.parse(path.resolve(".")).root }, options, "safe"),
    ).toThrow("must not be a filesystem root")
  })

  test("rejects projects that contain or sit inside protected service data", () => {
    const protectedData = path.resolve("sandbox-service-data")
    const input = {
      sessionID,
      profile: "shell" as const,
      command: "sh",
    }
    for (const projectDirectory of [protectedData, path.join(protectedData, "project"), path.dirname(protectedData)]) {
      expect(() =>
        Sandbox.dockerArgs({ ...input, projectDirectory }, { ...options, protectedPaths: [protectedData] }, "safe"),
      ).toThrow("overlaps protected OpenCode service data")
    }
    expect(() =>
      Sandbox.dockerArgs(
        { ...input, projectDirectory: path.resolve("sandbox-service-data-sibling") },
        { ...options, protectedPaths: [protectedData] },
        "safe",
      ),
    ).not.toThrow()
  })
})

describe("Sandbox.Service", () => {
  test("returns a typed error when the runtime is unavailable", async () => {
    const service = Sandbox.make(options, {
      run: (command) =>
        Effect.succeed(
          standard(command).args[0] === "info"
            ? result({ exitCode: 1, output: "Cannot connect to the Docker daemon" })
            : result(),
        ),
    })
    const error = await Effect.runPromise(
      service
        .run({
          sessionID,
          profile: "shell",
          projectDirectory: path.resolve("sandbox-project"),
          command: "sh",
        })
        .pipe(Effect.flip),
    )

    expect(error).toBeInstanceOf(Sandbox.UnavailableError)
    expect(error.message).toContain("Cannot connect to the Docker daemon")
  })

  test("returns combined bounded output and always removes the container", async () => {
    const calls: Array<ChildProcess.Command> = []
    const service = Sandbox.make(options, {
      run: (command) =>
        Effect.sync(() => {
          const args = standard(command).args
          calls.push(command)
          if (args[0] === "run") return result({ output: "stdout\nstderr\n", truncated: true })
          return result()
        }),
    })
    const output = await Effect.runPromise(
      service.run({
        sessionID,
        profile: "shell",
        projectDirectory: path.resolve("sandbox-project"),
        command: "sh",
        args: ["-c", "echo ok"],
      }),
    )

    expect(output).toEqual({ exitCode: 0, output: "stdout\nstderr\n", truncated: true })
    const commands = calls.map(standard)
    expect(commands.map((command) => command.args[0])).toEqual(["info", "run", "rm"])
    const run = commands.find((command) => command.args[0] === "run")
    const cleanup = commands.find((command) => command.args[0] === "rm")
    expect(run).toBeDefined()
    expect(cleanup?.args.slice(0, 2)).toEqual(["rm", "--force"])
    expect(cleanup?.args[2]).toBe(run?.args[run.args.indexOf("--name") + 1])
    for (const command of commands) {
      expect(Duration.toMillis(command.options.forceKillAfter ?? Duration.zero)).toBe(3_000)
    }
  })

  test("caches a successful runtime check and still maps later run failures", async () => {
    let infoCalls = 0
    let runCalls = 0
    const service = Sandbox.make(options, {
      run: (command) =>
        Effect.sync(() => {
          const args = standard(command).args
          if (args[0] === "info") {
            infoCalls++
            return result()
          }
          if (args[0] === "rm") return result()
          runCalls++
          return runCalls === 1 ? result({ output: "ok" }) : result({ exitCode: 125, output: "image missing" })
        }),
    })
    const input = {
      sessionID,
      profile: "shell" as const,
      projectDirectory: path.resolve("sandbox-project"),
      command: "sh",
    }

    expect(await Effect.runPromise(service.run(input))).toEqual({ exitCode: 0, output: "ok", truncated: false })
    const error = await Effect.runPromise(service.run(input).pipe(Effect.flip))
    expect(error).toBeInstanceOf(Sandbox.ExecutionError)
    expect(error.message).toContain("image missing")
    expect(infoCalls).toBe(1)
  })

  test("normalizes the container timeout exit code", async () => {
    const service = Sandbox.make(options, {
      run: (command) => Effect.succeed(standard(command).args[0] === "run" ? result({ exitCode: 124 }) : result()),
    })
    const error = await Effect.runPromise(
      service
        .run({
          sessionID,
          profile: "shell",
          projectDirectory: path.resolve("sandbox-project"),
          command: "sh",
          timeout: 250,
        })
        .pipe(Effect.flip),
    )

    expect(error).toEqual(new Sandbox.TimeoutError({ timeout: 250 }))
  })

  test("kills and removes the named container after timeout", async () => {
    const cleanup = await Effect.runPromise(
      Effect.gen(function* () {
        const removed = yield* Deferred.make<string>()
        const service = Sandbox.make(
          { ...options, timeout: 20 },
          {
            run: (command) => {
              const args = standard(command).args
              if (args[0] === "run") return Effect.never
              if (args[0] === "rm") return Deferred.succeed(removed, args[2] ?? "").pipe(Effect.as(result()))
              return Effect.succeed(result())
            },
          },
        )
        const error = yield* service
          .run({
            sessionID,
            profile: "shell",
            projectDirectory: path.resolve("sandbox-project"),
            command: "sh",
          })
          .pipe(Effect.flip)
        expect(error).toBeInstanceOf(Sandbox.TimeoutError)
        return yield* Deferred.await(removed)
      }),
    )

    expect(cleanup.startsWith("opencode-sandbox-")).toBe(true)
  })

  test("removes the named container when the caller is interrupted", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const removed = yield* Deferred.make<void>()
        const service = Sandbox.make(options, {
          run: (command) => {
            const args = standard(command).args
            if (args[0] === "run") return Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
            if (args[0] === "rm") return Deferred.succeed(removed, undefined).pipe(Effect.as(result()))
            return Effect.succeed(result())
          },
        })
        const fiber = yield* service
          .run({
            sessionID,
            profile: "shell",
            projectDirectory: path.resolve("sandbox-project"),
            command: "sh",
          })
          .pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(started)
        yield* Fiber.interrupt(fiber)
        expect(yield* Deferred.isDone(removed)).toBe(true)
      }),
    )
  })

  test("serializes calls belonging to the same session", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>()
        const secondStarted = yield* Deferred.make<void>()
        const firstRelease = yield* Deferred.make<void>()
        const secondRelease = yield* Deferred.make<void>()
        const runs = yield* Ref.make(0)
        const service = Sandbox.make(options, {
          run: (command) => {
            const args = standard(command).args
            if (args[0] !== "run") return Effect.succeed(result())
            return Ref.getAndUpdate(runs, (count) => count + 1).pipe(
              Effect.flatMap((index) =>
                Deferred.succeed(index === 0 ? firstStarted : secondStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(index === 0 ? firstRelease : secondRelease)),
                  Effect.as(result()),
                ),
              ),
            )
          },
        })
        const input = {
          sessionID,
          profile: "shell" as const,
          projectDirectory: path.resolve("sandbox-project"),
          command: "sh",
        }
        const first = yield* service.run(input).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(firstStarted)
        const second = yield* service.run(input).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Effect.yieldNow
        expect(yield* Deferred.isDone(secondStarted)).toBe(false)
        yield* Deferred.succeed(firstRelease, undefined)
        yield* Deferred.await(secondStarted)
        yield* Deferred.succeed(secondRelease, undefined)
        yield* Fiber.join(first)
        yield* Fiber.join(second)
      }),
    )
  })

  test("enforces the service-wide concurrency limit across sessions", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const firstStarted = yield* Deferred.make<void>()
        const secondStarted = yield* Deferred.make<void>()
        const firstRelease = yield* Deferred.make<void>()
        const secondRelease = yield* Deferred.make<void>()
        const runs = yield* Ref.make(0)
        const service = Sandbox.make(
          { ...options, maxConcurrent: 1 },
          {
            run: (command) => {
              const args = standard(command).args
              if (args[0] !== "run") return Effect.succeed(result())
              return Ref.getAndUpdate(runs, (count) => count + 1).pipe(
                Effect.flatMap((index) =>
                  Deferred.succeed(index === 0 ? firstStarted : secondStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(index === 0 ? firstRelease : secondRelease)),
                    Effect.as(result()),
                  ),
                ),
              )
            },
          },
        )
        const input = {
          profile: "shell" as const,
          projectDirectory: path.resolve("sandbox-project"),
          command: "sh",
        }
        const first = yield* service
          .run({ ...input, sessionID: SessionSchema.ID.make("ses_first") })
          .pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(firstStarted)
        const second = yield* service
          .run({ ...input, sessionID: SessionSchema.ID.make("ses_second") })
          .pipe(Effect.forkChild({ startImmediately: true }))
        yield* Effect.yieldNow
        expect(yield* Deferred.isDone(secondStarted)).toBe(false)
        yield* Deferred.succeed(firstRelease, undefined)
        yield* Deferred.await(secondStarted)
        yield* Deferred.succeed(secondRelease, undefined)
        yield* Fiber.join(first)
        yield* Fiber.join(second)
      }),
    )
  })

  test("rejects calls beyond the bounded Session queue", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const runs = yield* Ref.make(0)
        const service = Sandbox.make(
          { ...options, maxSessionConcurrent: 1, maxSessionPending: 1 },
          {
            run: (command) => {
              const args = standard(command).args
              if (args[0] !== "run") return Effect.succeed(result())
              return Ref.getAndUpdate(runs, (count) => count + 1).pipe(
                Effect.flatMap((index) =>
                  index === 0
                    ? Deferred.succeed(started, undefined).pipe(
                        Effect.andThen(Deferred.await(release)),
                        Effect.as(result()),
                      )
                    : Effect.succeed(result()),
                ),
              )
            },
          },
        )
        const input = {
          sessionID,
          profile: "shell" as const,
          projectDirectory: path.resolve("sandbox-project"),
          command: "sh",
        }
        const first = yield* service.run(input).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(started)
        const second = yield* service.run(input).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Effect.yieldNow
        const error = yield* service.run(input).pipe(Effect.flip)
        expect(error).toBeInstanceOf(Sandbox.BusyError)
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(first)
        yield* Fiber.join(second)
      }),
    )
  })

  test("rejects calls beyond the bounded service-wide queue", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const runs = yield* Ref.make(0)
        const service = Sandbox.make(
          { ...options, maxConcurrent: 1, maxPending: 1 },
          {
            run: (command) => {
              const args = standard(command).args
              if (args[0] !== "run") return Effect.succeed(result())
              return Ref.getAndUpdate(runs, (count) => count + 1).pipe(
                Effect.flatMap((index) =>
                  index === 0
                    ? Deferred.succeed(started, undefined).pipe(
                        Effect.andThen(Deferred.await(release)),
                        Effect.as(result()),
                      )
                    : Effect.succeed(result()),
                ),
              )
            },
          },
        )
        const input = {
          profile: "shell" as const,
          projectDirectory: path.resolve("sandbox-project"),
          command: "sh",
        }
        const first = yield* service
          .run({ ...input, sessionID: SessionSchema.ID.make("ses_capacity_first") })
          .pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(started)
        const second = yield* service
          .run({ ...input, sessionID: SessionSchema.ID.make("ses_capacity_second") })
          .pipe(Effect.forkChild({ startImmediately: true }))
        yield* Effect.yieldNow
        const error = yield* service
          .run({ ...input, sessionID: SessionSchema.ID.make("ses_capacity_third") })
          .pipe(Effect.flip)
        expect(error).toBeInstanceOf(Sandbox.CapacityError)
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(first)
        yield* Fiber.join(second)
      }),
    )
  })

  test("includes queueing time in the call deadline", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        const runs = yield* Ref.make(0)
        const service = Sandbox.make(
          { ...options, maxConcurrent: 1, maxPending: 1 },
          {
            run: (command) => {
              const args = standard(command).args
              if (args[0] !== "run") return Effect.succeed(result())
              return Ref.updateAndGet(runs, (count) => count + 1).pipe(
                Effect.andThen(Deferred.succeed(started, undefined)),
                Effect.andThen(Deferred.await(release)),
                Effect.as(result()),
              )
            },
          },
        )
        const input = {
          profile: "shell" as const,
          projectDirectory: path.resolve("sandbox-project"),
          command: "sh",
        }
        const first = yield* service
          .run({ ...input, sessionID: SessionSchema.ID.make("ses_deadline_first") })
          .pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(started)
        const error = yield* service
          .run({ ...input, sessionID: SessionSchema.ID.make("ses_deadline_second"), timeout: 20 })
          .pipe(Effect.flip)
        expect(error).toEqual(new Sandbox.TimeoutError({ timeout: 20 }))
        expect(yield* Ref.get(runs)).toBe(1)
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(first)
      }),
    )
  })
})
