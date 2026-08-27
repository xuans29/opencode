# OpenCode Sandbox 相对 v2 分支文件变更总结

## 1. 对比基线

当前 `HEAD` 与 `v2` 均为：

```text
1ce7e90d3e
```

因此，本文列出的内容均为当前工作区相对于 `v2` 分支的未提交改动。

## 2. 修改的原有文件

共修改 6 个原有文件。

### 2.1 `packages/core/src/location-services.ts`

- 将 `Sandbox.node` 注册到 Location 级服务依赖图。
- 使每个 Location 都能取得对应的 Sandbox Service。

### 2.2 `packages/core/src/plugin/internal.ts`

- 注入 `Sandbox.Service`。
- 将 `Sandbox.node` 加入内置插件依赖。
- 注册新增的 `ScriptTool.Plugin`。
- 使模型可以调用新的 `script` 工具。

### 2.3 `packages/core/src/shell.ts`

- 新增 `createProcess` 直接进程入口。
- 支持通过以下结构启动进程：

```text
executable + argv[] + cwd + env
```

- Sandbox 可以直接执行 `bwrap` 及其参数，不需要拼接 Shell 命令字符串。
- 继续复用原有 Shell Service 的：
  - stdout/stderr 捕获；
  - 输出文件保存；
  - 退出码处理；
  - timeout；
  - 进程终止和清理；
  - Shell 生命周期事件。

### 2.4 `packages/core/src/tool/plugin/shell.ts`

- 在 ShellTool 中接入 `SandboxRouter` 和 `Sandbox.Service`。
- 对明确的 Python、Bun、Node 脚本命令进行路由。
- 被识别的脚本命令通过 Bubblewrap PreparedProcess 执行。
- 普通 Shell 命令保持原有执行路径。
- 继续执行原有工作目录解析和权限检查。
- Bubblewrap 启动失败时直接返回 Sandbox 错误，不回退到宿主机执行。

### 2.5 `packages/core/test/location-layer.test.ts`

- 更新内置工具清单预期。
- 在 Location 工具隔离测试中加入新增的 `script` 工具。

### 2.6 `packages/core/test/tool-shell.test.ts`

- 增加 PreparedProcess 直接执行测试。
- 增加 stdout、stderr 和非零退出码测试。
- 增加直接进程 timeout 和清理测试。
- 增加 FakeSpawner/FakeBwrap 测试。
- 增加 Bubblewrap spawn error 的 fail-closed 测试。
- 验证失败后不会再次尝试普通宿主机执行。
- 增加敏感环境变量过滤测试。
- 增加 ShellTool 脚本路由和误报测试。
- 验证 `ScriptTool` 已完成注册。

## 3. 新增的生产代码文件

共新增 6 个生产代码文件。

### 3.1 `packages/core/src/sandbox/types.ts`

定义 Sandbox 公共类型：

- `Language`：支持 `python` 和 `typescript`；
- `PreparedProcess`：直接进程启动参数；
- `Workspace`：Host 与 Sandbox 工作目录映射结果；
- `Sandbox.Error`：统一 Sandbox 错误。

### 3.2 `packages/core/src/sandbox/workspace.ts`

负责准备 Sandbox Workspace：

- 解析项目真实路径；
- 创建稳定的 Session 工作目录；
- 相同 Session 使用相同工作目录；
- 不同 Session 使用隔离工作目录；
- 校验脚本和工作目录必须位于项目内；
- 拒绝 `../` 路径逃逸；
- 拒绝项目外绝对路径；
- 将 Windows Host 路径映射为 Sandbox POSIX 路径；
- 将项目内路径映射到 `/workspace/...`。

Session 工作目录结构为：

```text
<workRoot>/<sessionID>/work
```

### 3.3 `packages/core/src/sandbox/bwrap.ts`

负责将 Sandbox 请求构造成 Bubblewrap `PreparedProcess`。

主要参数包括：

```text
--die-with-parent
--new-session
--unshare-net
--clearenv
--ro-bind <project> /workspace
--bind <session-work> /work
--tmpfs /tmp
--dev /dev
--chdir <sandbox-workdir>
```

运行时映射：

```text
python     -> /sandbox/bin/python3
typescript -> /sandbox/bin/bun
```

