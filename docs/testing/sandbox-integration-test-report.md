# Shell 沙箱与资源隔离自动化测试报告

## 1. 结论

本轮在 `dataagent-repro` 中使用真实 bubblewrap 和 prlimit 完成测试：

- 既有基线：`23 pass / 0 fail`；
- 新增集成测试：`23 pass / 1 skip / 0 fail`；
- 合计：`46 pass / 1 skip / 0 fail`；
- `packages/core` 类型检查退出码为 0；
- 集成测试重复执行结果一致；
- 测试后 workspace fixture 与 `/tmp` marker 残留均为 0。

唯一 SKIP 是 Node.js 测试，原因是容器未安装 `node`。P0 范围没有发现产品功能缺陷。P1 中需要真实用户/会话所有权、Agent/Skill 入口或后台进程树观测的项目没有用普通目录伪造，标记为 BLOCKED。

## 2. 目标、范围与生产链路

目标是确认 Shell 命令经过生产沙箱策略后仍能完成正常开发任务，同时不能越过 workspace、网络、环境变量、capability、挂载、临时目录和资源边界。

新增测试不复制 bwrap 参数。它调用 `Sandbox.Service.prepare`，由生产代码调用 `Bwrap.prepare` 和 `Prlimit.prepare`，再启动返回的真实进程。既有 `tool-shell.test.ts` 验证所有普通 ShellTool 命令都会经过 Sandbox Service，并覆盖 ShellTool 输出、权限、超时和后台行为。

```text
ShellTool -> Shell.create -> Sandbox.Service.prepare
          -> Bwrap.prepare -> Prlimit.prepare -> Linux 子进程
```

当前证据链由“ShellTool 强制调用 Sandbox 的基线测试”和“Sandbox 到真实 bwrap/prlimit 子进程的集成测试”两部分组成。尚未新增一个包含完整 Session/Permission/PluginRuntime 图的 ShellTool-to-bwrap 单用例，该增强列入后续计划。

## 3. 源码状态

- WSL 主源码：`/home/test/project/opencode`
- 分支：`home-sandbox-dev`
- HEAD：`da503297b22336fc9612f2d4ce0c78e8b48899b5`
- 提交摘要：`fix(core): update home sandbox`
- 容器快照：`/srv/onto/dataagent/cubecode`
- 容器无 `.git`，Git 检查只在 WSL 执行。

测试前 `packages/core/src/sandbox/bwrap.ts` 有用户未提交修改：只读 roots 从 `[/usr, /usr/local, /bin, /sbin, /lib, /lib64, /etc]` 增加 `/proc`。本轮完整保留，没有覆盖或还原。生产代码仍未固定加入 `--disable-userns`、`--assert-userns-disabled` 或 `--proc /proc`。真实测试证明复用只读 `/proc` 后 bwrap 可启动，且 `/proc/net/*`、`/proc/self/status` 可用于隔离断言。

## 4. 环境和 Docker 配置

| 项目 | 实际值 |
| --- | --- |
| WSL | Ubuntu 22.04.5 LTS |
| WSL 内核 | Linux 6.18.33.2-microsoft-standard-WSL2 x86_64 |
| 容器/镜像 | `dataagent-repro` / `dataagent-sandbox-repro:0.1` |
| 容器系统 | openEuler 24.03 (LTS-SP1) |
| 用户 | ryoma，UID/GID 12100，附加组 1000 |
| Bun | 1.3.14 |
| Python | 3.11.6 |
| bubblewrap | 0.12.0，`/usr/local/bin/bwrap` |
| 兼容路径 | `/tmp/bwrap -> /usr/local/bin/bwrap` |
| prlimit | util-linux 2.39.1，`/usr/bin/prlimit` |
| cgroups | v2 (`cgroup2fs`) |
| Node.js | 未安装 |

