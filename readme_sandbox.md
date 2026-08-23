# OpenCode 沙箱功能说明

本文说明沙箱功能相对 `v2` 基线的设计与实现、项目运行方式，以及后续二次开发的主要入口和约束。

> [!IMPORTANT]
> 生成本文时，本地 `sandbox-feature` 与 `v2` 指向同一个提交 `1ce7e90d3e`，两者没有已提交的 Git 差异。因此，本文以工作区相对 `v2` 的实际差异为总结口径；将这些改动提交到 `sandbox-feature` 后，本文内容即成为该分支相对 `v2` 的正式差异说明。

## 一、功能改动概览

这次改动把模型发起的代码执行从宿主机进程迁移到一次性 Linux 容器，并增加了脚本执行、执行策略校验、文件路径防护和工具输出归档保护。

核心执行链路如下：

```text
模型调用 shell/script
        ↓
工具注册与执行策略校验
        ↓
权限规则检查
        ↓
工作目录规范化与边界检查
        ↓
Docker/Podman 一次性容器
        ↓
输出截断、归档和 Session 访问控制
```

### 1. 模型侧 `shell` 改为容器沙箱执行

- 模型调用的 `shell` 不再直接启动宿主机 Shell，而是固定通过容器内的 `/bin/sh -lc` 执行。
- 每次调用创建一个全新的一次性容器，执行完成或失败后清理。
- 当前项目 Location 以读写方式挂载到容器内 `/workspace`。
- `cwd` 必须位于当前项目内部；沙箱 Shell 不再支持访问外部目录。
- 宿主机环境变量不会传入容器，并显式清空常见代理变量。
- 容器无网络、无 IPC 共享，根文件系统只读；运行用户为非 root，删除全部 Linux capabilities，并启用 `no-new-privileges`。
- 旧的模型侧后台 Shell 作业能力被移除。后台进程即使由命令启动，也不能越过一次性容器的生命周期和整体超时。
- 顶层配置中的 `shell` 现在只影响 PTY 和 Shell HTTP/API 等宿主机执行面，不再改变模型侧 Shell；模型侧始终使用容器内 `/bin/sh`。
- 沙箱不可用、镜像不存在、配置非法、队列满或功能被禁用时，工具调用直接失败，不会回退到宿主机执行，即“失败关闭”。

### 2. 新增 `script` 工具

新增内置 `script` 工具，可在同一沙箱边界内执行：

- Python：通过 `python3 -` 从标准输入接收源码；
- TypeScript：源码先写入容器 `/tmp`，再通过 `bun --no-install --no-env-file run` 执行；
- 支持参数数组、项目内相对工作目录和单次超时；
- 默认及最大单次超时均为 120 秒；
- 不向模型暴露网络、后台运行、自定义镜像、CPU 或内存覆盖参数；
- 执行前按语言申请 `script` 权限，资源值为 `python` 或 `typescript`。

### 3. 新增统一沙箱服务

`packages/core/src/sandbox.ts` 提供 Docker/Podman 运行服务，主要负责：

- 容器运行时可用性检查和镜像只使用本地版本（`--pull=never`）；
- 项目目录、工作目录、镜像名、容器名、UID/GID 和输入参数校验；
- 防止挂载文件系统根目录、OpenCode 管理目录以及管理员声明范围之外的工作区；
- 限制 CPU、内存和 swap、进程数、文件描述符、core dump、单文件大小、`/tmp` 大小、输入和输出大小；
- 为全服务和单个 Session 分别提供并发数与排队数上限；
- 对排队和执行使用统一硬截止时间，超时后强制清理容器；
- 使用 Session ID 哈希写入容器标签，避免在运行时元数据中暴露原始 Session ID；
- 对异常终止遗留的容器使用稳定标签，便于运维侧识别和清理。

默认沙箱镜像位于 `infra/sandbox/Dockerfile`，基于 Bun 1.3.14 Debian 镜像，预装 `git`、`jq`、`python3` 和 `ripgrep`。

### 4. 增加工具执行策略与注册保护

新增 `ToolExecutionPolicy`，显式区分宿主机工具和沙箱工具：

- `shell`、`script` 是受保护的工具名；
- 受保护名称不能注册为普通宿主机工具；
- 沙箱工具必须直接注册、工具名与沙箱 profile 一致，并关闭 CodeMode 包装；
- 沙箱来源标记绑定到原始工具对象，简单复制对象不能继承沙箱可信来源；
- 工具执行时记录执行目标和沙箱 profile，便于追踪和审计。

这可以防止插件或后续重构无意中用同名宿主机实现覆盖受保护工具，造成执行边界降级。

### 5. 权限策略调整