明确不包含：

```text
--unshare-pid
--proc
--bind / /
```

PreparedProcess 环境变量只保留明确允许的项目：

```text
PATH
HOME
TMPDIR
LANG
```

### 3.4 `packages/core/src/sandbox/router.ts`

负责识别明显的 Python 和 TypeScript/JavaScript 脚本命令。

支持识别：

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

不会误判：

```bash
echo python
grep python README.md
python -c 'print(1)'
python a.py && echo done
```

Router 返回语言、脚本路径和独立参数数组，不拼接新的 Shell 命令字符串。

### 3.5 `packages/core/src/sandbox/service.ts`

负责串联整个 Sandbox 执行流程：

```text
Sandbox Request
  -> Workspace.prepare
  -> 查找 python3/bun 运行时
  -> SandboxBwrap.build
  -> Shell.createProcess
  -> Environment spawner
```

主要行为：

- 使用 Location 目录作为项目根目录；
- 使用 Global data 目录保存 Session Sandbox 工作目录；
- 查找 Python3 或 Bun 运行时；
- 构造 Bubblewrap PreparedProcess；
- 通过 Shell Service 的直接进程入口启动；
- 将进程启动错误映射为 `Sandbox.Error`；
- Bubblewrap 执行失败时保持 fail closed。

### 3.6 `packages/core/src/tool/plugin/script.ts`

新增模型侧 `script` 工具。

输入结构：

```json
{
  "language": "python",
  "script": "scripts/test.py",
  "args": [],
  "workdir": ".",
  "timeout": 120000
}
```

TypeScript 示例：

```json
{
  "language": "typescript",
  "script": "scripts/test.ts"
}
```

主要行为：

- Python 映射到 `python3`；
- TypeScript 映射到 `bun`；
- 默认 timeout 为 120000 毫秒；
- 执行前进行 `script` 权限检查；
- 通过 Sandbox Service 执行；
- 返回输出、退出码、timeout 和截断信息；
- 中断时清理对应 Shell 进程。

## 4. 新增的测试文件

共新增 3 个测试文件。

### 4.1 `packages/core/test/sandbox-bwrap.test.ts`

验证内容：

- Python 和 Bun 运行时映射；
- `/workspace`、`/work` 和 `/tmp` 参数；
- Windows Host 路径保持为 Windows 路径；
- Sandbox Target 始终使用 POSIX 路径；
- `--unshare-net`；
- `--clearenv`；
- 环境变量白名单；
- 不包含 PID namespace、`/proc` 和根目录绑定。

### 4.2 `packages/core/test/sandbox-router.test.ts`

验证内容：

- Python、Python3、Bun、Node 路由；
- `/usr/bin/python3` 路由；
- `env` 包装命令路由；
- `bash -c` 和 `sh -c` 路由；
- 脚本参数保留；
- 普通文本命令不会被误报；
- 复杂 Shell 组合命令不会进入 Sandbox。

### 4.3 `packages/core/test/sandbox-workspace.test.ts`

验证内容：

- Session 工作目录创建；
- 相同 Session 路径稳定；
- 不同 Session 路径隔离；
- Windows Host 路径到 POSIX Sandbox 路径映射；
- 脚本路径映射；
- `../` 路径逃逸拒绝；
- 项目外绝对路径拒绝。

## 5. 文件数量汇总

| 类型 | 数量 |
| --- | ---: |
| 修改的原有生产文件 | 4 |
| 修改的原有测试文件 | 2 |
| 新增生产代码文件 | 6 |
| 新增测试文件 | 3 |
| 代码文件合计 | 15 |

## 6. 相对 v2 的 Git Diff 统计

当前已跟踪文件的 Diff 统计为：

```text
6 files changed, 486 insertions(+), 103 deletions(-)
```

该统计不包含 Git 尚未跟踪的 9 个新增生产代码及测试文件。

## 7. 未计入沙箱实现的文件

以下 Markdown 文件是需求、计划或分析资料，不计入上述 15 个沙箱代码文件：

```text
OpenCode-Sandbox-CodingAgent提示词.md
OpenCode-Sandbox-开发计划.md
tool-sandbox-modified-files-analysis.md
OpenCode-Sandbox-v2文件变更总结.md
```

