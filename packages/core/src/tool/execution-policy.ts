export * as ToolExecutionPolicy from "./execution-policy.js"

import { Tool } from "@opencode-ai/schema/tool"

export type Profile = "shell" | "script"

export type ExecutionClass = { readonly class: "host" } | { readonly class: "sandbox"; readonly profile: Profile }

export type Decision = { readonly target: "host" } | { readonly target: "sandbox"; readonly profile: Profile }

const protectedNames = new Set(["shell", "script"])
const registrations = new WeakMap<Tool.Info, ExecutionClass>()

export const isProtected = (name: string) => protectedNames.has(name)

// This internal provenance marker classifies a complete built-in Tool.Info for
// registry enforcement and tracing. It does not wrap the executor: the trusted
// leaf remains responsible for calling Sandbox.Service and failing closed.
export const declareSandbox = <Input extends Tool.ValueSchema<any>, Output extends Tool.ValueSchema<any> | undefined>(
  tool: Tool.Info<Input, Output>,
  profile: Profile,
) => {
  registrations.set(tool, { class: "sandbox", profile })
  return tool
}

export const execution = (tool: Tool.Info): ExecutionClass => registrations.get(tool) ?? { class: "host" }

export const decide = (execution: ExecutionClass): Decision => {
  if (execution.class === "sandbox") return { target: "sandbox", profile: execution.profile }
  return { target: "host" }
}
