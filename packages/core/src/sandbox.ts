export * as Sandbox from "./sandbox.js"

import path from "path"
import { existsSync, realpathSync } from "fs"
import { createHash } from "crypto"
import { Context, Duration, Effect, Layer, Schema, Semaphore } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { AppProcess } from "@opencode-ai/util/process"
import { makeGlobalNode } from "@opencode-ai/util/effect/app-node"
import { Global } from "@opencode-ai/util/global"
import { SessionSchema } from "./session/schema.js"

export type Runtime = "docker" | "podman"

export interface Options {
  readonly enabled?: boolean
  readonly runtime: Runtime
  readonly image: string
  readonly user?: string
  readonly cpu?: number
  readonly memoryMb?: number
  readonly pids?: number
  readonly timeout?: number
  readonly maxOutputBytes?: number
  readonly maxConcurrent?: number
  readonly maxSessionConcurrent?: number
  /** Additional service-wide calls allowed to wait behind running containers. */
  readonly maxPending?: number
  /** Additional calls from one Session allowed to wait behind running containers. */
  readonly maxSessionPending?: number
  readonly tmpfsMb?: number
  readonly maxInputBytes?: number
  readonly maxArgs?: number
  readonly maxArgBytes?: number
  /** Per-file RLIMIT_FSIZE applied inside the container. */
  readonly maxFileBytes?: number
  /** Administrator-controlled roots from which project directories may be mounted. */
  readonly workspaceRoots?: ReadonlyArray<string>
  /** Additional host paths that must never overlap a mounted project. */
  readonly protectedPaths?: ReadonlyArray<string>
}

export interface RunInput {
  readonly sessionID: SessionSchema.ID
  readonly profile: "shell" | "script"
  readonly projectDirectory: string
  readonly cwd?: string
  readonly command: string
  readonly args?: ReadonlyArray<string>
  readonly stdin?: string | Uint8Array
  /** Per-call timeout in milliseconds, capped by the service timeout. */
  readonly timeout?: number
}

export interface Result {
  readonly exitCode: number
  readonly output: string
  readonly truncated: boolean
}

export class InvalidInputError extends Schema.TaggedError<InvalidInputError>()("Sandbox.InvalidInputError", {
  message: Schema.String,
}) {}

export class InvalidWorkingDirectoryError extends Schema.TaggedError<InvalidWorkingDirectoryError>()(
  "Sandbox.InvalidWorkingDirectoryError",
  {
    projectDirectory: Schema.String,
    cwd: Schema.String,
  },
) {
  override get message() {
    return `Sandbox working directory must be inside the project: ${this.cwd}`
  }
}

export class UnavailableError extends Schema.TaggedError<UnavailableError>()("Sandbox.UnavailableError", {
  runtime: Schema.Literals(["docker", "podman"]),
  detail: Schema.String,
}) {
  override get message() {
    return `${this.runtime} is unavailable: ${this.detail}`
  }
}

export class ExecutionError extends Schema.TaggedError<ExecutionError>()("Sandbox.ExecutionError", {
  runtime: Schema.Literals(["docker", "podman"]),
  detail: Schema.String,
}) {
  override get message() {
    return `${this.runtime} could not run the sandbox: ${this.detail}`
  }
}

export class TimeoutError extends Schema.TaggedError<TimeoutError>()("Sandbox.TimeoutError", {
  timeout: Schema.Number,
}) {
  override get message() {
    return `Sandbox execution exceeded ${this.timeout}ms`
  }
}

export class DisabledError extends Schema.TaggedError<DisabledError>()("Sandbox.DisabledError", {}) {
  override get message() {
    return "Sandbox execution is disabled"
  }
}

export class BusyError extends Schema.TaggedError<BusyError>()("Sandbox.BusyError", {
  sessionID: Schema.String,
  limit: Schema.Number,
}) {
  override get message() {
    return `Sandbox Session ${this.sessionID} already has ${this.limit} running or pending calls`
  }
}

export class CapacityError extends Schema.TaggedError<CapacityError>()("Sandbox.CapacityError", {
  limit: Schema.Number,
}) {
  override get message() {
    return `Sandbox service already has ${this.limit} running or pending calls`
  }
}

