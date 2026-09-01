import { describe, expect, test } from "bun:test"
import { Bwrap } from "@opencode-ai/core/sandbox/bwrap"
import type { PreparedProcess } from "@opencode-ai/core/shell"

describe("bwrap sandbox", () => {
  test("wraps the shell invocation with the required isolation and environment", () => {
    const workspace = "/workspace/project"
    const input: PreparedProcess = {
      executable: "/bin/bash",
      args: ["-lc", "printf sandbox-ok"],
      cwd: "/workspace/project/src",
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HOME: "/home/opencode",
        LANG: "en_US.UTF-8",
        TMPDIR: "/host/tmp",
        TERM: "screen-256color",
        OPENAI_API_KEY: "secret-api-key",
        ACCESS_TOKEN: "secret-token",
      },
    }
    const prepared = Bwrap.prepare(input, workspace, "/usr/local/bin/bwrap")

    expect(prepared.executable).toBe("/usr/local/bin/bwrap")
    expect(prepared.cwd).toBe(input.cwd)
    expect(prepared.args.indexOf("--ro-bind")).toBeLessThan(prepared.args.indexOf("--bind"))
    expect(prepared.args.slice(prepared.args.indexOf("--ro-bind"), prepared.args.indexOf("--ro-bind") + 3)).toEqual([
      "--ro-bind",
      "/",
      "/",
    ])
    expect(prepared.args.slice(prepared.args.indexOf("--bind"), prepared.args.indexOf("--bind") + 3)).toEqual([
      "--bind",
      workspace,
      workspace,
    ])
    expect(prepared.args).toContain("--unshare-user")
    expect(prepared.args).toContain("--unshare-ipc")
    expect(prepared.args).toContain("--unshare-net")
    expect(prepared.args).toContain("--unshare-uts")
    expect(prepared.args).toContain("--dev")
    expect(prepared.args).toContain("--tmpfs")
    expect(prepared.args).toContain("--clearenv")
    expect(prepared.args).not.toContain("--unshare-pid")
    expect(prepared.args).not.toContain("--proc")

    const pathIndex = prepared.args.findIndex(
      (item, index) => item === "PATH" && prepared.args[index - 1] === "--setenv",
    )
    expect(prepared.args[pathIndex + 1]).toBe(`${workspace}/.venv/bin:${workspace}/node_modules/.bin:${input.env.PATH}`)
    expect(Object.keys(prepared.env).sort()).toEqual(["HOME", "LANG", "PATH", "TMPDIR"])
    expect(prepared.env).not.toHaveProperty("OPENAI_API_KEY")
    expect(prepared.env).not.toHaveProperty("ACCESS_TOKEN")
    expect(prepared.args).not.toContain("secret-api-key")
    expect(prepared.args).not.toContain("secret-token")
    expect(prepared.args.slice(-4)).toEqual(["--", input.executable, ...input.args])
  })
})
