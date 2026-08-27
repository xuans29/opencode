import fs from "node:fs/promises"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SandboxWorkspace } from "@opencode-ai/core/sandbox/workspace"
import { tmpdir } from "./fixture/tmpdir"

describe("SandboxWorkspace", () => {
  test("creates stable isolated session work directories and maps host paths to POSIX paths", async () => {
    await using tmp = await tmpdir()
    const project = path.join(tmp.path, "project")
    const workRoot = path.join(tmp.path, "sandbox")
    await fs.mkdir(path.join(project, "scripts"), { recursive: true })
    await fs.writeFile(path.join(project, "scripts", "test.py"), "print('ok')")

    const first = await Effect.runPromise(
      SandboxWorkspace.prepare({ project, workRoot, sessionID: "session-a", script: "test.py", workdir: "scripts" }),
    )
    const again = await Effect.runPromise(
      SandboxWorkspace.prepare({ project, workRoot, sessionID: "session-a", script: "test.py", workdir: "scripts" }),
    )
    const second = await Effect.runPromise(
      SandboxWorkspace.prepare({ project, workRoot, sessionID: "session-b", script: "test.py", workdir: "scripts" }),
    )

    expect(first.work).toBe(again.work)
    expect(first.work).not.toBe(second.work)
    expect(first.script).toBe("/workspace/scripts/test.py")
    expect(first.workdir).toBe("/workspace/scripts")
    expect((await fs.stat(first.work)).isDirectory()).toBe(true)
  })

  test("rejects relative escape and absolute paths outside the project", async () => {
    await using tmp = await tmpdir()
    const project = path.join(tmp.path, "project")
    const outside = path.join(tmp.path, "outside.py")
    await fs.mkdir(project, { recursive: true })
    await fs.writeFile(outside, "print('outside')")

    await expect(
      Effect.runPromise(
        SandboxWorkspace.prepare({
          project,
          workRoot: path.join(tmp.path, "sandbox"),
          sessionID: "session-a",
          script: "../outside.py",
        }),
      ),
    ).rejects.toThrow("outside the project")
    await expect(
      Effect.runPromise(
        SandboxWorkspace.prepare({
          project,
          workRoot: path.join(tmp.path, "sandbox"),
          sessionID: "session-a",
          script: outside,
        }),
      ),
    ).rejects.toThrow("outside the project")
  })
})
