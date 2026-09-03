import fs from "fs/promises"
import path from "path"
import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Location } from "@opencode-ai/core/location"
import { Sandbox } from "@opencode-ai/core/sandbox/service"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { location } from "./fixture/location"

const enabled = process.env.OPENCODE_RUN_SANDBOX_INTEGRATION === "1"
const integrationTest = enabled ? test : test.skip
const node = enabled ? Bun.which("node") : undefined
const publicNetworkAvailable =
  enabled &&
  Bun.spawnSync([
    "/usr/bin/python3",
    "-c",
    "import socket; s=socket.create_connection(('example.com', 80), 2); s.close()",
  ]).exitCode === 0
const publicNetworkTest = publicNetworkAvailable ? test : test.skip
const roots = new Set<string>()

if (!enabled) console.warn("sandbox integration skipped: set OPENCODE_RUN_SANDBOX_INTEGRATION=1 on Linux")
if (enabled && !publicNetworkAvailable)
  console.warn("public network isolation skipped: the outer container cannot reach example.com:80")
if (enabled && !node) console.warn("Node.js execution skipped: the container does not have the node command")

afterEach(async () => {
  await Promise.all([...roots].map((item) => fs.rm(item, { recursive: true, force: true })))
  roots.clear()
})

describe("real bwrap sandbox integration", () => {
  integrationTest(
    "executes basic commands and supports workspace file lifecycle",
    async () => {
      const fixture = await createFixture()
      await fs.writeFile(path.join(fixture.workspace, "input.txt"), "fixture-content")
      const result = await run(
        fixture.workspace,
        "echo echo-ok; pwd; ls; cat input.txt; printf modified > lifecycle.txt; cat lifecycle.txt; rm lifecycle.txt; test ! -e lifecycle.txt",
      )

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("echo-ok")
      expect(result.stdout).toContain(fixture.workspace)
      expect(result.stdout).toContain("input.txt")
      expect(result.stdout).toContain("fixture-content")
      expect(result.stdout).toContain("modified")
      expect(await exists(path.join(fixture.workspace, "lifecycle.txt"))).toBe(false)
    },
    10_000,
  )

  integrationTest(
    "executes a Bash script",
    async () => {
      const fixture = await createFixture()
      await fs.writeFile(path.join(fixture.workspace, "script.sh"), "set -eu\nprintf 'bash-script-ok:%s' \"$PWD\"\n")
      const result = await run(fixture.workspace, "bash script.sh")

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe(`bash-script-ok:${fixture.workspace}`)
    },
    10_000,
  )

  integrationTest(
    "executes a Python script",
    async () => {
      const fixture = await createFixture()
      await fs.writeFile(
        path.join(fixture.workspace, "script.py"),
        "from pathlib import Path\nPath('python-created.txt').write_text('python-ok')\nprint(Path('python-created.txt').read_text())\n",
      )
      const result = await run(fixture.workspace, "python3 script.py")

      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim()).toBe("python-ok")
      expect(await fs.readFile(path.join(fixture.workspace, "python-created.txt"), "utf8")).toBe("python-ok")
    },
    10_000,
  )

  integrationTest(
    "executes a Bun TypeScript script",
    async () => {
      const fixture = await createFixture()
      await fs.writeFile(
        path.join(fixture.workspace, "script.ts"),
        "const value: string = 'bun-typescript-ok'\nawait Bun.write('bun-created.txt', value)\nconsole.log(value)\n",
      )
      const result = await run(fixture.workspace, "bun script.ts")

      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim()).toBe("bun-typescript-ok")
      expect(await fs.readFile(path.join(fixture.workspace, "bun-created.txt"), "utf8")).toBe("bun-typescript-ok")
    },
    10_000,
  )

  ;(node ? test : test.skip)(
    "executes Node.js when the command is installed",
    async () => {
      const fixture = await createFixture()
      const result = await run(fixture.workspace, "node -e \"console.log('node-ok')\"")

      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim()).toBe("node-ok")
    },
    10_000,
  )

  integrationTest(
    "blocks reading a dedicated file outside the workspace",
    async () => {
      const fixture = await createFixture()
      const marker = path.join(fixture.outside, "outside-read.txt")
      await fs.writeFile(marker, "non-sensitive-marker")
      const result = await run(fixture.workspace, `cat '${marker}'`)

      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).not.toContain("non-sensitive-marker")
      expect(result.stderr).toContain(marker)
    },
    10_000,
  )

  integrationTest(
    "blocks writing outside the workspace",
    async () => {
      const fixture = await createFixture()
      const target = path.join(fixture.outside, "outside-write.txt")
      const result = await run(fixture.workspace, `printf escaped > '${target}'`)

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr.length).toBeGreaterThan(0)
      expect(await exists(target)).toBe(false)
    },
    10_000,
  )

  integrationTest(
    "keeps system directories read-only",
    async () => {
      const fixture = await createFixture()
      const suffix = crypto.randomUUID()
      const etcTarget = `/etc/opencode-sandbox-${suffix}`
      const usrTarget = `/usr/opencode-sandbox-${suffix}`
      const etc = await run(fixture.workspace, `printf denied > '${etcTarget}'`)
      const usr = await run(fixture.workspace, `printf denied > '${usrTarget}'`)

      expect(etc.exitCode).not.toBe(0)
      expect(usr.exitCode).not.toBe(0)
      expect(`${etc.stderr}\n${usr.stderr}`).toMatch(/Read-only file system|Permission denied/)
      expect(await exists(etcTarget)).toBe(false)
      expect(await exists(usrTarget)).toBe(false)
    },
    15_000,
  )

  integrationTest(
    "blocks multi-level parent traversal outside the workspace",
    async () => {
      const fixture = await createFixture()
      const marker = path.join(fixture.outside, "traversal.txt")
      await fs.writeFile(marker, "traversal-marker")
      const relative = path.relative(fixture.workspace, marker)
      const result = await run(fixture.workspace, `cat '${relative}'`)

      expect(relative).toStartWith("..")
      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).not.toContain("traversal-marker")
    },
    10_000,
  )

  integrationTest(
    "blocks a workspace symlink that targets an outside file",
    async () => {
      const fixture = await createFixture()
      const marker = path.join(fixture.outside, "symlink-target.txt")
      await fs.writeFile(marker, "symlink-marker")
      await fs.symlink(marker, path.join(fixture.workspace, "escape-link"))
      const result = await run(fixture.workspace, "cat escape-link")

      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).not.toContain("symlink-marker")
      expect(await fs.readFile(marker, "utf8")).toBe("symlink-marker")
    },
    10_000,
  )

  integrationTest(
    "clears a unique sensitive environment variable",
    async () => {
      const fixture = await createFixture()
      const name = `OPENCODE_SANDBOX_SECRET_${crypto.randomUUID().replaceAll("-", "_")}`
      const result = await run(
        fixture.workspace,
        `if printenv '${name}'; then exit 91; fi; printf secret-absent`,
        { env: { [name]: "temporary-non-sensitive-test-value" } },
      )

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe("secret-absent")
      expect(result.stdout).not.toContain("temporary-non-sensitive-test-value")
    },
    10_000,
  )

  integrationTest(
    "sets the required PATH HOME and TMPDIR policy",
    async () => {
      const fixture = await createFixture()
      const result = await run(
        fixture.workspace,
        "printf 'PATH=%s\\nHOME=%s\\nTMPDIR=%s\\n' \"$PATH\" \"$HOME\" \"$TMPDIR\"",
      )

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain(`PATH=${fixture.workspace}/.venv/bin:${fixture.workspace}/node_modules/.bin:`)
      expect(result.stdout).toContain(`HOME=${fixture.workspace}\n`)
      expect(result.stdout).toContain("TMPDIR=/tmp\n")
    },
    10_000,
  )

  publicNetworkTest(
    "blocks public network access after confirming outer connectivity",
    async () => {
      const fixture = await createFixture()
      const result = await run(
        fixture.workspace,
        "python3 -c \"import socket; socket.create_connection(('example.com', 80), 2)\"",
      )

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr.length).toBeGreaterThan(0)
    },
    10_000,
  )

  integrationTest(
    "blocks access to an outer loopback service",
    async () => {
      const fixture = await createFixture()
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("outer-service") })
      try {
        expect(await (await fetch(`http://127.0.0.1:${server.port}`)).text()).toBe("outer-service")
        const result = await run(
          fixture.workspace,
          `python3 -c \"import socket; socket.create_connection(('127.0.0.1', ${server.port}), 1)\"`,
        )

        expect(result.exitCode).not.toBe(0)
        expect(result.stderr.length).toBeGreaterThan(0)
      } finally {
        server.stop(true)
      }
    },
    10_000,
  )

  integrationTest(
    "exposes only the isolated network interface and no default route",
    async () => {
      const fixture = await createFixture()
      const result = await run(fixture.workspace, "cat /proc/net/dev; printf '\\n--ROUTE--\\n'; cat /proc/net/route")

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("lo:")
      expect(result.stdout).not.toMatch(/\beth\d*:/)
      expect(result.stdout).not.toMatch(/\n\S+\s+00000000\s/)
    },
    10_000,
  )

  integrationTest(
    "drops effective and bounding capabilities",
    async () => {
      const fixture = await createFixture()
      const result = await run(fixture.workspace, "grep -E '^(CapEff|CapBnd):' /proc/self/status")

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("CapEff:\t0000000000000000")
      expect(result.stdout).toContain("CapBnd:\t0000000000000000")
    },
    10_000,
  )

  integrationTest(
    "rejects an unprivileged tmpfs mount",
    async () => {
      const fixture = await createFixture()
      const result = await run(fixture.workspace, "mkdir mountpoint && mount -t tmpfs -o size=64k none mountpoint")

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toMatch(/permission denied|Operation not permitted|must be superuser/i)
    },
    10_000,
  )

  integrationTest(
    "does not expose the Docker socket",
    async () => {
      const fixture = await createFixture()
      const result = await run(
        fixture.workspace,
        "if [ -e /var/run/docker.sock ] || [ -r /var/run/docker.sock ]; then exit 92; fi; printf docker-socket-absent",
      )

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe("docker-socket-absent")
    },
    10_000,
  )

  integrationTest(
    "hides files from the outer tmp directory",
    async () => {
      const fixture = await createFixture()
      const marker = path.join("/tmp", `opencode-sandbox-outer-${crypto.randomUUID()}`)
      roots.add(marker)
      await fs.writeFile(marker, "outer-tmp-marker")
      const result = await run(fixture.workspace, `cat '${marker}'`)

      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).not.toContain("outer-tmp-marker")
      expect(await fs.readFile(marker, "utf8")).toBe("outer-tmp-marker")
    },
    10_000,
  )

  integrationTest(
    "discards files created in sandbox tmp after exit",
    async () => {
      const fixture = await createFixture()
      const marker = path.join("/tmp", `opencode-sandbox-inner-${crypto.randomUUID()}`)
      roots.add(marker)
      const result = await run(fixture.workspace, `printf inner-tmp-marker > '${marker}'; cat '${marker}'`)

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe("inner-tmp-marker")
      expect(await exists(marker)).toBe(false)
    },
    10_000,
  )

  integrationTest(
    "inherits the configured RLIMIT_NOFILE through bwrap",
    async () => {
      const fixture = await createFixture()
      const previous = process.env.OPENCODE_SANDBOX_OPEN_FILES
      process.env.OPENCODE_SANDBOX_OPEN_FILES = "64"
      try {
        const result = await run(fixture.workspace, "ulimit -n")
        expect(result.exitCode).toBe(0)
        expect(result.stdout.trim()).toBe("64")
      } finally {
        if (previous === undefined) delete process.env.OPENCODE_SANDBOX_OPEN_FILES
        else process.env.OPENCODE_SANDBOX_OPEN_FILES = previous
      }
    },
    10_000,
  )

  integrationTest(
    "terminates a sleeping command at a short wall-clock timeout",
    async () => {
      const fixture = await createFixture()
      const started = performance.now()
      const result = await run(fixture.workspace, "sleep 5", { timeout: 250 })

      expect(result.timedOut).toBe(true)
      expect(result.exitCode).not.toBe(0)
      expect(performance.now() - started).toBeLessThan(3_000)
    },
    10_000,
  )

  integrationTest(
    "keeps Python and Bun child processes inside sandbox policy",
    async () => {
      const fixture = await createFixture()
      const marker = `child-${crypto.randomUUID()}`
      const outerTmp = path.join("/tmp", marker)
      roots.add(outerTmp)
      const command = [
        `python3 -c \"import os; print('python-home=' + os.environ['HOME']); open('/tmp/${marker}', 'w').write('python')\"`,
        `bun -e \"console.log('bun-home=' + process.env.HOME); await Bun.write('/tmp/${marker}', 'bun')\"`,
        "grep -E '^(CapEff|CapBnd):' /proc/self/status",
      ].join(" && ")
      const result = await run(fixture.workspace, command)

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain(`python-home=${fixture.workspace}`)
      expect(result.stdout).toContain(`bun-home=${fixture.workspace}`)
      expect(result.stdout).toContain("CapEff:\t0000000000000000")
      expect(result.stdout).toContain("CapBnd:\t0000000000000000")
      expect(await exists(outerTmp)).toBe(false)
    },
    15_000,
  )

  integrationTest(
    "enforces a small file-size limit without creating a large file",
    async () => {
      const fixture = await createFixture()
      const previous = process.env.OPENCODE_SANDBOX_FILE_SIZE_MB
      process.env.OPENCODE_SANDBOX_FILE_SIZE_MB = "1"
      try {
        const result = await run(
          fixture.workspace,
          "python3 -c \"open('limited.bin', 'wb').write(b'x' * (2 * 1024 * 1024))\"",
        )
        expect(result.exitCode).not.toBe(0)
        expect(result.stderr).toMatch(/File too large|Errno 27/)
        expect((await fs.stat(path.join(fixture.workspace, "limited.bin"))).size).toBeLessThanOrEqual(1024 * 1024)
      } finally {
        if (previous === undefined) delete process.env.OPENCODE_SANDBOX_FILE_SIZE_MB
        else process.env.OPENCODE_SANDBOX_FILE_SIZE_MB = previous
      }
    },
    10_000,
  )
})

