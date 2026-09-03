export * as Bwrap from "./bwrap.js"

import path from "path"
import type { PreparedProcess } from "../shell.js"

export function prepare(input: PreparedProcess, workspace: string, executable: string): PreparedProcess {
  const lang = input.env.LANG ?? "C.UTF-8"
  const sandboxPath = [
    path.posix.join(workspace, ".venv/bin"),
    path.posix.join(workspace, "node_modules/.bin"),
    input.env.PATH,
  ]
    .filter((item): item is string => item !== undefined && item.length > 0)
    .join(":")
  const env = Object.fromEntries(
    ["PATH", "LANG"].flatMap((key) => {
      const value = input.env[key]
      return value === undefined ? [] : [[key, value]]
    }),
  )
  const roots = ["/usr", "/usr/local", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/proc"]
  const directories = [...new Set([...roots, ...parents(workspace), workspace])]

  return {
    executable,
    args: [
      "--die-with-parent",
      "--new-session",
      "--unshare-user",
      "--unshare-ipc",
      "--unshare-net",
      "--unshare-uts",
      "--cap-drop",
      "ALL",
      "--tmpfs",
      "/",
      ...directories.flatMap((directory) => ["--dir", directory]),
      ...roots.flatMap((root) => ["--ro-bind-try", root, root]),
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
      workspace,
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

function parents(input: string) {
  const result: string[] = []
  const parsed = path.posix.parse(input)
  const relative = input.slice(parsed.root.length).split("/").filter(Boolean)
  relative.slice(0, -1).reduce((current, segment) => {
    const next = path.posix.join(current, segment)
    result.push(next)
    return next
  }, parsed.root)
  return result
}
