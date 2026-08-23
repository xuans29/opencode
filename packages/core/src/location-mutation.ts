export * as LocationMutation from "./location-mutation.js"

import { makeLocationNode } from "@opencode-ai/util/effect/app-node"
import path from "path"
import { Context, Effect, Layer, Schema } from "effect"
import { FSUtil } from "@opencode-ai/util/fs-util"
import { Location } from "./location.js"
import { Project } from "./project.js"
import { AbsolutePath } from "./schema.js"

export const Kind = Schema.Literals(["file", "directory"])
export type Kind = typeof Kind.Type

/**
 * Mutation paths do not accept project references. Relative paths resolve
 * from the active Location. Paths outside it require separate
 * `external_directory` approval.
 */
export const ResolveInput = Schema.Struct({
  path: Schema.String,
  /** Selects the external approval boundary; it does not validate the target type. */
  kind: Kind.pipe(Schema.optional),
})
export type ResolveInput = typeof ResolveInput.Type

export interface ExternalDirectoryAuthorization {
  readonly action: "external_directory"
  /** Canonical directory used as the external approval boundary. */
  readonly directory: string
  /** `external_directory` permission resource. */
  readonly resource: string
  readonly save: string
}

export const externalDirectoryPermission = (input: ExternalDirectoryAuthorization) => ({
  action: input.action,
  resources: [input.resource],
  save: [input.save],
})

export interface Target {
  /** Absolute lexical path. */
  readonly absolute: string
  /** Canonical path after following every existing symlink or junction ancestor. */
  readonly canonical: string
  /** Canonical parent plus lexical basename, without following the final entry. */
  readonly entry: string
  /** Canonical permission resource: Location-relative for internal paths, absolute for external paths. */
  readonly resource: string
  readonly externalDirectory?: ExternalDirectoryAuthorization
}

export interface Interface {
  /**
   * Resolve a path and derive its permission resources. Relative paths resolve
   * from the Location. Paths outside it require separate `external_directory`
   * approval. This does not approve the mutation.
   */
  readonly resolve: (input: ResolveInput) => Effect.Effect<Target, FSUtil.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LocationMutation") {}

const slash = (value: string) => value.replaceAll("\\", "/")

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const location = yield* Location.Service

    const resolve = Effect.fnUntraced(function* (input: ResolveInput) {
      const absolute = path.resolve(location.directory, input.path)
      const root = yield* canonicalize(fs, location.directory)
      const entry = path.join(yield* canonicalize(fs, path.dirname(absolute)), path.basename(absolute))
      const canonical = yield* canonicalize(fs, entry)
      const externalTarget = !FSUtil.contains(root, canonical)
        ? canonical
        : !FSUtil.contains(root, entry)
          ? entry
          : undefined
      if (externalTarget === undefined) {
        return {
          absolute,
          canonical,
          entry,
          resource: slash(path.relative(root, canonical) || "."),
        } satisfies Target
      }
      const type =
        input.kind === "directory"
          ? "Directory"
          : input.kind === "file"
            ? "File"
            : (yield* fs
                .stat(externalTarget)
                .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined)))?.type
      const externalDirectory = type === "Directory" ? externalTarget : path.dirname(externalTarget)
      const externalResource = slash(path.join(externalDirectory, "*"))
      return {
        absolute,
        canonical,
        entry,
        resource: slash(canonical),
        externalDirectory: {
          action: "external_directory",
          directory: externalDirectory,
          resource: externalResource,
          save: slash(
            path.join((yield* Project.root(fs, AbsolutePath.make(externalDirectory))) ?? externalDirectory, "*"),
          ),
        },
      } satisfies Target
    })

    return Service.of({ resolve })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer: layer.pipe(Layer.orDie),
  deps: [FSUtil.node, Location.node],
})

/**
 * Resolve every existing path component through symlinks/junctions, then append
 * the still-missing suffix. A dangling symlink is followed through readLink so
 * it cannot disguise a prospective external mutation target.
 */
const canonicalize = Effect.fnUntraced(function* (fs: FSUtil.Interface, input: string) {
  const resolved = path.resolve(input)
  const root = path.parse(resolved).root
  const pending = path.relative(root, resolved).split(path.sep).filter(Boolean)
  const seen = new Set<string>()
  let current = root
  while (pending.length > 0) {
    const part = pending.shift()!
    const candidate = path.join(current, part)
    const real = yield* fs
      .realPath(candidate)
      .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined))
    if (real !== undefined) {
      current = real
      continue
    }
    const link = yield* fs
      .readLink(candidate)
      .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined))
    if (link === undefined) return path.resolve(current, part, ...pending)
    const identity = FSUtil.normalizePath(candidate)
    if (seen.has(identity) || seen.size >= 40) {
      return yield* new FSUtil.FileSystemError({
        method: "canonicalize mutation path",
        cause: new Error(`Too many symbolic links: ${input}`),
      })
    }
    seen.add(identity)
    const target = path.resolve(path.dirname(candidate), link, ...pending)
    current = path.parse(target).root
    pending.splice(0, pending.length, ...path.relative(current, target).split(path.sep).filter(Boolean))
  }
  return path.resolve(current)
})