`docker inspect` 的实际 HostConfig：`Privileged=false`；`CapDrop=[ALL]`，同时列出重新添加 `AUDIT_WRITE/CHOWN/DAC_OVERRIDE/FOWNER/SETGID/SETUID`；`seccomp=unconfined`、`apparmor=unconfined`；内存和 swap 均为 8,000,000,000 字节；CPU period/quota 为 `100000/800000`（约 8 核）；cgroup namespace private；网络 bridge；`PidsLimit=null`；`/proc/sys` 等由 Docker 设为只读；源码 volume 挂载到 `/srv/onto/dataagent/cubecode`。

外层容器没有 PID 上限且 seccomp/AppArmor 未约束，因此本轮不执行 fork bomb、内核利用或资源耗尽测试。真实沙箱内 `CapEff`、`CapBnd` 均为 0，mount 失败且网络隔离生效。

## 5. 实际执行命令

### Git 与用户改动检查

```bash
cd /home/test/project/opencode
git status
git diff -- packages/core/src/sandbox/bwrap.ts
```

### 同步源码（保留容器 node_modules）

```bash
cd /home/test/project/opencode
tar --exclude='./.git' --exclude='./node_modules' --exclude='*/node_modules' \
  --exclude='*/dist' --exclude='*/.turbo' -cf - . \
| docker exec -i dataagent-repro tar --no-same-owner -xf - \
    -C /srv/onto/dataagent/cubecode
```

### 基线、集成与类型检查

```bash
docker exec dataagent-repro bash -lc '
cd /srv/onto/dataagent/cubecode/packages/core
bun test test/sandbox-bwrap.test.ts test/tool-shell.test.ts
'

docker exec dataagent-repro bash -lc '
cd /srv/onto/dataagent/cubecode/packages/core
OPENCODE_RUN_SANDBOX_INTEGRATION=1 bun test test/sandbox-integration.test.ts
'

docker exec dataagent-repro bash -lc '
cd /srv/onto/dataagent/cubecode/packages/core
bun typecheck
'
```

基线实际退出码 0，`23 pass / 0 fail`、93 次 expect。集成实际退出码 0，`23 pass / 1 skip / 0 fail`、75 次 expect，最终耗时约 2.34 秒。类型检查 `tsgo -b tsconfig.json tsconfig.tests.json` 退出码 0。

一键重跑：

```bash
docker exec dataagent-repro bash -lc '
cd /srv/onto/dataagent/cubecode/packages/core
./script/run-sandbox-integration.sh
'
```

需要审计真实退出码和最多 500 字符 stderr 时：

```bash
OPENCODE_RUN_SANDBOX_INTEGRATION=1 \
OPENCODE_SANDBOX_TEST_DIAGNOSTICS=1 \
bun test test/sandbox-integration.test.ts
```

诊断模式不输出传入的临时环境变量值。未设置集成开关时，实际结果为 `0 pass / 24 skip / 0 fail`，并明确提示设置 `OPENCODE_RUN_SANDBOX_INTEGRATION=1`。

## 6. P0 结果