async function createFixture() {
  const workspace = await fs.realpath(await fs.mkdtemp(path.join(process.cwd(), ".sandbox-workspace-")))
  const outside = await fs.realpath(await fs.mkdtemp(path.join(process.cwd(), ".sandbox-outside-")))
  roots.add(workspace)
  roots.add(outside)
  return { workspace, outside }
}

async function run(
  workspace: string,
  command: string,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number } = {},
) {
  const cwd = options.cwd ?? workspace
  const env = { ...process.env, ...options.env }
  const locationLayer = Layer.succeed(
    Location.Service,
    Location.Service.of(location(Location.Ref.make({ directory: AbsolutePath.make(workspace) }))),
  )
  const layer = Sandbox.layer.pipe(Layer.provide(locationLayer))
  const prepared = await Effect.runPromise(
    Effect.gen(function* () {
      const sandbox = yield* Sandbox.Service
      return yield* sandbox.prepare({ executable: "/bin/bash", args: ["-lc", command], cwd, env })
    }).pipe(Effect.provide(layer)),
  )
  const child = Bun.spawn([prepared.executable, ...prepared.args], {
    cwd: prepared.cwd,
    env: prepared.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill("SIGKILL")
  }, options.timeout ?? 5_000)
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (process.env.OPENCODE_SANDBOX_TEST_DIAGNOSTICS === "1")
      console.error(
        JSON.stringify({
          command,
          exitCode,
          timedOut,
          stderr: stderr.trim().slice(0, 500),
        }),
      )
    return { exitCode, stdout, stderr, timedOut }
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) child.kill("SIGKILL")
  }
}

async function exists(file: string) {
  return fs
    .access(file)
    .then(() => true)
    .catch(() => false)
}
