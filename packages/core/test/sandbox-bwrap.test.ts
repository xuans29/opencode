import { describe, expect, test } from "bun:test"
import { Bwrap } from "@opencode-ai/core/sandbox/bwrap"
import { Prlimit } from "@opencode-ai/core/sandbox/prlimit"
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
    expect(prepared.args.indexOf("--ro-bind-try")).toBeLessThan(prepared.args.indexOf("--bind"))
    expect(prepared.args.slice(prepared.args.indexOf("--bind"), prepared.args.indexOf("--bind") + 3)).toEqual([
      "--bind",
      workspace,
      workspace,
    ])
    expect(prepared.args).toContain("--unshare-all")
    expect(prepared.args).toContain("--disable-userns")
    expect(prepared.args).toContain("--assert-userns-disabled")
    expect(prepared.args).toContain("--cap-drop")
    expect(prepared.args).toContain("--dev")
    expect(prepared.args).toContain("--tmpfs")
    expect(prepared.args).toContain("--clearenv")
    expect(prepared.args).toContain("--proc")

    const pathIndex = prepared.args.findIndex(
      (item, index) => item === "PATH" && prepared.args[index - 1] === "--setenv",
    )
    expect(prepared.args[pathIndex + 1]).toBe(`${workspace}/.venv/bin:${workspace}/node_modules/.bin:${input.env.PATH}`)
    expect(Object.keys(prepared.env).sort()).toEqual(["LANG", "PATH"])
    expect(prepared.env).not.toHaveProperty("OPENAI_API_KEY")
    expect(prepared.env).not.toHaveProperty("ACCESS_TOKEN")
    expect(prepared.args).not.toContain("secret-api-key")
    expect(prepared.args).not.toContain("secret-token")
    expect(prepared.args.slice(-4)).toEqual(["--", input.executable, ...input.args])
  })

  test("wraps the sandbox with per-process resource limits", () => {
    const input: PreparedProcess = {
      executable: "/usr/bin/bwrap",
      args: ["--", "/bin/bash", "-lc", "true"],
      cwd: "/workspace/project",
      env: { PATH: "/usr/bin:/bin" },
    }
    const prepared = Prlimit.prepare(input, "/usr/bin/prlimit", {
      cpuSeconds: 120,
      memoryBytes: 1024 * 1024 * 1024,
      fileSizeBytes: 256 * 1024 * 1024,
      openFiles: 256,
    })

    expect(prepared.executable).toBe("/usr/bin/prlimit")
    expect(prepared.args.slice(0, 5)).toEqual([
      "--cpu=120",
      "--as=1073741824",
      "--fsize=268435456",
      "--nofile=256",
      "--",
    ])
    expect(prepared.args.slice(5)).toEqual([input.executable, ...input.args])
    expect(prepared.cwd).toBe(input.cwd)
    expect(prepared.env).toBe(input.env)
  })
})