- 默认 build agent 对 `shell` 和 `script` 均使用 `ask`，执行前需要权限决策。
- Plan agent 明确禁止 `shell`、`script` 和 `subagent`，仍只允许修改计划目录中的文件。
- `shell` 权限继续依据解析到的命令资源进行判断；`script` 权限按所选语言判断。
- 权限允许只代表本次操作被批准，不代表工作区内文件变为安全或只读。

### 6. 文件路径与符号链接防护

文件操作链路现在同时保留词法绝对路径和规范化路径：

- 解析已有符号链接或 Windows junction 后再判断目标是否位于项目内；
- 读、写、编辑、补丁、搜索和格式化统一使用规范化目标；
- 写入和删除支持 `expectedCanonical` 守卫，在实际变更前重新确认目标没有被替换到其他路径；
- 文件变更按规范化路径加锁，降低别名路径绕过互斥的风险；
- 外部目录权限依据规范化后的真实目标计算。

这些改动主要防止通过符号链接、junction 或路径在校验与写入之间发生变化而绕过目录权限。

### 7. 工具输出归档与访问隔离

长工具输出仍会在发送给模型前截断，但归档逻辑得到加强：

- 默认模型可见上限为 2,000 行或 50 KiB；
- 截断后的完整内容会写入 OpenCode 管理的 `tool-output` 目录；
- 单个归档默认最多 10 MiB，超过时只保存受限前缀并在结果元数据中标明归档不完整；
- 全局最多 256 个文件、256 MiB；单个 Session 最多 32 个文件、32 MiB；
- 归档默认保留 7 天，每小时清理过期文件，并按最旧优先执行配额回收；
- 归档文件名包含 Session ID 的哈希，不直接暴露 Session ID；
- 只有创建归档的 Session 可以通过 `read` 工具读取相应普通文件；其他 Session、归档目录、未知文件和符号链接均被保护；
- `write`、`edit` 和 `patch` 不能修改或删除归档，归档对模型工具保持只读。

### 8. 安全文档与测试覆盖

- `SECURITY.md` 更新了模型沙箱、宿主机执行面、Server 单用户边界和不在保护范围内的场景。
- 权限文档增加了 `script`、沙箱行为、默认权限和运维限制说明。
- 新增沙箱参数、执行策略和 `script` 工具测试。
- 既有 Shell、读写、补丁、输出归档、路径解析及 agent 权限测试已同步调整，覆盖容器参数、失败关闭、并发配额、超时、路径边界、Session 归档隔离等行为。

## 二、运行项目

### 1. 环境要求

- Git；
- Bun 1.3 或更高版本，仓库当前声明 `bun@1.3.14`；
- Docker 或 Podman；Windows/macOS 使用 Docker Desktop 时应启用 Linux containers；
- 至少一个可用的模型提供商配置，用于实际发起对话和工具调用。

生产或多人环境推荐使用 rootless Docker/Podman，并为不同的、不互信的用户部署独立的 OpenCode 服务进程、系统账号、数据目录和容器运行时边界。

### 2. 安装依赖

在仓库根目录执行：

```bash
bun install
```

### 3. 构建沙箱镜像

使用 Docker：

```bash
bun run sandbox:build
```

等价命令为：

```bash
docker build -t opencode-sandbox:latest infra/sandbox
```

使用 Podman：

```bash
podman build -t opencode-sandbox:latest infra/sandbox
```

并将运行时设为 Podman：

```bash
export OPENCODE_SANDBOX_RUNTIME=podman
```

PowerShell 对应命令：

```powershell
$env:OPENCODE_SANDBOX_RUNTIME = "podman"
```

### 4. 配置允许挂载的工作区

开发环境可以不设置 `OPENCODE_SANDBOX_WORKSPACE_ROOTS`，但生产环境应显式限制可挂载根目录。多个根目录使用宿主操作系统的路径分隔符：Linux/macOS 为 `:`，Windows 为 `;`。

Linux/macOS 示例：

```bash
export OPENCODE_SANDBOX_WORKSPACE_ROOTS=/home/user/projects:/srv/opencode-workspaces
```

PowerShell 示例，将当前仓库设为允许范围：

```powershell
$env:OPENCODE_SANDBOX_WORKSPACE_ROOTS = (Resolve-Path .).Path
```

不要把宿主机根目录、用户主目录、OpenCode 数据/配置目录、容器运行时 socket、敏感 IPC 文件或包含敏感嵌套挂载的目录设为允许根目录。

### 5. 启动 CLI/TUI

在仓库根目录启动并打开当前仓库：

```bash
bun run dev .
```

也可以传入其他项目目录：

```bash
bun run dev /path/to/project
```

如果已经安装并运行 OpenCode V2 后台服务，可让开发版 TUI 连接现有服务和会话：

```bash
bun run dev:live /path/to/project
```

### 6. 启动 Web 或桌面界面

Web 开发需要在两个终端分别启动后端和前端：

```bash
bun run dev serve --port 4096
```

