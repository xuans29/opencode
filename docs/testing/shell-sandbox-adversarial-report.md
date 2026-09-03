# Shell 沙箱有界对抗与资源测试报告

## 1. 结论

本轮使用全新命名的测试文件、执行器、脚本和报告，在 `dataagent-repro` 容器中对生产 `Sandbox.Service -> Bwrap.prepare -> Prlimit.prepare` 链路进行了有界对抗测试。

- 本轮测试：`13 pass / 3 fail / 0 skip`，32 次断言，退出码 1；
- 未设置开关时：`0 pass / 0 fail / 16 skip`，退出码 0；
- 上一轮独立回归：`46 pass / 0 fail / 1 skip`，未受本轮文件影响；
- `packages/core` 类型检查：退出码 0；
- 测试后 workspace、`/dev/shm` 和标记后台进程残留均为 0。

三个失败均被保留，没有降低断言或绕过生产参数：

1. 超时杀死沙箱包装进程及其原始进程组后，进入新 session 的后台子进程仍存活；
2. workspace 中预置的硬链接可以读取 workspace 外的同一 inode；
3. workspace 中预置的硬链接可以修改 workspace 外的同一 inode。

## 2. 环境与代码基线

| 项目 | 实际值 |
| --- | --- |
| 分支 | `home-sandbox-dev` |
| 本轮开始时本地 HEAD | `55e268e299 test(core): add sandbox integration coverage` |
| 容器 | `dataagent-repro` |
| 系统 | openEuler 24.03 (LTS-SP1) |
| 用户 | ryoma，UID/GID 12100 |
| Bun | 1.3.14 |
| Python | 3.11.6 |
| bubblewrap | 0.12.0，`/usr/local/bin/bwrap` |
| prlimit | util-linux 2.39.1，`/usr/bin/prlimit` |
| cgroups | v2 |
| Docker 资源 | 8 GB 内存、约 8 核 CPU、`PidsLimit=null` |

本轮没有修改 `packages/core/src/sandbox/bwrap.ts` 等生产代码。上一轮文件 `sandbox-integration.test.ts`、`run-sandbox-integration.sh` 和 `sandbox-integration-test-report.md` 保持原样。

## 3. 安全边界

本轮包含 CPU 忙循环、受限内存申请、有限子进程、短并发、有限重复和受控硬链接逃逸，但所有用例都有明确保险：

- CPU 限制为 1 秒，外层最长 4 秒；
- 内存限制为 64 MiB，仅尝试分配 96 MiB；
- nofile 限制为 32，仅尝试打开 128 个小文件；
- 并发仅 5 个沙箱，每个 sleep 0.1 秒；
- 重复仅 20 次短命令；
- 进程 fan-out 仅 12 个、每个 sleep 0.1 秒；
- 后台进程最长 sleep 30 秒，但 300 ms 后检查，并在 finally 中按精确 PID 和随机 marker 强制清理；
- 硬链接只连接测试创建的无敏感 fixture；
- 每项 Bun 测试最长 8 至 20 秒；
- 没有 fork bomb、根目录删除、内核漏洞 payload、大文件、接近 8 GB 的分配或长时间满载。

## 4. 执行命令

### 默认跳过

```bash
cd /srv/onto/dataagent/cubecode/packages/core
bun test test/shell-sandbox-adversarial.test.ts
```

实际结果：`0 pass / 16 skip / 0 fail`。提示必须设置 `OPENCODE_RUN_SANDBOX_SECURITY_INTEGRATION=1`。

### 本轮真实测试

```bash
cd /srv/onto/dataagent/cubecode/packages/core
OPENCODE_RUN_SANDBOX_SECURITY_INTEGRATION=1 \
bun test test/shell-sandbox-adversarial.test.ts
```

实际结果：`13 pass / 3 fail`，退出码 1，耗时约 4.46 秒。

### 独立执行脚本

```bash
cd /srv/onto/dataagent/cubecode/packages/core
./script/run-shell-sandbox-adversarial.sh
```

实际结果：`13 pass / 3 fail`，退出码 1。脚本有意传播失败退出码。

### 诊断模式

```bash
OPENCODE_RUN_SANDBOX_SECURITY_INTEGRATION=1 \
OPENCODE_SANDBOX_TEST_DIAGNOSTICS=1 \
bun test test/shell-sandbox-adversarial.test.ts
```

诊断模式记录命令、退出码、是否由外层 timeout 终止以及最多 500 字符 stderr，不记录传入环境变量值。

### 类型检查和上一轮回归

```bash
bun typecheck
./script/run-sandbox-integration.sh
```

类型检查退出码 0。上一轮脚本实际结果仍为基线 `23 pass`，真实集成 `23 pass / 1 skip`。

## 5. 用例结果

