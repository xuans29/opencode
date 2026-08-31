export * as Bwrap from "./bwrap.js"

import path from "path"
import type { PreparedProcess } from "../shell.js"

export interface Input extends PreparedProcess {
  readonly bwrap: string
  readonly workspace: string
}

export function prepare(input: Input): PreparedProcess {
  const environment = {
    PATH: [
      path.posix.join(input.workspace, ".venv/bin"),
      path.posix.join(input.workspace, "node_modules/.bin"),
      input.env.PATH,
    ]
      .filter((value): value is string => value !== undefined && value.length > 0)
      .join(":"),
    HOME: input.env.HOME ?? "",
    LANG: input.env.LANG ?? "C.UTF-8",
    TMPDIR: "/tmp",
    TERM: input.env.TERM ?? "xterm-256color",
    OPENCODE_TERMINAL: "1",
  }
  const outer = Object.fromEntries(
    ["PATH", "HOME", "LANG", "TMPDIR"].flatMap((key) => {
      const value = input.env[key]
      return value === undefined ? [] : [[key, value]]
    }),
  )

  return {
    executable: input.bwrap,
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
      input.cwd,
      "--clearenv",
      ...Object.entries(environment).flatMap(([key, value]) => ["--setenv", key, value]),
      "--",
      input.executable,
      ...input.args,
    ],
    cwd: input.cwd,
    env: outer,
  }
}
