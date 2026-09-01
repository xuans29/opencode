export * as Prlimit from "./prlimit.js"

import type { PreparedProcess } from "../shell.js"

export interface Limits {
  readonly cpuSeconds: number
  readonly memoryBytes: number
  readonly fileSizeBytes: number
  readonly openFiles: number
}

export function prepare(input: PreparedProcess, executable: string, limits: Limits): PreparedProcess {
  return {
    executable,
    args: [
      `--cpu=${limits.cpuSeconds}`,
      `--as=${limits.memoryBytes}`,
      `--fsize=${limits.fileSizeBytes}`,
      `--nofile=${limits.openFiles}`,
      "--",
      input.executable,
      ...input.args,
    ],
    cwd: input.cwd,
    env: input.env,
  }
}
