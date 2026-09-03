import fs from "fs/promises"
import path from "path"
import { afterEach, describe, expect, test } from "bun:test"
import { runSandbox } from "./lib/adversarial-sandbox-runner"

const enabled = process.env.OPENCODE_RUN_SANDBOX_SECURITY_INTEGRATION === "1"
const integrationTest = enabled ? test : test.skip
const unshareTest = enabled && Bun.which("unshare") ? test : test.skip
const roots = new Set<string>()

if (!enabled)
  console.warn("sandbox security integration skipped: set OPENCODE_RUN_SANDBOX_SECURITY_INTEGRATION=1 on Linux")
if (enabled && !Bun.which("unshare")) console.warn("nested user namespace test skipped: unshare is not installed")

afterEach(async () => {
  await Promise.all([...roots].map((item) => fs.rm(item, { recursive: true, force: true })))
  roots.clear()
})

describe("bounded sandbox security and resource integration", () => {
  integrationTest(
    "enforces a one-second CPU limit on a bounded busy loop",
    async () => {
      const fixture = await createFixture()
      const result = await withEnvironment("OPENCODE_SANDBOX_CPU_SECONDS", "1", () =>
        runSandbox(fixture.workspace, "python3 -c \"while True: pass\"", { timeout: 4_000 }),
      )

      expect(result.exitCode).not.toBe(0)
      expect(result.timedOut).toBe(false)
    },
    8_000,
  )

  integrationTest(
    "enforces a 64 MiB address-space limit with a bounded allocation",
    async () => {
      const fixture = await createFixture()
      const result = await withEnvironment("OPENCODE_SANDBOX_MEMORY_MB", "64", () =>
        runSandbox(fixture.workspace, "python3 -c \"bytearray(96 * 1024 * 1024)\""),
      )

      expect(result.exitCode).not.toBe(0)
      expect(result.timedOut).toBe(false)
      expect(result.stderr).toMatch(/MemoryError|cannot allocate memory/i)
    },
    10_000,
  )

  integrationTest(
    "enforces a small open-file limit",
    async () => {
      const fixture = await createFixture()
      await fs.writeFile(
        path.join(fixture.workspace, "open-files.py"),
        [
          "files = []",
          "try:",
          "    for index in range(128):",
          "        files.append(open(f'file-{index}', 'w'))",
          "except OSError as error:",
          "    print(f'errno={error.errno};opened={len(files)}')",
          "    raise SystemExit(0 if error.errno == 24 else 2)",
          "raise SystemExit(3)",
        ].join("\n"),
      )
      const result = await withEnvironment("OPENCODE_SANDBOX_OPEN_FILES", "32", () =>
        runSandbox(fixture.workspace, "python3 open-files.py"),
      )

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toMatch(/errno=24;opened=\d+/)
    },
    10_000,
  )

  integrationTest(
    "runs five isolated sandboxes concurrently within a short bound",
    async () => {
      const fixture = await createFixture()
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, index) =>
          runSandbox(fixture.workspace, `sleep 0.1; printf concurrent-${index}`, { timeout: 2_000 }),
        ),
      )

      expect(results.map((result) => result.exitCode)).toEqual([0, 0, 0, 0, 0])
      expect(results.map((result) => result.stdout).sort()).toEqual(
        Array.from({ length: 5 }, (_, index) => `concurrent-${index}`).sort(),
      )
    },
    10_000,
  )

  integrationTest(
    "repeats twenty short sandbox launches without residue",
    async () => {
      const fixture = await createFixture()
      const results = []
      for (const index of Array.from({ length: 20 }, (_, item) => item)) {
        results.push(await runSandbox(fixture.workspace, `printf repeat-${index}`))
      }

      expect(results.every((result) => result.exitCode === 0)).toBe(true)
      expect(results.at(-1)?.stdout).toBe("repeat-19")
    },
    20_000,
  )

  integrationTest(
    "kills a marked background child when the sandbox parent times out",
    async () => {
      const fixture = await createFixture()
      const marker = `opencode-background-${crypto.randomUUID()}`
      const command = `python3 -c \"import time; time.sleep(30)\" '${marker}' >/dev/null 2>&1 & echo $! > child.pid; wait`
      const result = await runSandbox(fixture.workspace, command, { timeout: 300 })
      const pid = Number(await fs.readFile(path.join(fixture.workspace, "child.pid"), "utf8"))
      await Bun.sleep(300)
      const survived = await processMatches(pid, marker)
      try {
        expect(result.timedOut).toBe(true)
        expect(survived).toBe(false)
      } finally {
        if (survived) process.kill(pid, "SIGKILL")
      }
    },
    8_000,
  )

  integrationTest(
    "keeps proc sysctl files read-only",
    async () => {
      const fixture = await createFixture()
      const result = await runSandbox(fixture.workspace, "printf 1 > /proc/sys/user/max_user_namespaces")

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toMatch(/Read-only file system|Permission denied/)
    },
    10_000,
  )

  integrationTest(
    "does not expose the host sys filesystem",
    async () => {
      const fixture = await createFixture()
      const result = await runSandbox(fixture.workspace, "test ! -e /sys && printf sys-hidden")

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe("sys-hidden")
    },
    10_000,
  )

  integrationTest(
    "exposes only the minimal sandbox device set",
    async () => {
      const fixture = await createFixture()
      const result = await runSandbox(
        fixture.workspace,
        "printf device-ok > /dev/null; test ! -e /dev/kmsg; test ! -e /dev/mem; test ! -e /dev/sda; printf devices-minimal",
      )

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe("devices-minimal")
    },
    10_000,
  )

  integrationTest(
    "hides outer dev shm objects",
    async () => {
      const fixture = await createFixture()
      const marker = path.join("/dev/shm", `opencode-sandbox-${crypto.randomUUID()}`)
      roots.add(marker)
      await fs.writeFile(marker, "outer-shm-marker")
      const result = await runSandbox(fixture.workspace, `test ! -e '${marker}' && printf shm-hidden`)

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe("shm-hidden")
      expect(await fs.readFile(marker, "utf8")).toBe("outer-shm-marker")
    },
    10_000,
  )

  integrationTest(
    "cannot change the isolated UTS hostname after capability drop",
    async () => {
      const fixture = await createFixture()
      await fs.writeFile(
        path.join(fixture.workspace, "set-hostname.py"),
        [
          "import ctypes",
          "import os",
          "name = b'opencode-sandbox-test'",
          "libc = ctypes.CDLL(None, use_errno=True)",
          "result = libc.sethostname(name, len(name))",
          "error = ctypes.get_errno()",
          "if result != 0:",
          "    raise OSError(error, os.strerror(error))",
        ].join("\n"),
      )
      const result = await runSandbox(fixture.workspace, "python3 set-hostname.py")

      expect(result.exitCode).not.toBe(0)
      expect(result.stderr).toMatch(/Operation not permitted|permission denied/i)
    },
    10_000,
  )

  unshareTest(
    "records nested user-namespace behavior without an exploit payload",
    async () => {
      const fixture = await createFixture()
      const result = await runSandbox(
        fixture.workspace,
        "unshare -Ur sh -c \"grep '^CapEff:' /proc/self/status\"",
      )

      expect([0, 1]).toContain(result.exitCode)
      if (result.exitCode === 0) expect(result.stdout).toMatch(/^CapEff:\s+[0-9a-f]{16}$/m)
      else expect(result.stderr.length).toBeGreaterThan(0)
    },
    10_000,
  )

  integrationTest(
    "records current process-namespace visibility",
    async () => {
      const fixture = await createFixture()
      const result = await runSandbox(fixture.workspace, "test -r /proc/1/status && printf pid-one-visible")

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe("pid-one-visible")
    },
    10_000,
  )

  integrationTest(
    "records the absence of a per-sandbox process-count limit",
    async () => {
      const fixture = await createFixture()
      const result = await runSandbox(
        fixture.workspace,
        "for index in $(seq 1 12); do (sleep 0.1) & done; wait; printf fanout-complete",
        { timeout: 3_000 },
      )

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe("fanout-complete")
    },
    10_000,
  )

  integrationTest(
    "allows hard links whose directory entries are all inside the workspace",
    async () => {
      const fixture = await createFixture()
      const original = path.join(fixture.workspace, "internal-original.txt")
      await fs.writeFile(original, "internal-hardlink-marker")
      await fs.link(original, path.join(fixture.workspace, "internal-link.txt"))
      const result = await runSandbox(fixture.workspace, "cat internal-link.txt")

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toBe("internal-hardlink-marker")
    },
    10_000,
  )

  integrationTest(
    "blocks reading an outside file through a workspace hard link",
    async () => {
      const fixture = await createFixture()
      const outside = path.join(fixture.outside, "hardlink-read.txt")
      const link = path.join(fixture.workspace, "hardlink-read.txt")
      await fs.writeFile(outside, "outside-hardlink-marker")
      await fs.link(outside, link)

      await expect(runSandbox(fixture.workspace, "cat hardlink-read.txt")).rejects.toThrow(
        "hard-linked outside the workspace",
      )
      expect(await fs.readFile(outside, "utf8")).toBe("outside-hardlink-marker")
    },
    10_000,
  )

  integrationTest(
    "blocks modifying an outside file through a workspace hard link",
    async () => {
      const fixture = await createFixture()
      const outside = path.join(fixture.outside, "hardlink-write.txt")
      const link = path.join(fixture.workspace, "hardlink-write.txt")
      await fs.writeFile(outside, "outside-original")
      await fs.link(outside, link)

      await expect(runSandbox(fixture.workspace, "printf sandbox-change > hardlink-write.txt")).rejects.toThrow(
        "hard-linked outside the workspace",
      )
      expect(await fs.readFile(outside, "utf8")).toBe("outside-original")
    },
    10_000,
  )
})

async function createFixture() {
  const workspace = await fs.realpath(await fs.mkdtemp(path.join(process.cwd(), ".sandbox-security-workspace-")))
  const outside = await fs.realpath(await fs.mkdtemp(path.join(process.cwd(), ".sandbox-security-outside-")))
  roots.add(workspace)
  roots.add(outside)
  return { workspace, outside }
}

async function withEnvironment<A>(name: string, value: string, body: () => Promise<A>) {
  const previous = process.env[name]
  process.env[name] = value
  try {
    return await body()
  } finally {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  }
}

async function processMatches(pid: number, marker: string) {
  return fs
    .readFile(`/proc/${pid}/cmdline`, "utf8")
    .then((value) => value.includes(marker))
    .catch(() => false)
}
