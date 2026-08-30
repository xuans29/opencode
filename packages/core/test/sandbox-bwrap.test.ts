import { describe, expect, test } from "bun:test"
import { SandboxBwrap } from "@opencode-ai/core/sandbox/bwrap"

const invocation = {
  command: "printf ok",
  cwd: "/workspace/project",
  timeout: 120_000,
  shell: "/bin/bash",
  env: {
    PATH: "/custom/bin:/usr/bin",
    HOME: "/home/opencode",
    LANG: "en_US.UTF-8",
    API_KEY: "secret",
  },
}

describe("SandboxBwrap", () => {
  test("builds a writable workspace over a read-only container root", () => {
    const process = SandboxBwrap.build({
      executable: "/usr/local/bin/bwrap",
      workspace: "/workspace/project",
      invocation,
    })

    expect(process.executable).toBe("/usr/local/bin/bwrap")
    expect(process.cwd).toBe(invocation.cwd)
    expect(process.args.slice(process.args.indexOf("--") + 1)).toEqual(["/bin/bash", "-c", invocation.command])

    const root = process.args.indexOf("--ro-bind")
    const workspace = process.args.indexOf("--bind")
    expect(process.args.slice(root, root + 3)).toEqual(["--ro-bind", "/", "/"])
    expect(process.args.slice(workspace, workspace + 3)).toEqual(["--bind", "/workspace/project", "/workspace/project"])
    expect(root).toBeLessThan(workspace)
  })

  test("uses the requested namespaces without PID or proc isolation", () => {
    const process = SandboxBwrap.build({
      executable: "bwrap",
      workspace: "/workspace/project",
      invocation,
    })

    expect(process.args).toContain("--unshare-user")
    expect(process.args).toContain("--unshare-ipc")
    expect(process.args).toContain("--unshare-net")
    expect(process.args).toContain("--unshare-uts")
    expect(process.args).toContain("--new-session")
    expect(process.args).toContain("--die-with-parent")
    expect(process.args).toContain("--dev")
    expect(process.args).toContain("--tmpfs")
    expect(process.args).not.toContain("--unshare-pid")
    expect(process.args).not.toContain("--proc")
  })

  test("clears secrets while preserving runtime discovery paths", () => {
    const process = SandboxBwrap.build({
      executable: "bwrap",
      workspace: "/workspace/project",
      invocation,
    })
    const args = process.args.join(" ")

    expect(process.args).toContain("--clearenv")
    expect(args).toContain("/workspace/project/.venv/bin")
    expect(args).toContain("/workspace/project/node_modules/.bin")
    expect(args).not.toContain("API_KEY")
    expect(args).not.toContain("secret")
    expect(process.env).not.toHaveProperty("API_KEY")
  })
})
