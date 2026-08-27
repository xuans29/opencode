export * as SandboxWorkspace from "./workspace.js"

import fs from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { Error, type Workspace } from "./types.js"

export interface PrepareInput {
  readonly project: string
  readonly workRoot: string
  readonly sessionID: string
  readonly script: string
  readonly workdir?: string
}

export const prepare = Effect.fn("SandboxWorkspace.prepare")(function* (input: PrepareInput) {
  if (!/^[A-Za-z0-9._-]+$/.test(input.sessionID))
    return yield* new Error({ message: `Invalid sandbox session ID: ${input.sessionID}` })

  const project = yield* realpath(input.project, "project")
  const workdir = yield* realpath(path.resolve(project, input.workdir ?? "."), "working directory")
  const script = yield* realpath(path.resolve(workdir, input.script), "script")
  if (!contains(project, workdir))
    return yield* new Error({ message: `Sandbox working directory is outside the project: ${input.workdir}` })
  if (!contains(project, script))
    return yield* new Error({ message: `Sandbox script is outside the project: ${input.script}` })

  const work = path.join(path.resolve(input.workRoot), input.sessionID, "work")
  yield* Effect.tryPromise({
    try: () => fs.mkdir(work, { recursive: true }),
    catch: (cause) => new Error({ message: `Unable to create sandbox work directory: ${work}`, cause }),
  })

  return {
    project,
    work,
    script: sandboxPath(project, script),
    workdir: sandboxPath(project, workdir),
  } satisfies Workspace
})

const realpath = Effect.fnUntraced(function* (value: string, label: string) {
  return yield* Effect.tryPromise({
    try: () => fs.realpath(value),
    catch: (cause) => new Error({ message: `Sandbox ${label} does not exist: ${value}`, cause }),
  })
})

function contains(root: string, target: string) {
  const relative = path.relative(root, target)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

function sandboxPath(project: string, target: string) {
  const relative = path.relative(project, target).split(path.sep).filter(Boolean)
  return path.posix.join("/workspace", ...relative)
}