```bash
bun run dev:web
```

其他入口：

```bash
bun run dev:desktop
bun run dev:www
```

### 7. 常用沙箱环境变量

沙箱限制只能由服务进程环境变量配置，项目内的 `opencode.json` 不能放宽这些限制。

| 环境变量 | 默认值 | 作用 |
| --- | ---: | --- |
| `OPENCODE_SANDBOX_ENABLED` | `true` | 启用沙箱；设为 `false` 时工具失败关闭 |
| `OPENCODE_SANDBOX_RUNTIME` | `docker` | `docker` 或 `podman` |
| `OPENCODE_SANDBOX_IMAGE` | `opencode-sandbox:latest` | 本地沙箱镜像，生产环境推荐使用 digest |
| `OPENCODE_SANDBOX_USER` | 宿主 UID:GID 或 `65532:65532` | 容器内非 root 数字用户 |
| `OPENCODE_SANDBOX_CPU` | `1` | 每个容器的 CPU 数 |
| `OPENCODE_SANDBOX_MEMORY_MB` | `1024` | 每个容器的内存与 swap 上限（MiB） |
| `OPENCODE_SANDBOX_PIDS` | `64` | 每个容器的进程数上限 |
| `OPENCODE_SANDBOX_TIMEOUT_MS` | `120000` | 排队和执行的总截止时间 |
| `OPENCODE_SANDBOX_MAX_OUTPUT_BYTES` | `10485760` | 单次 stdout/stderr 捕获上限 |
| `OPENCODE_SANDBOX_MAX_INPUT_BYTES` | `1048576` | 单次输入总字节数上限 |
| `OPENCODE_SANDBOX_MAX_FILE_BYTES` | `67108864` | 容器内单文件大小上限 |
| `OPENCODE_SANDBOX_TMPFS_MB` | `64` | `/tmp` tmpfs 上限（MiB） |
| `OPENCODE_SANDBOX_MAX_CONCURRENT` | `4` | 服务级同时运行容器数 |
| `OPENCODE_SANDBOX_MAX_PENDING` | `16` | 服务级额外排队调用数 |
| `OPENCODE_SANDBOX_MAX_SESSION_CONCURRENT` | `1` | 单 Session 同时运行容器数 |
| `OPENCODE_SANDBOX_MAX_SESSION_PENDING` | `4` | 单 Session 额外排队调用数 |
| `OPENCODE_SANDBOX_WORKSPACE_ROOTS` | 未设置 | 管理员允许挂载的工作区根目录列表 |

完整部署与安全说明见 `infra/sandbox/README.md` 和 `SECURITY.md`。

## 三、验证改动

仓库禁止从根目录运行测试。沙箱相关测试应从 `packages/core` 执行：

```bash
cd packages/core
bun test test/sandbox.test.ts test/tool-execution-policy.test.ts test/tool-script.test.ts
bun typecheck
```

需要验证 agent 默认权限时：

```bash
cd packages/schema
bun test test/agent.test.ts
bun typecheck
```

运行根级静态检查：

```bash
bun run lint
```

沙箱单元测试主要校验生成的容器参数和服务行为，不要求每条测试都实际启动 Docker。手工验收时仍应先构建镜像，再通过开发版 CLI/TUI 分别触发 `shell`、Python `script` 和 TypeScript `script`，确认权限提示、项目文件读写、网络不可用、超时和输出截断符合预期。

## 四、二次开发说明

### 1. 先遵守仓库分层

运行时依赖方向必须保持为：

```text
Schema → Core / Protocol → Server
```

- `packages/schema`：共享的数据、配置、权限和持久化契约；
- `packages/core`：沙箱服务、工具实现、路径处理和业务逻辑；
- `packages/protocol`：公开 API 定义；
- `packages/server`：HTTP 服务和运行时组合；
- `packages/client`：生成的 TypeScript 客户端；
- `packages/cli`：命令行入口和服务生命周期；
- `packages/tui`：终端界面。

Client 运行时代码可以依赖 Schema 和 Protocol，但不能依赖 Core 或 Server。若修改公开 Protocol 或 Server `HttpApi`，必须在 `packages/client` 执行：

```bash
bun run generate
```

不要直接编辑生成的客户端文件。

### 2. 沙箱核心扩展点

| 位置 | 职责 | 常见改动 |
| --- | --- | --- |
| `infra/sandbox/Dockerfile` | 固定容器运行面 | 增减受信任的运行时和命令行工具 |
| `packages/core/src/sandbox.ts` | 容器参数、输入校验、资源/队列限制和清理 | 新增管理员限制、运行时能力或错误类型 |
| `packages/core/src/tool/execution-policy.ts` | 宿主机/沙箱工具分类与受保护名称 | 新增沙箱 profile 或受保护工具名 |
| `packages/core/src/tool/plugin/shell.ts` | 模型侧 Shell 工具 | 调整输入、权限解析和结果映射 |
| `packages/core/src/tool/plugin/script.ts` | Python/TypeScript 脚本工具 | 新增语言、参数或输出结构 |
| `packages/core/src/plugin/internal.ts` | 内置服务和工具注册 | 注册新的内置沙箱服务或工具 |
| `packages/core/src/tool-output.ts` | 输出截断、归档、配额和访问控制 | 调整归档策略或 Session 隔离 |
| `packages/core/src/location-mutation.ts` | 规范化路径与外部目录判断 | 调整路径安全策略 |