export type Error =
  | DisabledError
  | InvalidInputError
  | InvalidWorkingDirectoryError
  | UnavailableError
  | ExecutionError
  | TimeoutError
  | BusyError
  | CapacityError

export interface Interface {
  readonly enabled: boolean
  readonly run: (input: RunInput) => Effect.Effect<Result, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Sandbox") {}

type Settings = {
  readonly enabled: boolean
  readonly runtime: Runtime
  readonly image: string
  readonly user: string
  readonly cpu: number
  readonly memoryMb: number
  readonly pids: number
  readonly timeout: number
  readonly maxOutputBytes: number
  readonly maxConcurrent: number
  readonly maxSessionConcurrent: number
  readonly maxPending: number
  readonly maxSessionPending: number
  readonly tmpfsMb: number
  readonly maxInputBytes: number
  readonly maxArgs: number
  readonly maxArgBytes: number
  readonly maxFileBytes: number
  readonly workspaceRoots: ReadonlyArray<string> | undefined
  readonly protectedPaths: ReadonlyArray<string>
}

type Runner = Pick<AppProcess.Interface, "run">

const DEFAULT_CPU = 1
const DEFAULT_MEMORY_MB = 1024
const DEFAULT_PIDS = 64
const DEFAULT_TIMEOUT = 120_000
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024
const DEFAULT_MAX_CONCURRENT = 4
const DEFAULT_MAX_SESSION_CONCURRENT = 1
const DEFAULT_MAX_PENDING = 16
const DEFAULT_MAX_SESSION_PENDING = 4
const DEFAULT_TMPFS_MB = 64
const DEFAULT_MAX_INPUT_BYTES = 1024 * 1024
const DEFAULT_MAX_ARGS = 128
const DEFAULT_MAX_ARG_BYTES = 64 * 1024
const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024
const RUNTIME_CHECK_TIMEOUT = Duration.seconds(5)
const CLEANUP_TIMEOUT = Duration.seconds(5)
const FORCE_KILL_AFTER = Duration.seconds(3)
const INSTANCE_ID = crypto.randomUUID()

export const make = (options: Options, processes: Runner): Interface => {
  const settings = resolveOptions(options)
  const global = Semaphore.makeUnsafe(settings.maxConcurrent)
  const runtimeCheck = Semaphore.makeUnsafe(1)
  const sessions = new Map<string, { readonly semaphore: Semaphore.Semaphore; users: number }>()
  let users = 0
  let runtimeReady = false

  const run = Effect.fn("Sandbox.run")(function* (input: RunInput) {
    if (!settings.enabled) return yield* new DisabledError()
    const timeout = input.timeout ?? settings.timeout
    if (!Number.isFinite(timeout) || timeout <= 0)
      return yield* new InvalidInputError({ message: "Sandbox timeout must be a positive number" })
    const deadline = Math.min(timeout, settings.timeout)
    const name = `opencode-sandbox-${crypto.randomUUID()}`

    const execute = Effect.gen(function* () {
      // Admission happens before canonical filesystem inspection and argv construction,
      // so malformed or slow-path requests cannot bypass the bounded queue.
      const args = yield* Effect.try({
        try: () => buildDockerArgs(input, settings, name),
        catch: (cause) =>
          cause instanceof InvalidWorkingDirectoryError || cause instanceof InvalidInputError
            ? cause
            : new InvalidInputError({ message: cause instanceof Error ? cause.message : String(cause) }),
      })
      yield* runtimeCheck.withPermit(
        Effect.suspend(() => {
          if (runtimeReady) return Effect.void
          return processes
            .run(
              ChildProcess.make(settings.runtime, ["info"], {
                extendEnv: true,
                stdin: "ignore",
                forceKillAfter: FORCE_KILL_AFTER,
              }),
              {
                combineOutput: true,
                maxOutputBytes: 4096,
                timeout: RUNTIME_CHECK_TIMEOUT,
              },
            )
            .pipe(
              Effect.mapError(
                (error) =>
                  new UnavailableError({
                    runtime: settings.runtime,
                    detail: error.message,
                  }),
              ),
              Effect.flatMap((check) => {
                if (check.exitCode === 0)
                  return Effect.sync(() => {
                    runtimeReady = true
                  })
                return Effect.fail(
                  new UnavailableError({
                    runtime: settings.runtime,
                    detail: check.output?.toString("utf8").trim() || `info exited with code ${check.exitCode}`,
                  }),
                )
              }),
            )
        }),
      )

      const cleanup = processes
        .run(
          ChildProcess.make(settings.runtime, ["rm", "--force", name], {
            extendEnv: true,
            stdin: "ignore",
            forceKillAfter: FORCE_KILL_AFTER,
          }),
          {
            combineOutput: true,
            maxOutputBytes: 4096,
            timeout: CLEANUP_TIMEOUT,
          },
        )
        .pipe(
          Effect.flatMap((result) => {
            const output = result.output?.toString("utf8").trim() ?? ""
            if (result.exitCode === 0 || /no such container|does not exist/i.test(output)) return Effect.void
            return Effect.logWarning("failed to remove sandbox container", {
              containerName: name,
              exitCode: result.exitCode,
              output,
            })
          }),
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to remove sandbox container", { containerName: name, cause }),
          ),
        )
      const result = yield* processes
        .run(
          ChildProcess.make(settings.runtime, args, {
            extendEnv: true,
            stdin: "ignore",
            forceKillAfter: FORCE_KILL_AFTER,
          }),
          {
            combineOutput: true,
            maxOutputBytes: settings.maxOutputBytes,
            stdin: input.stdin,
          },
        )
        .pipe(
          Effect.mapError(
            (error) =>
              new ExecutionError({
                runtime: settings.runtime,
                detail: error.message,
              }),
          ),
          Effect.ensuring(cleanup),
        )
      const output = result.output?.toString("utf8") ?? ""
      if (result.exitCode === 124) return yield* new TimeoutError({ timeout: deadline })
      if (result.exitCode === 125)
        return yield* new ExecutionError({
          runtime: settings.runtime,
          detail: output.trim() || `${settings.runtime} exited with code 125`,
        })
      return {
        exitCode: result.exitCode,
        output,
        truncated: result.outputTruncated === true,
      }
    })

    return yield* withAdmission(input.sessionID, sessions, global, settings, {
      get: () => users,
      increment: () => users++,
      decrement: () => users--,
    })(execute).pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(deadline),
        orElse: () => Effect.fail(new TimeoutError({ timeout: deadline })),
      }),
    )
  })

  return Service.of({ enabled: settings.enabled, run })
}