| 编号 | 测试项 | 阈值/步骤 | 实际结果 | 状态 | 退出码/证据 |
| --- | --- | --- | --- | --- | --- |
| ADV-001 | CPU 限制 | CPU=1 秒，死循环，外层 4 秒 | 约 1.1 秒被限制终止，非外层 timeout | PASS | 137，`timedOut=false` |
| ADV-002 | 内存限制 | AS=64 MiB，申请 96 MiB | Python 抛出 MemoryError | PASS | 1 |
| ADV-003 | 文件描述符 | nofile=32，最多打开 128 文件 | 捕获 errno 24 | PASS | 0，脚本按预期处理 EMFILE |
| ADV-004 | 短并发 | 5 个沙箱，各 sleep 0.1 秒 | 五个输出完整、均成功 | PASS | 全部 0 |
| ADV-005 | 有限重复 | 顺序启动 20 个短沙箱 | 20 次均成功 | PASS | 全部 0 |
| ADV-006 | 超时后台清理 | 后台 Python sleep 30 秒；300 ms 杀包装进程组并再观察 300 ms | 随机 marker 子进程仍存活；finally 已清理 | FAIL | wrapper 137；子进程 `/proc/<pid>/cmdline` 仍含 marker |
| ADV-007 | proc sysctl 只读 | 写 `/proc/sys/user/max_user_namespaces` | 写入失败 | PASS | 1，Read-only file system |
| ADV-008 | sys 隐藏 | 检查 `/sys` | 沙箱中不存在 | PASS | 0 |
| ADV-009 | 最小设备 | 使用 `/dev/null`，检查 kmsg/mem/sda | null 可用，危险设备不可见 | PASS | 0 |
| ADV-010 | 共享内存隔离 | 外层 `/dev/shm` marker，内层检查 | 内层不可见，外层内容未变 | PASS | 0 |
| ADV-011 | UTS 修改 | 通过 libc `sethostname` syscall | 权限拒绝 | PASS | 1，Operation not permitted |
| ADV-012 | 嵌套 userns | `unshare -Ur`，无 exploit payload | uid_map 因只读 `/proc` 无法写入 | PASS | 1，Read-only file system |
| ADV-013 | PID 可见性记录 | 检查 `/proc/1/status` | PID 1 元数据可读 | PASS（特征记录） | 0 |
| ADV-014 | 进程数限制记录 | 12 个 0.1 秒子进程 | 全部完成，当前无 per-sandbox nproc 限制 | PASS（特征记录） | 0 |
| ADV-015 | 硬链接读取逃逸 | 外部无敏感文件硬链接到 workspace 后读取 | 成功读取外部 inode 内容 | FAIL | 0，输出含 marker |
| ADV-016 | 硬链接写入逃逸 | 外部无敏感文件硬链接到 workspace 后写入 | 外部 inode 内容被修改 | FAIL | 0，外层内容变为 sandbox-change |

汇总：`13 PASS / 3 FAIL / 0 SKIP / 0 BLOCKED`。

## 6. 缺陷分析

### ADV-FIND-001：超时后后台子进程存活

生产 bwrap 参数包含 `--new-session`。外层 runner 已使用 detached 进程并对原始负进程组发送 SIGKILL，但新 session 中的标记子进程仍在 300 ms 观察点存活。`--die-with-parent` 不能替代“杀死 bwrap 自身时递归杀后代”的保证。

影响：超时命令可能继续消耗 CPU、内存或进程数，并继续访问已绑定 workspace。它仍处于已有 namespace 中，不等同于逃出文件系统或网络沙箱，但属于资源与生命周期隔离缺口。

建议：在真实 ShellTool/Shell.create 路径复现后，评估 cgroup-per-command、PID namespace init/reaper、可递归进程树终止或其他明确的进程所有权机制。不要仅依赖原始进程组。

### ADV-FIND-002：硬链接可跨 workspace 读取

bwrap 按路径 bind workspace，但硬链接是同一 inode 的另一个目录项。workspace 中预置硬链接后，沙箱访问 workspace 路径即可读取外部 fixture inode；符号链接逃逸测试通过并不能覆盖此场景。

影响取决于攻击者能否在沙箱启动前把同一文件系统上的外部 inode 硬链接进 workspace，以及该文件的所有权和系统 `protected_hardlinks` 策略。

### ADV-FIND-003：硬链接可跨 workspace 修改

通过 workspace 硬链接写入时，外部 fixture 内容从 `outside-original` 变为 `sandbox-change`。这是受控 fixture 上稳定复现的外部完整性影响。

建议在决定修复前确认 workspace 信任模型。候选方向包括：workspace 接纳阶段拒绝高链接数文件、让 workspace 与敏感外部文件处于不同文件系统、使用复制/overlay 边界，或限制能够在沙箱前创建硬链接的入口。扫描 inode/link count 存在竞态和兼容成本，不建议仅为测试变绿直接加入。

## 7. 其他安全观察

- `/proc/1/status` 可读，当前生产参数没有 `--unshare-pid`；这可能泄漏同容器进程元数据，但不属于上一轮已声明的 P0 验收项。
- `Prlimit.prepare` 没有 nproc 参数，Docker HostConfig 的 `PidsLimit` 也是 null；12 个有限子进程全部成功。真正进程耗尽测试仍未执行。
- 嵌套 user namespace 在本环境因只读 `/proc/self/uid_map` 失败，未运行任何 namespace exploit。
- CPU、内存、nofile、proc/sys、设备、共享内存和 UTS 边界在本轮阈值下均生效。

## 8. 清理与残留

失败测试同样执行 afterEach/finally：

- 精确杀死仍存活且 cmdline 包含随机 marker 的后台 PID；
- 删除唯一 workspace 和 outside fixture；
- 删除 `/dev/shm` marker；
- 最终扫描上述三类残留均无输出，计数为 0。

## 9. 未执行的真正破坏性项目

仍未运行真正 fork bomb、`rm -rf /`、无保护无限循环、长时间 CPU/内存满载、接近 8 GB 内存、10/20/50 长任务并发、数百次循环、内核漏洞利用、强杀关键服务、生产容量或长稳测试。这些项目需要带 PIDs/CPU/内存硬保险的一次性容器和明确审批阈值。

## 10. 本轮独立交付物

- `packages/core/test/shell-sandbox-adversarial.test.ts`
- `packages/core/test/lib/adversarial-sandbox-runner.ts`
- `packages/core/script/run-shell-sandbox-adversarial.sh`
- `docs/testing/shell-sandbox-adversarial-report.md`

推荐提交信息：

```text
test(core): add bounded sandbox adversarial coverage
```
