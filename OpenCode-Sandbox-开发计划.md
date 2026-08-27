# OpenCode v2 脚本沙箱 MVP 开发计划

## 1. 当前开发目标

当前开发环境是 **Windows**。

本次任务只要求：

```text
在 Windows 上完成 OpenCode v2 的沙箱代码开发
+
完成能够在 Windows 上执行的功能验证
```

本次不负责：

```text
Linux 服务器部署
Linux 编译
真实 Bubblewrap namespace 验证
服务器环境排障
Linux 最终验收
```

这些内容不属于当前开发计划。

---

# 2. MVP 目标

只实现：

```text
OpenCode Agent
    ↓
Python / TypeScript 脚本
    ↓
Sandbox 逻辑
    ↓
Bubblewrap PreparedProcess
```

必须完成：

- Python：`python3`
- TypeScript：优先 `bun`
- `/workspace`：项目目录，只读
- `/work`：session 可写目录
- `/tmp`：沙箱临时目录
- 默认关闭网络
- 环境变量清理
- 复用 OpenCode timeout
- Bubblewrap 执行失败时 fail closed
- ShellTool 中明显 Python / TS 调用不能简单绕过

Windows 上主要验证：

```text
Sandbox 路由
目录和路径映射
bwrap argv 构造
direct process 执行链
timeout
错误处理
fail closed
```

---

# 3. 本次明确不做

不要实现：

```text
PID namespace
--unshare-pid
/proc mount
/proc isolation
CPU / Memory limit
cgroup v2
复杂 seccomp
完整 production rootfs
严格 Linux command allowlist
复杂网络白名单
所有 Shell command 全量 sandbox
```

完成 MVP 后停止。

---

# 4. OpenCode v2 重点调用链

先按当前 `v2` 实际源码确认：

```text
Agent
  ↓
packages/core/src/tool/plugin/shell.ts
  ↓
Shell.Service.create(...)
  ↓
packages/core/src/shell.ts
  ↓
Environment.Service.spawner.spawn(...)
  ↓
Process
```

重点阅读：

```text
packages/core/src/tool/plugin/shell.ts
packages/core/src/shell.ts
packages/core/src/shell/parse.ts
packages/core/src/plugin/internal.ts
packages/core/src/environment/*
packages/core/src/permission.ts
packages/core/src/location-mutation.ts
```

原则：

- `shell.ts`：继续复用 timeout、stdout/stderr、process lifecycle
- `shell/parse.ts`：识别明显 Python / TypeScript 调用
- `internal.ts`：注册 ScriptTool
- Environment / Permission / LocationMutation：优先复用，不大改

---

# 5. 推荐架构

```text
                        OpenCode Agent
                             │
               ┌─────────────┴─────────────┐
               │                           │
               ▼                           ▼
           ScriptTool                  ShellTool
               │                           │
               │                           ▼
               │                    Sandbox Router
               │                     │          │
               │                Python/TS      其他命令
               │                     │          │
               │                     │          ▼
               │                     │      原 Shell 执行
               │                     │
               └─────────────┬───────┘
                             ▼
                         Sandbox
                             │
                    ┌────────┴────────┐
                    │                 │
                    ▼                 ▼
              Workspace准备       Bwrap构造
                    │                 │
                    └────────┬────────┘
                             ▼
                   PreparedProcess
                             │
                             ▼
                     Shell.Service
```

含义：

- `ScriptTool`：默认就是沙箱脚本入口，直接走 Sandbox
- `ShellTool`：先经过 Router，只把明显 Python / TS 调用送进 Sandbox
- `Workspace`：负责目录、路径、session work
- `Bwrap`：负责生成 `bwrap + argv[]`

---

# 6. 文件改动

## 新增

```text
packages/core/src/sandbox/types.ts
packages/core/src/sandbox/workspace.ts
packages/core/src/sandbox/bwrap.ts
packages/core/src/sandbox/router.ts
packages/core/src/sandbox/service.ts
packages/core/src/tool/plugin/script.ts
```

如果实际代码风格不需要 `service.ts`，可以适当合并。

## 修改

```text
packages/core/src/shell.ts
packages/core/src/shell/parse.ts
packages/core/src/tool/plugin/shell.ts
packages/core/src/plugin/internal.ts
```

## 原则上只读

```text
packages/core/src/environment/*
packages/core/src/permission.ts
packages/core/src/location-mutation.ts
```

---

# 7. Workspace 设计

目录模型：

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

session host 目录：

```text
<workRoot>/<sessionID>/work
```

脚本路径必须限制在 project 内。

拒绝：

```text
../ 路径逃逸
project 外 absolute path
任意外部目录自动 mount
```

Windows 开发时要注意：

```text
host path 使用 Windows 路径
sandbox target 始终使用 POSIX 路径
```

例如：

```text
D:\project\repo
```

映射目标仍然是：

```text
/workspace
```

不要用 Windows `path.join()` 生成 sandbox 内路径。

---

# 8. Bubblewrap Builder

`bwrap.ts` 只负责：

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
  ...必要 runtime mounts... \
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