export const layer = (options: Options) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const processes = yield* AppProcess.Service
      const global = yield* Global.Service
      return make(
        {
          ...options,
          protectedPaths: [...(options.protectedPaths ?? []), global.data, global.cache, global.config, global.state],
        },
        processes,
      )
    }),
  )

export const node = makeGlobalNode({
  service: Service,
  layer: layer(environmentOptions()),
  deps: [AppProcess.node, Global.node],
})

/** Builds the exact argv passed to `docker run` or `podman run`. */
export const dockerArgs = (input: RunInput, options: Options, containerName: string): ReadonlyArray<string> =>
  buildDockerArgs(input, resolveOptions(options), containerName)

function buildDockerArgs(input: RunInput, settings: Settings, containerName: string) {
  validateInput(input, settings)
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(containerName))
    throw new InvalidInputError({ message: "Sandbox container name is invalid" })
  validatePath(input.projectDirectory)
  if (input.cwd !== undefined) validatePath(input.cwd)

  const projectDirectory = canonicalPath(input.projectDirectory)
  validatePath(projectDirectory)
  if (samePath(projectDirectory, path.parse(projectDirectory).root))
    throw new InvalidInputError({ message: "Sandbox project directory must not be a filesystem root" })
  if (settings.workspaceRoots && !settings.workspaceRoots.some((root) => containsPath(root, projectDirectory)))
    throw new InvalidInputError({ message: "Sandbox project directory is outside the configured workspace roots" })
  if (
    settings.protectedPaths.some((root) => containsPath(root, projectDirectory) || containsPath(projectDirectory, root))
  )
    throw new InvalidInputError({ message: "Sandbox project directory overlaps protected OpenCode service data" })

  const cwd = canonicalPath(path.resolve(projectDirectory, input.cwd ?? projectDirectory))
  validatePath(cwd)
  const relative = path.relative(projectDirectory, cwd)
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new InvalidWorkingDirectoryError({ projectDirectory, cwd })

  return [
    "run",
    "--rm",
    "--name",
    containerName,
    "--init",
    "--label",
    "ai.opencode.sandbox=true",
    "--label",
    `ai.opencode.session=${sessionLabel(input.sessionID)}`,
    "--label",
    `ai.opencode.profile=${input.profile}`,
    "--label",
    `ai.opencode.instance=${INSTANCE_ID}`,
    "--pull=never",
    "--log-driver=none",
    "--network=none",
    "--ipc=none",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges=true",
    "--user",
    settings.user,
    "--cpus",
    String(settings.cpu),
    "--memory",
    `${settings.memoryMb}m`,
    "--memory-swap",
    `${settings.memoryMb}m`,
    "--pids-limit",
    String(settings.pids),
    "--ulimit",
    "nofile=256:256",
    "--ulimit",
    "core=0:0",
    "--ulimit",
    `fsize=${settings.maxFileBytes}:${settings.maxFileBytes}`,
    "--tmpfs",
    `/tmp:rw,nosuid,nodev,noexec,size=${settings.tmpfsMb}m`,
    "--mount",
    `type=bind,source=${projectDirectory},target=/workspace`,
    "--workdir",
    relative ? `/workspace/${relative.split(path.sep).join("/")}` : "/workspace",
    "--env",
    "HOME=/tmp",
    "--env",
    "TMPDIR=/tmp",
    "--env",
    "PATH=/opt/opencode/bin:/usr/local/bin:/usr/bin:/bin",
    ...[
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
    ].flatMap((name) => ["--env", `${name}=`]),
    ...(input.stdin === undefined ? [] : ["--interactive"]),
    "--entrypoint",
    "/usr/bin/timeout",
    settings.image,
    "--signal=TERM",
    "--kill-after=3s",
    `${Math.max(1, Math.floor(Math.min(positive(input.timeout ?? settings.timeout, "timeout"), settings.timeout) * 0.9)) / 1000}s`,
    input.command,
    ...(input.args ?? []),
  ]
}