| 编号 | 优先级 | 测试项 | 步骤与预期 | 实际结果 | 状态 | 退出码/关键错误 |
| --- | --- | --- | --- | --- | --- | --- |
| SBX-P0-001 | P0 | 基线 | 运行既有两个文件，预期 23 pass | 23 pass，0 fail | PASS | 0 |
| SBX-P0-002 | P0 | 普通命令 | 真实 Sandbox 执行 echo/pwd/ls/cat | 输出、cwd、fixture 均正确 | PASS | 0 |
| SBX-P0-003 | P0 | Bash | 执行 workspace 脚本 | 输出正确 | PASS | 0 |
| SBX-P0-004 | P0 | Python | 创建、读取 workspace 文件 | 内容 `python-ok` 且保留 | PASS | 0 |
| SBX-P0-005 | P0 | Bun/TS | 执行带类型标注的脚本 | 输出和文件正确 | PASS | 0 |
| SBX-P0-006 | P0 | Node.js | 先检测真正 node 命令 | 未安装 Node.js | SKIP | 未启动 |
| SBX-P0-007 | P0 | workspace CRUD | 创建、读、改、删唯一文件 | 全部成功，删除后不存在 | PASS | 0 |
| SBX-P0-008 | P0 | 外部读取 | 读取专用无敏感 marker | 不可读、未泄漏内容 | PASS | 1；No such file |
| SBX-P0-009 | P0 | 外部写入 | 写专用外部目录 | 失败且外层目标不存在 | PASS | 1；No such file |
| SBX-P0-010 | P0 | 系统目录 | 写唯一 `/etc`、`/usr` 文件 | 均失败且未产生文件 | PASS | 1；Read-only file system |
| SBX-P0-011 | P0 | 路径穿越 | `../` 读取 sibling fixture | 不可越界 | PASS | 1；No such file |
| SBX-P0-012 | P0 | 符号链接 | workspace link 指向外部 | 目标不可读、原文件未变 | PASS | 1；No such file |
| SBX-P0-013 | P0 | 敏感变量 | 传入唯一假变量后 printenv | 不可见且假值未输出 | PASS | 0 |
| SBX-P0-014 | P0 | 必要变量 | 输出 PATH/HOME/TMPDIR | PATH 含 workspace bin；HOME=workspace；TMPDIR=/tmp | PASS | 0 |
| SBX-P0-015 | P0 | 公网 | 外层先连通 example.com:80，再从沙箱连接 | 外层可达、沙箱失败 | PASS | 1；socket.gaierror |
| SBX-P0-016 | P0 | 本地服务 | 外层 Bun 仅监听 127.0.0.1 并自检 | 沙箱连接拒绝；finally 关闭服务 | PASS | 1；Errno 111 |
| SBX-P0-017 | P0 | 网络 namespace | 读 `/proc/net/dev`、route | 仅 lo，无 eth 和默认路由 | PASS | 0 |
| SBX-P0-018 | P0 | capability | 读 `/proc/self/status` | CapEff=0，CapBnd=0 | PASS | 0 |
| SBX-P0-019 | P0 | mount | 尝试 64 KiB tmpfs mount | 被拒绝 | PASS | 32；must be superuser |
| SBX-P0-020 | P0 | Docker Socket | 检查存在性和可读性 | 不可见、不可读 | PASS | 0 |
| SBX-P0-021 | P0 | `/tmp` 隔离 | 外层 marker，内层读取 | 内层不可见；外层原文件仍在 | PASS | 1；No such file |
| SBX-P0-022 | P0 | `/tmp` 清理 | 内层写读，退出后外层检查 | 内层成功，外层不存在 | PASS | 0 |
| SBX-P0-023 | P0 | prlimit | OPEN_FILES=64 后 `ulimit -n` | 子进程为 64 | PASS | 0 |
| SBX-P0-024 | P0 | 短超时 | 250 ms 上限执行 `sleep 5` | 约 258 ms 终止 | PASS | 137，timedOut=true |
| SBX-P0-025 | P0 | 子进程继承 | Bash 启动 Python、Bun | HOME/tmp/capability 策略仍有效 | PASS | 0 |

P0 矩阵：`24 PASS / 0 FAIL / 1 SKIP / 0 BLOCKED`。

## 7. P1 结果

| 编号 | 测试项 | 处理结果 | 状态 | 原因/证据 |
| --- | --- | --- | --- | --- |
| SBX-P1-001 | 多入口一致性 | 未用直接函数冒充 Agent/Skill | BLOCKED | 需完整 Agent、Skill、Session 夹具 |
| SBX-P1-002 | Prompt 绕过 | 未调用不稳定外部模型 | BLOCKED | 需固定模型/离线 provider 与验收口径 |
| SBX-P1-003 | 后台任务 | 基线行为通过，未声称完成真实逃逸验证 | BLOCKED | 需真实 ShellTool 生命周期和 PID 标记夹具 |
| SBX-P1-004 | 超时孤儿清理 | 只验证有界 wall-clock 终止 | BLOCKED | 需批准 PID/cgroup 观测方式及等待窗口 |
| SBX-P1-005 | 用户隔离 | 未用普通目录模拟用户 | BLOCKED | 需真实 User A/B 所有权入口 |
| SBX-P1-006 | 会话隔离 | 未用普通目录模拟会话 | BLOCKED | 需真实 Session A/B 所有权入口 |
| SBX-P1-007 | 输出限制 | 既有小阈值字节/行数截断测试通过 | PASS | 基线退出码 0 |
| SBX-P1-008 | 文件大小 | 1 MiB 限制下尝试写 2 MiB | PASS | 1；Errno 27 File too large；文件不超过 1 MiB |

