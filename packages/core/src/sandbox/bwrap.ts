export * as SandboxBwrap from "./bwrap.js"

import type { PreparedProcess, Language, Workspace } from "./types.js"

export interface BuildInput {
  readonly language: Language
  readonly workspace: Workspace
  readonly runtime: string
  readonly args?: readonly string[]
  readonly bwrap?: string
  readonly env?: NodeJS.ProcessEnv
}

const runtimeTarget = (language: Language) => (language === "python" ? "/sandbox/bin/python3" : "/sandbox/bin/bun")

export function build(input: BuildInput): PreparedProcess {
  const runtime = runtimeTarget(input.language)
  return {
    executable: input.bwrap ?? "bwrap",
    args: [
      "--die-with-parent",
      "--new-session",
      "--unshare-net",
      "--clearenv",
      "--dir",
      "/sandbox",
      "--dir",
      "/sandbox/bin",
      "--ro-bind",
      input.runtime,
      runtime,
      "--ro-bind",
      input.workspace.project,
      "/workspace",
      "--bind",
      input.workspace.work,
      "/work",
      "--tmpfs",
      "/tmp",
      "--dev",
      "/dev",
      "--setenv",
      "PATH",
      "/sandbox/bin",
      "--setenv",
      "HOME",
      "/work",
      "--setenv",
      "TMPDIR",
      "/tmp",
      "--setenv",
      "LANG",
      "C.UTF-8",
      "--chdir",
      input.workspace.workdir,
      "--",
      runtime,
      input.workspace.script,
      ...(input.args ?? []),
    ],
    cwd: input.workspace.project,
    env: environment(input.env ?? process.env),
  }
}

export function environment(source: NodeJS.ProcessEnv) {
  const find = (name: string) => {
    const key = Object.keys(source).find((item) => item.toUpperCase() === name)
    return key ? source[key] : undefined
  }
  return Object.fromEntries(
    [
      ["PATH", find("PATH")],
      ["HOME", find("HOME")],
      ["TMPDIR", find("TMPDIR")],
      ["LANG", find("LANG") ?? "C.UTF-8"],
    ].filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
}
