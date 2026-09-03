# Shell 沙箱漏洞修复说明

## 1. 背景

本说明对应以下两轮容器测试：

- `docs/testing/sandbox-integration-test-report.md`
- `docs/testing/shell-sandbox-adversarial-report.md`

第二轮测试在 `dataagent-repro` 中稳定复现了三个安全问题：

1. bwrap 包装进程超时退出后，进入新 session 的后台子进程仍然存活；
2. workspace 中预置的硬链接可以读取 workspace 外的同一 inode；
3. workspace 中预置的硬链接可以修改 workspace 外的同一 inode。

本次修改修复上述三个复现用例，没有降低断言、跳过失败用例或更换为非生产 bwrap 参数。

## 2. 修改文件

| 文件 | 修改内容 |
| --- | --- |
| `packages/core/src/sandbox/bwrap.ts` | 增加 `--unshare-pid`，让命令及后代处于独立 PID namespace |
| `packages/core/src/sandbox/service.ts` | 在首次启动沙箱前检查 workspace 是否存在指向外部的硬链接 inode |
| `packages/core/test/sandbox-bwrap.test.ts` | 增加 `--unshare-pid` 参数回归断言 |
| `packages/core/test/shell-sandbox-adversarial.test.ts` | 将三个漏洞复现用例转为修复回归，并增加 workspace 内部硬链接兼容测试 |

没有修改 V1 `packages/opencode`，没有修改 Protocol、Server HttpApi 或生成客户端，因此不需要执行 `packages/client` 的 `bun run generate`。

## 3. 后台子进程修复

### 原因

原实现使用：

```text
--die-with-parent
--new-session
```

Shell 进程超时后会终止 bwrap 包装进程组，但 `--new-session` 中的后台后代可能不再属于原始进程组。测试使用随机 marker 启动 30 秒 Python 后台进程，在 300 ms 超时后杀死包装进程组，再等待 300 ms，仍可从 `/proc/<pid>/cmdline` 找到该进程。

### 修复

新增：

```text
--unshare-pid
```

沙箱命令成为独立 PID namespace 中的生命周期根。namespace 的 init 进程退出后，内核终止其中剩余进程，因此清理不再只依赖 POSIX process group。

### 验证

修复前：后台清理用例 FAIL，标记子进程仍存活。

修复后：同一测试 PASS；超时返回后 300 ms 检查不到随机 marker 子进程，最终残留扫描为 0。

### 兼容性说明

当前 Docker 环境不能使用 `--proc /proc`，所以仍只读绑定容器已有 `/proc`。因此 `--unshare-pid` 本次主要提供后代生命周期清理，不把 `/proc` 进程信息可见性声明为已隔离；`/proc/1/status` 仍可读的特征测试继续保留。

## 4. 外部硬链接修复

### 原因

bwrap 的 bind mount 按路径建立边界，但硬链接是同一 inode 的另一个目录项。若 workspace 在沙箱启动前已经包含指向外部文件 inode 的硬链接，命令只访问 workspace 路径也能读写该 inode。符号链接逃逸测试无法覆盖此行为。

### 修复

`Sandbox.Service` 在每个 Location 生命周期的第一次 `prepare` 前运行一次只读预检：

1. 使用绝对路径调用 Linux `find`，只输出 `nlink > 1` 的普通文件；
2. 输出字段为 filesystem device、inode、总链接数和 workspace 内路径，使用 NUL 分隔以支持空格和换行文件名；
3. TypeScript 按 `(device, inode)` 汇总 workspace 内目录项数量；
4. 若 inode 总链接数大于 workspace 内计数，说明至少有一个链接位于 workspace 外，Sandbox Service 拒绝启动；
5. 如果同一 inode 的全部链接都位于 workspace 内，则允许执行，不会粗暴拒绝合法内部硬链接；
6. 预检失败时采用 fail-closed，不启动 bwrap。

错误信息示例：

```text
Sandbox workspace contains a file hard-linked outside the workspace: <path>
```

### 缓存与性能

预检通过 `Effect.cached` 在 Location-scoped Sandbox Service 内缓存，只在该 Location 第一次 Shell 执行时运行。

曾验证纯 TypeScript 逐文件 `lstat` 方案，在真实 opencode monorepo 上约需 32 秒，因此没有采用。改用原生候选筛选后，真实项目执行“首次预检 + bwrap 启动 + true”实测约 817 ms；后续同一 Location 不重复扫描。

当前实现依赖 Linux `find` 支持 `-links` 和 `-printf`。目标 openEuler 容器已真实验证支持。如果找不到 `find` 或预检命令失败，沙箱会拒绝启动，不会静默绕过。

### 验证

- 外部硬链接读取：修复前退出码 0 并输出外部 marker；修复后在启动命令前拒绝，外部内容不泄漏；
- 外部硬链接写入：修复前退出码 0 且外部文件变为 `sandbox-change`；修复后在启动命令前拒绝，外部文件保持 `outside-original`；
- 内部硬链接：两个目录项都位于 workspace 时命令正常读取，验证没有过度阻断。

## 5. 最终测试结果

执行环境：openEuler 24.03 LTS-SP1、Bun 1.3.14、bubblewrap 0.12.0、Python 3.11.6、prlimit util-linux 2.39.1。

### 对抗与修复回归

```bash
cd /srv/onto/dataagent/cubecode/packages/core
./script/run-shell-sandbox-adversarial.sh
```

结果：`17 pass / 0 fail`，36 次断言，退出码 0，约 4.34 秒。

### 原有基线与集成回归

```bash
./script/run-sandbox-integration.sh
```

结果：

- bwrap/ShellTool 基线：`23 pass / 0 fail`，94 次断言；
- 真实集成：`23 pass / 1 skip / 0 fail`，75 次断言；
- Node.js 因容器未安装 `node` 保持 SKIP。

### 类型检查

```bash
bun typecheck
```

结果：退出码 0。

最终受影响测试合计：`63 pass / 1 skip / 0 fail`。

## 6. 安全影响

- 超时终止现在能够依靠 PID namespace 清理进入新 session 的后台后代，降低孤儿进程持续消耗 CPU、内存和 PID 的风险；
- 沙箱启动前会拒绝 workspace 到外部 inode 的预置硬链接，防止通过 workspace 路径读取或修改外部 fixture；
- 预检只读取元数据，不读取文件内容，不输出敏感内容；
- 所有失败路径均 fail-closed。

## 7. 剩余边界

1. `/proc` 仍复用容器已有只读挂载，PID 元数据可见性没有被本次修复隐藏。
2. 硬链接预检在每个 Location 第一次执行时完成并缓存。具有沙箱外同用户写权限的独立进程若在预检之后并发修改 workspace，属于剩余竞态；沙箱内命令本身看不到外部路径，不能直接创建该外部硬链接。
3. 当前仍没有 per-sandbox `RLIMIT_NPROC` 或 cgroup PIDs 限制，Docker HostConfig 的 `PidsLimit` 也为 null。真正进程耗尽测试仍需要独立容器保险。
4. 未增加 seccomp 规则，也没有声明防御内核 namespace 漏洞。

若要进一步消除硬链接预检竞态，需要每条命令重复扫描或使用独立文件系统/overlay/copy 边界。前者在真实 monorepo 上每次约增加一次完整遍历，后者会改变 workspace 写入持久化语义，需单独设计和审批。