function resolveOptions(options: Options): Settings {
  if (options.runtime !== "docker" && options.runtime !== "podman")
    throw new RangeError("Sandbox runtime must be docker or podman")
  validateImage(options.image)
  const user = options.user ?? defaultUser()
  validateUser(user)
  const workspaceRoots = options.workspaceRoots?.map((root) => {
    if (!root || [",", "\0", "\r", "\n"].some((character) => root.includes(character)))
      throw new RangeError("Sandbox workspace roots must be non-empty paths without commas or control characters")
    const canonical = canonicalPath(root)
    if (samePath(canonical, path.parse(canonical).root))
      throw new RangeError("Sandbox workspace roots must not include a filesystem root")
    return canonical
  })
  if (workspaceRoots?.length === 0) throw new RangeError("Sandbox workspaceRoots must not be empty")
  const protectedPaths = (options.protectedPaths ?? []).map((root) => {
    if (!root || [",", "\0", "\r", "\n"].some((character) => root.includes(character)))
      throw new RangeError("Sandbox protected paths must be non-empty paths without commas or control characters")
    return canonicalPath(root)
  })
  const maxConcurrent = positiveInteger(options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT, "maxConcurrent")
  const maxSessionConcurrent = positiveInteger(
    options.maxSessionConcurrent ?? DEFAULT_MAX_SESSION_CONCURRENT,
    "maxSessionConcurrent",
  )
  const maxPending = nonNegativeInteger(options.maxPending ?? DEFAULT_MAX_PENDING, "maxPending")
  const maxSessionPending = nonNegativeInteger(
    options.maxSessionPending ?? DEFAULT_MAX_SESSION_PENDING,
    "maxSessionPending",
  )
  if (!Number.isSafeInteger(maxConcurrent + maxPending))
    throw new RangeError("Sandbox service running and pending capacity is too large")
  if (!Number.isSafeInteger(maxSessionConcurrent + maxSessionPending))
    throw new RangeError("Sandbox Session running and pending capacity is too large")
  return {
    enabled: options.enabled ?? true,
    runtime: options.runtime,
    image: options.image,
    user,
    cpu: positive(options.cpu ?? DEFAULT_CPU, "cpu"),
    memoryMb: positiveInteger(options.memoryMb ?? DEFAULT_MEMORY_MB, "memoryMb"),
    pids: positiveInteger(options.pids ?? DEFAULT_PIDS, "pids"),
    timeout: positive(options.timeout ?? DEFAULT_TIMEOUT, "timeout"),
    maxOutputBytes: positiveInteger(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES, "maxOutputBytes"),
    maxConcurrent,
    maxSessionConcurrent,
    maxPending,
    maxSessionPending,
    tmpfsMb: positiveInteger(options.tmpfsMb ?? DEFAULT_TMPFS_MB, "tmpfsMb"),
    maxInputBytes: positiveInteger(options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES, "maxInputBytes"),
    maxArgs: nonNegativeInteger(options.maxArgs ?? DEFAULT_MAX_ARGS, "maxArgs"),
    maxArgBytes: positiveInteger(options.maxArgBytes ?? DEFAULT_MAX_ARG_BYTES, "maxArgBytes"),
    maxFileBytes: positiveInteger(options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES, "maxFileBytes"),
    workspaceRoots,
    protectedPaths,
  }
}