### 3. 新增脚本语言

新增语言时至少需要同步完成：

1. 在 `infra/sandbox/Dockerfile` 中安装并验证运行时，避免引入包管理器缓存、网络下载或不必要的系统工具；
2. 扩展 `script` 输入中的语言枚举和命令映射；
3. 明确源码是通过 stdin、临时文件还是参数传入，并继续限制输入大小和参数数量；
4. 保持 `--no-install`、无网络、非 root、只读根文件系统等失败关闭属性；
5. 更新 `script` 权限资源、工具说明、权限文档和安全边界；
6. 增加输入校验、参数转义、工作目录、超时、输出截断、权限拒绝和沙箱禁用测试；
7. 重新构建镜像并做真实容器验收。

不要让模型在单次调用中选择镜像、开启网络、覆盖资源上限或安装依赖；这些都应由管理员构建镜像和配置服务环境变量完成。

### 4. 新增受沙箱保护的工具

如果新增的不只是语言，而是新的模型执行工具，需要同时修改：

1. `ToolExecutionPolicy.Profile`、受保护工具名和注册校验；
2. `Sandbox.RunInput.profile` 及对应参数验证、标签与测试；
3. 工具实现，使用 `ToolExecutionPolicy.declareSandbox(...)` 标记完整工具对象；
4. 工具实现内部直接调用 `Sandbox.Service`，并在服务禁用或运行时不可用时失败关闭；
5. `packages/core/src/plugin/internal.ts` 中的服务依赖和内置工具注册；
6. Schema 中的默认 agent 权限，以及 Plan agent 等内置 agent 的显式限制；
7. 权限文档、安全文档、工具注册测试和端到端行为测试。

不要根据工具名称在运行时猜测执行位置，也不要用普通插件复制已标记工具对象后继续声称它是可信沙箱实现。

### 5. 修改路径或文件工具

涉及读写工具时，应继续保留以下不变量：

- 权限判断使用规范化后的真实路径；
- 写入、删除和格式化基于 `LocationMutation.Target`，不要退回只传字符串路径；
- 变更前使用 canonical guard，避免校验后目标被符号链接或 junction 替换；
- 工具输出目录和归档对模型写工具保持只读；
- 只有创建归档的 Session 能读取对应归档文件；
- 测试同时覆盖词法路径和规范化路径，Windows 下还应覆盖 junction 和大小写行为。

### 6. 测试与提交前检查

优先测试实际实现，避免复制生产逻辑到测试中。测试和类型检查必须从受影响的包目录运行。例如修改 Core：

```bash
cd packages/core
bun test test/sandbox.test.ts test/tool-execution-policy.test.ts test/tool-script.test.ts
bun typecheck
```

根据实际改动再补充 Shell、工具输出、文件读写、补丁和 Location 测试。提交前还应检查：

- 沙箱不可用时是否仍然失败关闭；
- 项目目录是否经过规范化并受管理员根目录约束；
- 容器是否仍保持无网络、只读根文件系统、非 root、无 capabilities；
- 是否为新增输入设置字节数、数量和超时上限；
- 是否会把 Session ID、宿主机环境变量或凭据写入容器参数和输出；
- 是否更新权限默认值、用户文档和 `SECURITY.md`；
- 是否只修改手写源码，并在公开 API 变化时重新生成客户端。

## 五、已知边界

- `/workspace` 是读写挂载；获准执行的 shell 或 script 可以读取、创建、修改和删除项目内文件。
- 沙箱保护的是模型侧 `shell`/`script` 的进程和宿主机文件系统边界，不替代工具权限。
- 文件工具仍在 OpenCode 宿主进程中执行；PTY、Shell HTTP/API、用户插件和 MCP 服务也不经过该模型沙箱。
- `--network=none` 不能阻止访问被主动放进工作区挂载中的 Unix socket、FIFO 或其他文件系统 IPC。
- 同一 Location 下的多个 Session 共享项目文件；若需要文件系统隔离，应为 Session 使用不同 worktree 或 volume。
- 当前实现面向单用户服务，不提供多租户身份、配额或 Session 所有权隔离。
- 容器运行时和宿主机配置属于可信计算基础。要求更强隔离时，应将整个 OpenCode 服务放入专用容器或虚拟机。
