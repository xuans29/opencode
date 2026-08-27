import { describe, expect, test } from "bun:test"
import { SandboxBwrap } from "@opencode-ai/core/sandbox/bwrap"

const workspace = {
  project: "D:\\repo\\project",
  work: "D:\\sandbox\\session-a\\work",
  script: "/workspace/scripts/test.py",
  workdir: "/workspace",
}

describe("SandboxBwrap", () => {
  test.each([
    ["python" as const, "C:\\runtime\\python3.exe", "/sandbox/bin/python3"],
    ["typescript" as const, "C:\\runtime\\bun.exe", "/sandbox/bin/bun"],
  ])("builds the %s process without PID or proc isolation", (language, runtime, target) => {
    const process = SandboxBwrap.build({
      language,
      workspace,
      runtime,
      args: ["one"],
      env: { PATH: "safe-path", HOME: "safe-home", API_KEY: "secret", TOKEN: "secret" },
    })

    expect(process.executable).toBe("bwrap")
    expect(process.cwd).toBe(workspace.project)
    expect(process.args).toContain("--unshare-net")
    expect(process.args).toContain("--clearenv")
    expect(process.args).toContain("--tmpfs")
    expect(process.args).toContain("--chdir")
    expect(process.args).toContain(target)
    expect(process.args).toContain(workspace.project)
    expect(process.args).toContain(workspace.work)
    expect(process.args).not.toContain("--unshare-pid")
    expect(process.args).not.toContain("--proc")
    expect(process.args.join(" ")).not.toContain("--bind / /")
    expect(process.env).toEqual({ PATH: "safe-path", HOME: "safe-home", LANG: "C.UTF-8" })
    expect(process.env).not.toHaveProperty("API_KEY")
    expect(process.env).not.toHaveProperty("TOKEN")
  })

  test("uses fixed mount targets with Windows host paths", () => {
    const process = SandboxBwrap.build({ language: "python", workspace, runtime: "python3" })
    expect(process.args).toContain(workspace.project)
    expect(process.args).toContain("/workspace")
    expect(process.args).toContain(workspace.work)
    expect(process.args).toContain("/work")
    expect(process.args).toContain("--tmpfs")
    expect(process.args).toContain("/tmp")
    expect(process.args.slice(process.args.indexOf("--") + 1)).toEqual([
      "/sandbox/bin/python3",
      "/workspace/scripts/test.py",
    ])
  })
})