function positive(value: number, name: string) {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`Sandbox ${name} must be a positive number`)
  return value
}

function positiveInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`Sandbox ${name} must be a positive integer`)
  return value
}

function nonNegativeInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`Sandbox ${name} must be a non-negative integer`)
  return value
}

function defaultUser() {
  const uid = process.getuid?.()
  const gid = process.getgid?.()
  if (uid && uid > 0) return `${uid}:${gid && gid > 0 ? gid : uid}`
  return "65532:65532"
}

function validateInput(input: RunInput, settings: Settings) {
  if (input.profile !== "shell" && input.profile !== "script")
    throw new InvalidInputError({ message: "Sandbox profile must be shell or script" })
  if (
    typeof input.sessionID !== "string" ||
    input.sessionID.length === 0 ||
    input.sessionID.length > 512 ||
    /[\0\r\n]/.test(input.sessionID)
  )
    throw new InvalidInputError({ message: "Sandbox Session ID is invalid" })
  if (typeof input.projectDirectory !== "string" || !input.projectDirectory)
    throw new InvalidInputError({ message: "Sandbox project directory must not be empty" })
  if (input.cwd !== undefined && typeof input.cwd !== "string")
    throw new InvalidInputError({ message: "Sandbox working directory must be a string" })
  if (Buffer.byteLength(input.projectDirectory) > settings.maxArgBytes)
    throw new InvalidInputError({
      message: `Sandbox project directory exceeds the ${settings.maxArgBytes} byte limit`,
    })
  if (input.cwd !== undefined && Buffer.byteLength(input.cwd) > settings.maxArgBytes)
    throw new InvalidInputError({
      message: `Sandbox working directory exceeds the ${settings.maxArgBytes} byte limit`,
    })
  if (typeof input.command !== "string" || !input.command.trim())
    throw new InvalidInputError({ message: "Sandbox command must not be empty" })
  if (input.command.includes("\0")) throw new InvalidInputError({ message: "Sandbox command must not contain NUL" })
  if (!Array.isArray(input.args)) {
    if (input.args !== undefined) throw new InvalidInputError({ message: "Sandbox args must be an array" })
  } else {
    if (input.args.length > settings.maxArgs)
      throw new InvalidInputError({ message: `Sandbox args exceed the ${settings.maxArgs} argument limit` })
    if (input.args.some((argument) => typeof argument !== "string"))
      throw new InvalidInputError({ message: "Sandbox args must be strings" })
    if (input.args.some((argument) => argument.includes("\0")))
      throw new InvalidInputError({ message: "Sandbox args must not contain NUL" })
    if (input.args.some((argument) => Buffer.byteLength(argument) > settings.maxArgBytes))
      throw new InvalidInputError({ message: `Sandbox argument exceeds the ${settings.maxArgBytes} byte limit` })
  }
  if (Buffer.byteLength(input.command) > settings.maxArgBytes)
    throw new InvalidInputError({ message: `Sandbox command exceeds the ${settings.maxArgBytes} byte limit` })
  if (input.stdin !== undefined && typeof input.stdin !== "string" && !(input.stdin instanceof Uint8Array))
    throw new InvalidInputError({ message: "Sandbox stdin must be a string or byte array" })
  const inputBytes =
    Buffer.byteLength(input.sessionID) +
    Buffer.byteLength(input.projectDirectory) +
    (input.cwd === undefined ? 0 : Buffer.byteLength(input.cwd)) +
    Buffer.byteLength(input.command) +
    (input.args ?? []).reduce((total, argument) => total + Buffer.byteLength(argument), 0) +
    (typeof input.stdin === "string" ? Buffer.byteLength(input.stdin) : (input.stdin?.byteLength ?? 0))
  if (inputBytes > settings.maxInputBytes)
    throw new InvalidInputError({ message: `Sandbox input exceeds the ${settings.maxInputBytes} byte limit` })
}