P1 矩阵：`2 PASS / 0 FAIL / 0 SKIP / 6 BLOCKED`。全矩阵评估为 `26 PASS / 0 FAIL / 1 SKIP / 6 BLOCKED`；这与测试框架的断言计数分开统计。

## 8. 安全与清理措施

- 每项测试最大 10 或 15 秒；真实进程默认另有 5 秒 kill 上限；短超时为 250 ms。
- 文件限制仅 1 MiB，只尝试一次 2 MiB 写入；没有大型文件。
- 本地服务仅监听 127.0.0.1，并在 finally 中关闭。
- fixture 和 marker 使用随机唯一名称；`afterEach` 只清理精确登记路径。
- 环境变量仅使用随机假变量；外部文件仅含无敏感 marker。
- `/etc`、`/usr` 使用此前不存在的随机目标，失败后从外层确认未创建。
- 最终扫描没有 `.sandbox-*` workspace 或 `opencode-sandbox-*` tmp 残留。

## 9. 未执行范围

未执行：真正 fork bomb、`rm -rf /`、无保护无限循环、大内存持续申请、长时间 CPU 满载、CPU/内存混合压力、10/20/50 并发、数百次循环、长稳、强杀关键服务、namespace/内核漏洞利用、性能与生产容量、用户/会话资源耗尽。没有接近 8 GB 分配，也没有创建大型文件。

## 10. 既有手工记录（不计入自动化统计）

需求方此前记录：bwrap 可启动；workspace 可写；`/etc` 只读；`/tmp` 隔离并自动消失；网络仅 lo、无默认路由且公网失败；外层变量不可见；CapEff/CapBnd 为 0；nofile=64 可继承。本轮已用自动化重新覆盖这些核心行为，但历史记录本身不计入 `46 pass / 1 skip`。

## 11. 问题、风险与后续确认

本轮没有发现可复现产品缺陷，也没有修改生产代码来让测试变绿。仍有四类覆盖缺口：完整 ShellTool-to-real-bwrap 单用例；后台/超时后的后代进程树；真实用户/会话所有权；Agent/Skill/Prompt 固定入口。

需要向领导确认：

1. 是否允许在设置 Docker `--pids-limit` 的一次性容器中做非 fork-bomb 小阈值进程测试。
2. CPU、内存、进程数、文件大小的审批阈值、timeout 和最长持续时间。
3. 是否批准并发、混合压力、数百次循环、稳定性和性能容量测试及其隔离环境。
4. 用户/会话隔离应调用哪些真实 API、身份 fixture 和所有权规则。
5. Agent、Skill、Prompt 绕过应使用哪个固定模型或离线 provider。
6. 后台和孤儿清理是否允许读取 `/proc`/cgroup，观察窗口多久。
7. 公网前置探测继续用 `example.com:80`，还是改为组织控制的端点。
8. 生产 Docker 的 unconfined seccomp/AppArmor，以及 CapDrop 后重加六项 capability 是否为有意配置。

建议下一阶段先构建完整 Location/Session/Permission/PluginRuntime 测试层；再在有 PIDs 外层保险的一次性容器验证后台进程树；取得真实所有权 fixture 后补用户/会话测试；最后按审批阈值分阶段加入低负载资源与并发测试。在安装 Node.js 的同版本镜像中补跑 Node，不在当前容器安装软件。

## 12. 交付文件

- `packages/core/test/sandbox-integration.test.ts`：24 个集成测试，含开关、超时、唯一 fixture、诊断与清理。
- `packages/core/script/run-sandbox-integration.sh`：一键执行基线和集成测试。
- `docs/testing/sandbox-integration-test-report.md`：本报告。
- `packages/core/src/sandbox/bwrap.ts`：用户原有未提交修改，本轮未改写。

推荐提交信息：

```text
test(core): add sandbox integration coverage
```