# 9. Shell Service 改造

OpenCode 已有：

```text
timeout
stdout/stderr
process lifecycle
cleanup
```

继续复用。

增加最小 direct process seam，例如：

```ts
interface PreparedProcess {
  executable: string
  args: string[]
  cwd: string
  env: Record<string, string>
}
```

普通 Shell 保持原逻辑。

Sandbox：

```text
executable = bwrap
args = bwrapArgs
```

禁止：

```bash
/bin/sh -lc "bwrap ..."
```

禁止拼接一整条 shell command string。

---

# 10. ScriptTool

新增：

```text
packages/core/src/tool/plugin/script.ts
```

MVP input：

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
python     -> python3
typescript -> bun
```

默认：

```text
workspace = readonly
network = false
```

不要增加大量高级选项。

---

# 11. Shell Router

MVP 至少识别：

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

同时测试：

```bash
echo python
grep python README.md
```

不能误判。

复杂 Shell 语法本次不继续扩展。

---

# 12. Windows 功能验证方案

Windows 不需要真正运行 Bubblewrap。

本次必须完成下面这些验证。

## 12.1 Bwrap argv builder 单测

把参数构造做成可独立测试的纯逻辑。

断言生成：

```text
--unshare-net
--clearenv
--ro-bind <project> /workspace
--bind <session> /work
--tmpfs /tmp
--chdir /workspace
--
python3 / bun
```

同时断言不存在：

```text
--unshare-pid
--proc
--bind / /
```

---

## 12.2 Workspace / path 单测

使用 Windows temp directory 测试：

```text
session work 创建
同 session 路径稳定
不同 session 路径隔离
script path 映射
../ escape reject
project 外 path reject
```

重点验证 Windows host path 到 sandbox POSIX path 的映射。

---

## 12.3 Router 单测

测试：

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

预期：

```text
进入 sandbox
```

误报测试：

```bash
echo python
grep python README.md
```

预期：

```text
不进入 sandbox
```

---

## 12.4 Direct Process 测试

Windows 没有 bwrap，但可以测试新增的：

```text
executable + argv[]
```

执行链。

优先使用当前环境已有的：

```text
bun
node
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
process cleanup
```

这样验证：

```text
PreparedProcess
   ↓
Shell.Service
   ↓
Environment spawner
```

这条链是否正确。

---

## 12.5 Fake Spawner / FakeBwrap

优先通过依赖注入或测试 Layer 替换：

```text
Environment.Service.spawner
```

而不是模拟 Linux namespace。

Fake spawner 需要覆盖：

```text
记录 executable
记录 args
返回 stdout
返回 stderr
返回非零 exit
模拟 spawn error
模拟长时间运行
```

必须验证：

```text
bwrap spawn error
    ↓
Sandbox error
```

不能发生：

```text
第二次普通 host execution
```

---

## 12.6 Environment policy 单测

给 Sandbox Service 输入含敏感变量的 host env。

验证 PreparedProcess 中只保留：

```text
PATH
HOME
TMPDIR
LANG
```

或当前明确 allowlist。

确认：

```text
SANDBOX_SECRET_SENTINEL
API_KEY
TOKEN
```

不会进入 sandbox env。

---

# 13. 开发顺序

```text
Phase 0  确认源码调用链
Phase 1  types + workspace + bwrap builder
Phase 2  Windows builder/path 单测
Phase 3  Shell direct-process seam
Phase 4  Windows direct-process/fake-spawner 测试
Phase 5  Python + TypeScript ScriptTool
Phase 6  Shell Router
Phase 7  Windows typecheck/tests/lint/diff review
```

Phase 7 完成后，本次任务结束。

---

# 14. Windows 验收标准

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
env policy tests PASS
```

真实 Bubblewrap namespace 隔离不属于本次验收范围。

---

# 15. 禁止事项

```text
1. 因 Windows 无 bwrap 就增加生产 host fallback
2. 把普通 Windows process 当成真实 sandbox
3. bwrap failure 后 host execution
4. 添加 --unshare-pid
5. 挂载 /proc
6. 实现 CPU/Memory/cgroup
7. 重写 Shell lifecycle
8. ScriptTool 拼 shell command string
9. 完整透传 process.env
10. 默认 --bind / /
11. 大范围无关重构
12. 修改无关文件
```

---

# 16. MVP 完成标准

- [ ] Python ScriptTool 代码路径完成
- [ ] TypeScript/Bun ScriptTool 代码路径完成
- [ ] `/workspace` / `/work` / `/tmp` mount 参数正确
- [ ] workspace/path 映射单测通过
- [ ] Shell Router 单测通过
- [ ] direct process 测试通过
- [ ] FakeSpawner/FakeBwrap 测试通过
- [ ] timeout 测试通过
- [ ] env 清理测试通过
- [ ] bwrap spawn error fail closed
- [ ] 无 PID namespace
- [ ] 无 `/proc`
- [ ] 无 CPU/Memory/cgroup
- [ ] 无无关大重构

完成以上内容后停止。