function validateImage(image: string) {
  if (
    typeof image !== "string" ||
    image.length === 0 ||
    image.length > 512 ||
    image.trim() !== image ||
    !/^[a-z0-9][A-Za-z0-9._:/@-]*$/.test(image)
  )
    throw new RangeError("Sandbox image must be a valid image reference and must not begin with a dash")
  const parts = image.split("@")
  if (parts.length > 2 || (parts[1] !== undefined && !/^sha256:[a-f0-9]{64}$/.test(parts[1])))
    throw new RangeError("Sandbox image digest must be a canonical sha256 digest")
  const reference = parts[0]
  const slash = reference.lastIndexOf("/")
  const colon = reference.lastIndexOf(":")
  const name = colon > slash ? reference.slice(0, colon) : reference
  const tag = colon > slash ? reference.slice(colon + 1) : undefined
  if (tag !== undefined && !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag))
    throw new RangeError("Sandbox image tag is invalid")
  const components = name.split("/")
  const registry = components[0]?.includes(".") || components[0]?.includes(":") || components[0] === "localhost"
  const repositories = registry ? components.slice(1) : components
  if (
    repositories.length === 0 ||
    repositories.some((component) => !/^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/.test(component))
  )
    throw new RangeError("Sandbox image repository is invalid")
  if (!registry) return
  const match = /^([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|localhost)(?::([1-9]\d{0,4}))?$/.exec(components[0] ?? "")
  if (!match || match[1].includes("..") || (match[2] !== undefined && Number(match[2]) > 65_535))
    throw new RangeError("Sandbox image registry is invalid")
}

function validateUser(user: string) {
  const match = /^([1-9]\d*):([1-9]\d*)$/.exec(user)
  if (!match) throw new RangeError("Sandbox user must be a numeric, non-root UID:GID without leading zeroes")
  if (Number(match[1]) > 2_147_483_647 || Number(match[2]) > 2_147_483_647)
    throw new RangeError("Sandbox UID and GID must not exceed 2147483647")
}

function validatePath(input: string) {
  if (![",", "\0", "\r", "\n"].some((character) => input.includes(character))) return
  throw new InvalidInputError({
    message: "Sandbox paths must not contain commas, NUL, carriage returns, or newlines",
  })
}

function canonicalPath(input: string) {
  const suffix: string[] = []
  const resolved = path.resolve(input)
  let existing = resolved
  while (!existsSync(existing)) {
    const parent = path.dirname(existing)
    if (parent === existing) return resolved
    suffix.unshift(path.basename(existing))
    existing = parent
  }
  return path.resolve(realpathSync.native(existing), ...suffix)
}

function samePath(first: string, second: string) {
  return process.platform === "win32" ? first.toLowerCase() === second.toLowerCase() : first === second
}

