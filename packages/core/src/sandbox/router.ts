export * as SandboxRouter from "./router.js"

import path from "node:path"
import { ShellScan } from "../shell/scan.js"
import type { Language } from "./types.js"

export interface Route {
  readonly language: Language
  readonly script: string
  readonly args: readonly string[]
}

export function route(command: string): Route | undefined {
  const scanned = ShellScan.scan(command)
  if (scanned.kind === "opaque" || scanned.commands.length !== 1) return undefined
  return words(scanned.commands[0]?.words ?? [])
}

function words(input: readonly string[]): Route | undefined {
  const executable = name(input[0])
  if (executable === "env") {
    const command = input.slice(1).findIndex((item) => item === "--" || (!item.startsWith("-") && !assignment(item)))
    if (command < 0) return undefined
    const offset = input[command + 1] === "--" ? command + 2 : command + 1
    return words(input.slice(offset))
  }
  if ((executable === "bash" || executable === "sh") && input[1] === "-c" && input.length === 3)
    return route(input[2] ?? "")

  const language = languageFor(executable)
  const script = input[1]
  if (!language || !script || script.startsWith("-")) return undefined
  return { language, script, args: input.slice(2) }
}

function name(value?: string) {
  return value
    ? path
        .basename(value)
        .toLowerCase()
        .replace(/\.exe$/, "")
    : ""
}

function languageFor(executable: string): Language | undefined {
  if (executable === "python" || executable === "python3") return "python"
  if (executable === "bun" || executable === "node") return "typescript"
  return undefined
}

function assignment(value: string) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(value)
}
