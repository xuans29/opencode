# OpenCode v2 Bubblewrap 脚本沙箱 MVP：Coding Agent 提示词

当前开发环境是 **Windows**。

本次任务只要求：

```text
完成 OpenCode v2 沙箱代码开发
+
完成 Windows 上可以执行的功能验证
```

不要处理：

```text
Linux 服务器上传
Linux 编译
Linux 部署
真实 Bubblewrap namespace 验收
服务器环境排障
```

这些都不属于本次任务。

---

## 1. 本次唯一目标

实现：

```text
Python     -> python3 -> Bubblewrap PreparedProcess
TypeScript -> bun     -> Bubblewrap PreparedProcess
```

目录模型：

```text
/workspace = project，只读
/work      = session 可写目录
/tmp       = 临时目录
```

同时：

```text
默认关闭网络
环境变量清理
复用 OpenCode timeout
bwrap 执行失败 fail closed
ShellTool 常见 Python/TS 调用不能简单绕过
```

---

## 2. 本次明确不做

禁止实现：

```text
PID namespace
--unshare-pid
/proc mount
/proc isolation
CPU / Memory
cgroup v2
复杂 seccomp
完整 production rootfs
严格 command allowlist
所有 Shell 全量 sandbox
```

完成 MVP 后停止。

---

## 3. 先确认源码

执行：

```bash
git branch --show-current
git status --short
git log -1 --oneline
```

不要 reset / restore 用户已有修改。

阅读：

```text
packages/core/src/tool/plugin/shell.ts
packages/core/src/shell.ts
packages/core/src/shell/parse.ts
packages/core/src/plugin/internal.ts
packages/core/src/environment/*
packages/core/src/permission.ts
packages/core/src/location-mutation.ts
```

确认：

```text
Shell.Service.create
shell.create.before
Environment.Service.spawner.spawn
ChildProcess.make
ShellParse.scan
ShellSelect.args
```

修改前只简短汇报：

```text
当前调用链
真正 spawn 位置
新增文件
修改文件
```

然后继续开发。

不要输出长篇设计说明。

实际 `v2` 源码与提示词不一致时，以真实源码为准。

---

## 4. 推荐文件

新增：

```text
packages/core/src/sandbox/types.ts
packages/core/src/sandbox/workspace.ts
packages/core/src/sandbox/bwrap.ts
packages/core/src/sandbox/router.ts
packages/core/src/sandbox/service.ts
packages/core/src/tool/plugin/script.ts
```

主要修改：

```text
packages/core/src/shell.ts
packages/core/src/shell/parse.ts
packages/core/src/tool/plugin/shell.ts
packages/core/src/plugin/internal.ts
```

尽量不要重构 Environment / Permission / LocationMutation。

---

## 5. Workspace

固定：

```text
host project
    ↓ --ro-bind
/workspace

host session work
    ↓ --bind
/work

tmpfs
    ↓
/tmp
```

要求：

```text
/workspace RO
/work RW
/tmp RW
```

脚本只能位于 project 内。

拒绝：

```text
../ escape
project 外 absolute path
任意外部目录自动 mount
```

Windows 开发时：

```text
host path 使用 Windows path
sandbox path 始终使用 POSIX path
```

例如：

```text
D:\repo\project
```

sandbox target：

```text
/workspace
```

不要用 Windows `path.join()` 生成 sandbox 内路径。

---

## 6. Bwrap Builder

`bwrap.ts` 只做：

```text
SandboxRequest
    ↓
bwrap argv[]
    ↓
PreparedProcess
```

参数大致：

```bash
bwrap \
  --die-with-parent \
  --new-session \
  --unshare-net \
  --clearenv \
  ...runtime mounts... \
  --ro-bind "$PROJECT" /workspace \
  --bind "$SESSION_WORK" /work \
  --tmpfs /tmp \
  --dev /dev \
  --setenv PATH /sandbox/bin \
  --setenv HOME /work \
  --setenv TMPDIR /tmp \
  --setenv LANG C.UTF-8 \
  --chdir /workspace \
  -- \
  /sandbox/bin/python3 script.py
```

TypeScript：

```text
--
/sandbox/bin/bun script.ts
```

硬性要求：

```text
不要 --unshare-pid
不要 --proc
不要 --bind / /
```

---

## 7. Shell Service

继续复用：

```text
timeout
stdout/stderr
process lifecycle
cleanup
```

增加最小 direct-process seam，例如：

```ts
interface PreparedProcess {
  executable: string
  args: string[]
  cwd: string
  env: Record<string, string>
}
```

Sandbox：

```text
spawn(bwrap, bwrapArgs)
```

