export * as Bwrap from "./bwrap.js"

import path from "path"
import type { PreparedProcess } from "../shell.js"

export function prepare(input: PreparedProcess, workspace: string, executable: string): PreparedProcess {
  const lang = input.env.LANG ?? "C.UTF-8"
  const home = input.env.HOME ?? ""
  const sandboxPath = [
    path.posix.join(workspace, ".venv/bin"),
    path.posix.join(workspace, "node_modules/.bin"),
    input.env.PATH,
  ]
    .filter((item): item is string => item !== undefined && item.length > 0)
    .join(":")
  const env = Object.fromEntries(
    ["PATH", "HOME", "LANG", "TMPDIR"].flatMap((key) => {
      const value = input.env[key]
      return value === undefined ? [] : [[key, value]]
    }),
  )

  return {
    executable,
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
      workspace,
      workspace,
      "--chdir",
      input.cwd,
      "--clearenv",
      "--setenv",
      "PATH",
      sandboxPath,
      "--setenv",
      "HOME",
      home,
      "--setenv",
      "LANG",
      lang,
      "--setenv",
      "TMPDIR",
      "/tmp",
      "--setenv",
      "TERM",
      input.env.TERM ?? "xterm-256color",
      "--setenv",
      "OPENCODE_TERMINAL",
      "1",
      "--",
      input.executable,
      ...input.args,
    ],
    cwd: input.cwd,
    env,
  }
}
