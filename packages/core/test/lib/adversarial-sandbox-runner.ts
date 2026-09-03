import { Effect, Layer } from "effect"
import { Location } from "@opencode-ai/core/location"
import { Sandbox } from "@opencode-ai/core/sandbox/service"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { location } from "../fixture/location"

export async function runSandbox(
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
    detached: true,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    killProcessGroup(child)
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
    if (child.exitCode === null) killProcessGroup(child)
  }
}

function killProcessGroup(child: Bun.Subprocess) {
  try {
    process.kill(-child.pid, "SIGKILL")
  } catch {
    child.kill("SIGKILL")
  }
}