function containsPath(root: string, candidate: string) {
  const relative = path.relative(root, candidate)
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function sessionLabel(sessionID: string) {
  return createHash("sha256").update(sessionID).digest("hex").slice(0, 24)
}

function environmentOptions(): Options {
  const runtime = process.env.OPENCODE_SANDBOX_RUNTIME ?? "docker"
  if (runtime !== "docker" && runtime !== "podman")
    throw new RangeError("OPENCODE_SANDBOX_RUNTIME must be docker or podman")
  return {
    enabled: environmentBoolean("OPENCODE_SANDBOX_ENABLED") ?? true,
    runtime,
    image: process.env.OPENCODE_SANDBOX_IMAGE ?? "opencode-sandbox:latest",
    user: process.env.OPENCODE_SANDBOX_USER,
    cpu: environmentNumber("OPENCODE_SANDBOX_CPU"),
    memoryMb: environmentNumber("OPENCODE_SANDBOX_MEMORY_MB"),
    pids: environmentNumber("OPENCODE_SANDBOX_PIDS"),
    timeout: environmentNumber("OPENCODE_SANDBOX_TIMEOUT_MS"),
    maxOutputBytes: environmentNumber("OPENCODE_SANDBOX_MAX_OUTPUT_BYTES"),
    maxConcurrent: environmentNumber("OPENCODE_SANDBOX_MAX_CONCURRENT"),
    maxSessionConcurrent: environmentNumber("OPENCODE_SANDBOX_MAX_SESSION_CONCURRENT"),
    maxPending: environmentNumber("OPENCODE_SANDBOX_MAX_PENDING"),
    maxSessionPending: environmentNumber("OPENCODE_SANDBOX_MAX_SESSION_PENDING"),
    tmpfsMb: environmentNumber("OPENCODE_SANDBOX_TMPFS_MB"),
    maxInputBytes: environmentNumber("OPENCODE_SANDBOX_MAX_INPUT_BYTES"),
    maxArgs: environmentNumber("OPENCODE_SANDBOX_MAX_ARGS"),
    maxArgBytes: environmentNumber("OPENCODE_SANDBOX_MAX_ARG_BYTES"),
    maxFileBytes: environmentNumber("OPENCODE_SANDBOX_MAX_FILE_BYTES"),
    workspaceRoots: environmentWorkspaceRoots(),
  }
}

function environmentBoolean(name: string) {
  const value = process.env[name]
  if (value === undefined) return undefined
  if (value === "true") return true
  if (value === "false") return false
  throw new RangeError(`${name} must be true or false`)
}

function environmentNumber(name: string) {
  const value = process.env[name]
  if (value === undefined) return undefined
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) throw new RangeError(`${name} must be an unpadded decimal number`)
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new RangeError(`${name} must be a finite number`)
  return parsed
}

function environmentWorkspaceRoots() {
  const value = process.env.OPENCODE_SANDBOX_WORKSPACE_ROOTS
  if (value === undefined) return undefined
  if (!value) throw new RangeError("OPENCODE_SANDBOX_WORKSPACE_ROOTS must not be empty")
  const roots = value.split(path.delimiter)
  if (roots.some((root) => !root))
    throw new RangeError("OPENCODE_SANDBOX_WORKSPACE_ROOTS must not contain empty entries")
  return roots
}

function withAdmission(
  sessionID: string,
  sessions: Map<string, { readonly semaphore: Semaphore.Semaphore; users: number }>,
  global: Semaphore.Semaphore,
  settings: Settings,
  globalUsers: { readonly get: () => number; readonly increment: () => void; readonly decrement: () => void },
) {
  return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.suspend<A, E | BusyError | CapacityError, R>(() => {
      const current = sessions.get(sessionID)
      const entry = current ?? { semaphore: Semaphore.makeUnsafe(settings.maxSessionConcurrent), users: 0 }
      const sessionLimit = settings.maxSessionConcurrent + settings.maxSessionPending
      if (entry.users >= sessionLimit) return Effect.fail(new BusyError({ sessionID, limit: sessionLimit }))
      const globalLimit = settings.maxConcurrent + settings.maxPending
      if (globalUsers.get() >= globalLimit) return Effect.fail(new CapacityError({ limit: globalLimit }))
      if (!current) sessions.set(sessionID, entry)
      entry.users++
      globalUsers.increment()
      return entry.semaphore.withPermit(global.withPermit(effect)).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            entry.users--
            globalUsers.decrement()
            if (entry.users === 0) sessions.delete(sessionID)
          }),
        ),
      )
    })
}
