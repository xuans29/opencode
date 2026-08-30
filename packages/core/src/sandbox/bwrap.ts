export * as SandboxBwrap from "./bwrap.js"

import path from "path"
import type { ShellCreateBefore } from "@opencode-ai/plugin/effect/shell"
import { ShellSelect } from "../shell/select.js"
import type { Shell } from "../shell.js"

export interface BuildInput {
  readonly executable: string
  readonly workspace: string
  readonly invocation: ShellCreateBefore
}

export function build(input: BuildInput): Shell.PreparedProcess {
  const sourcePath = input.invocation.env.PATH ?? input.invocation.env.Path
  const shellArgs = ShellSelect.args(input.invocation.shell, input.invocation.command)
  const env = [
    [
      "PATH",
      [
        path.posix.join(input.workspace, ".venv/bin"),
        path.posix.join(input.workspace, "node_modules/.bin"),
        sourcePath ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      ].join(":"),
    ],
    ["HOME", input.invocation.env.HOME],
    ["LANG", input.invocation.env.LANG ?? "C.UTF-8"],
    ["TMPDIR", "/tmp"],
    ["TERM", input.invocation.env.TERM ?? "xterm-256color"],
    ["OPENCODE_TERMINAL", "1"],
  ].filter((entry): entry is [string, string] => entry[1] !== undefined)

  return {
    executable: input.executable,
    args: [
      "--die-with-parent",
      "--new-session",
      "--unshare-user",
      "--disable-userns",
      "--unshare-ipc",
      "--unshare-net",
      "--unshare-uts",
      "--cap-drop",
      "ALL",
      "--ro-bind",
      "/",
      "/",
      "--dev",
      "/dev",
      "--tmpfs",
      "/tmp",
      "--bind",
      input.workspace,
      input.workspace,
      "--chdir",
      input.invocation.cwd,
      "--clearenv",
      ...env.flatMap(([name, value]) => ["--setenv", name, value]),
      "--",
      input.invocation.shell,
      ...shellArgs,
    ],
    cwd: input.invocation.cwd,
    env: environment(input.invocation.env),
  }
}

function environment(source: NodeJS.ProcessEnv) {
  const find = (name: string) => {
    const key = Object.keys(source).find((item) => item.toUpperCase() === name)
    return key ? source[key] : undefined
  }
  return Object.fromEntries(
    [
      ["PATH", find("PATH")],
      ["HOME", find("HOME")],
      ["LANG", find("LANG") ?? "C.UTF-8"],
      ["TMPDIR", find("TMPDIR")],
    ].filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
}