禁止：

```bash
/bin/sh -lc "bwrap ..."
```

禁止拼整条 shell string。

---

## 8. ScriptTool

新增：

```text
packages/core/src/tool/plugin/script.ts
```

MVP schema：

```json
{
  "language": "python",
  "script": "scripts/test.py",
  "args": [],
  "workdir": ".",
  "timeout": 120000
}
```

TypeScript：

```json
{
  "language": "typescript",
  "script": "scripts/test.ts"
}
```

映射：

```text
python -> python3
typescript -> bun
```

默认：

```text
workspace readonly
network false
```

不要增加高级 policy 参数。

---

## 9. Shell Router

至少识别：

```bash
python test.py
python3 test.py
/usr/bin/python3 test.py
bun test.ts
node test.js
env python test.py
bash -c 'python test.py'
sh -c 'node test.js'
```

尽量复用 `ShellParse`。

误报测试：

```bash
echo python
grep python README.md
```

不能进入 sandbox。

复杂 Shell 语法本次不继续扩展。

---

## 10. Windows 测试要求

Windows 不要求真正执行 `bwrap`。

必须完成以下测试。

### A. Builder

纯单测断言生成：

```text
--unshare-net
--clearenv
--ro-bind <project> /workspace
--bind <session> /work
--tmpfs /tmp
--chdir /workspace
正确 runtime
```

并断言不存在：

```text
--unshare-pid
--proc
--bind / /
```

### B. Workspace / Path

使用 Windows temp directory 测试：

```text
session work 创建
同 session 路径稳定
不同 session 隔离
script path 映射
../ escape reject
project 外 path reject
```

### C. Router

测试所有常见 Python / TS command 和误报 case。

### D. Direct Process

Windows 上使用已有：

```text
bun
node
```

测试新的：

```text
executable + argv[]
```

例如：

```text
bun -e "console.log('direct-process-ok')"
```

验证：

```text
stdout
stderr
exit code
timeout
cleanup
```

### E. Fake Spawner / FakeBwrap

优先通过测试 Layer / dependency injection 替换：

```text
Environment.Service.spawner
```

Fake 需要支持：

```text
记录 executable
记录 args
模拟 stdout
模拟 stderr
模拟 non-zero exit
模拟 spawn error
模拟 timeout
```

必须验证：

```text
bwrap spawn error
    ↓
Sandbox error
```

不能发生第二次普通执行。

### F. Env Policy

输入带：

```text
SANDBOX_SECRET_SENTINEL
API_KEY
TOKEN
```

验证 PreparedProcess env 中不存在这些变量。

只保留明确 allowlist。

---

## 11. 开发顺序

严格执行：

```text
Phase 0  源码确认
Phase 1  types/workspace/bwrap builder
Phase 2  Windows builder/path tests
Phase 3  Shell direct-process seam
Phase 4  direct-process/fake-spawner tests
Phase 5  Python + TypeScript ScriptTool
Phase 6  Shell Router
Phase 7  Windows typecheck/tests/lint/diff review
```

Phase 7 完成后任务结束。

不要增加额外阶段。

---

## 12. 每个 Phase 完成后

执行：

```bash
git diff --check
git status --short
```

运行该阶段相关测试。

最终执行当前 `v2` 仓库真实存在的：

```text
core tests
typecheck
lint
```

如果某个测试与 Windows 平台不兼容：

```text
明确标记 platform-specific skip
```

不要通过修改生产逻辑绕过。

---

## 13. 硬性禁止

```text
1. 因 Windows 无 bwrap 增加 host fallback
2. 把 Windows 普通进程称为真实 sandbox
3. bwrap failure 后 host execution
4. --unshare-pid
5. /proc mount
6. CPU/Memory/cgroup
7. 重写 Shell lifecycle
8. ScriptTool 拼 shell command string
9. 完整透传 process.env
10. 默认 --bind / /
11. 大范围无关重构
12. 修改无关文件
13. 自动 push / merge / reset
```

---

## 14. Windows 最终验收

必须达到：

```text
typecheck PASS
builder tests PASS
workspace/path tests PASS
router tests PASS
direct-process tests PASS
fake-spawner tests PASS
timeout tests PASS
fail-closed tests PASS
env-policy tests PASS
```

真实 Bubblewrap 隔离不属于本次任务验收范围。

---

## 15. 最终汇报

只简洁输出：

```text
1. 修改文件
2. 核心实现
3. Windows 已执行测试及结果
4. platform-specific skip
5. git diff --stat
6. git status --short
```

不要输出 Linux 后续操作。

不要给 Linux 部署步骤。

不要给服务器测试清单。

完成后停止。
