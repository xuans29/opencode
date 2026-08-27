export * as SandboxTypes from "./types.js"

import { Schema } from "effect"

export const Language = Schema.Literals(["python", "typescript"])
export type Language = typeof Language.Type

export interface PreparedProcess {
  readonly executable: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
}

export interface Workspace {
  readonly project: string
  readonly work: string
  readonly script: string
  readonly workdir: string
}

export class Error extends Schema.TaggedError<Error>()("Sandbox.Error", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}
