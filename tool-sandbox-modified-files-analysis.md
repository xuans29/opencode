# Tool Sandbox 分支原有文件修改分析

## 1. 分析范围

本文基于以下分支差异：

```bash
git diff v2...tool-sandbox
```

- 源码基线：`v2`
- 修改后分支：`tool-sandbox`
- 修改提交：`6ed8730702 feat(core): add sandboxed tool execution`
- 本文只解释 Git 状态为 `M` 的原有文件，共 40 个。
- Git 状态为 `A` 的沙箱服务、Script 工具、Dockerfile 和新增测试等文件不在本文范围内。

本次改造的整体目标是把模型侧 `shell` 放入 Docker/Podman 沙箱，新增沙箱化脚本执行能力，并补齐权限、路径、符号链接、输出归档和 Plan 模式等安全边界。

理解文件路径相关修改时，需要区分三个概念：

- `absolute`：用户输入转换出来的绝对路径，可能仍经过符号链接。
- `canonical`：解析已有符号链接或 Windows junction 后的真实目标路径，用于读取、搜索和权限判断。
- `entry`：解析父目录但不跟随最后一级符号链接的路径，用于安全删除目录项本身。

## 2. 生产代码

### 2.1 `package.json`

新增根级命令：

```json
"sandbox:build": "docker build -t opencode-sandbox:latest infra/sandbox"
```

它为沙箱镜像提供统一构建入口。模型侧 `shell` 和 `script` 依赖本地 `opencode-sandbox:latest` 镜像。当前修改没有加入自动拉取或自动构建逻辑，因此镜像不存在时工具会失败关闭，不会回退到宿主机执行。

### 2.2 `packages/schema/src/agent.ts`

修改 Agent 默认权限，在通配允许规则后增加：

```text
shell *  -> ask
script * -> ask
```

权限规则采用后匹配覆盖前匹配，因此这两条规则会覆盖前面的 `* * -> allow`，而不会改变其他工具的默认权限。

影响包括：

- 模型执行 Shell 前默认需要确认。
- 模型执行 Python 或 TypeScript 脚本前默认需要确认。
- 所有使用基础 Agent 默认值的内置和自定义 Agent 都会继承该行为。
- 内置 Agent 仍可在后面追加更严格的 `deny`。

### 2.3 `packages/schema/src/config.ts`

没有改变 `shell` 配置字段的数据结构，只修改字段说明。

原来该字段同时被描述为终端和 Shell 工具使用的默认 Shell。现在明确：

- `config.shell` 只影响宿主机 PTY 和 Shell HTTP/API。
- 模型侧 `shell` 工具固定使用 Linux 沙箱中的 `/bin/sh`。
- 用户不能通过顶层配置把模型 Shell 改回 PowerShell、cmd 或其他宿主机 Shell。

### 2.4 `packages/core/src/agent.ts`

调整 OpenCode 管理目录的运行时默认权限。

原来默认允许 Agent 通过 `external_directory` 访问 `global.data/tool-output/*`。现在：

- 删除工具输出目录的 `external_directory allow`。
- 增加工具输出目录的 `edit deny`。

原因是工具输出归档已经引入 Session 所有权，不能再把整个归档目录当成普通外部目录开放。当前 Session 是否可以读取某个归档由 `ToolOutput.access()` 强制判断；用户权限配置不能简单绕过该边界。

### 2.5 `packages/core/src/environment/files.ts`

扩展底层文件系统契约，新增 `MutationGuard`：

```text
expectedCanonical
expectedEntry
```

并修改接口：

```text
write(path, bytes)
  -> write(path, bytes, guard?)

remove(path)
  -> remove(path, guard?)
```

两个 guard 的职责不同：

- `expectedCanonical`：写入前确认请求路径仍指向授权时的真实文件。
- `expectedEntry`：删除前确认中间目录没有被替换，同时删除最后一级目录项本身。

该接口是解决“授权后符号链接被替换”竞态的底层基础。

### 2.6 `packages/core/src/environment/index.ts`

从 Environment 统一入口导出 `MutationGuard` 类型。

这个文件没有运行时逻辑变化，作用是保持模块封装，让调用方不需要直接依赖 `environment/files.ts`。

### 2.7 `packages/core/src/environment/local.ts`

在宿主机真实文件系统中实现 mutation guard。

写入流程变为：

1. 重新规范化用户请求路径。
2. 与授权时保存的 `expectedCanonical` 比较。
3. 不一致则拒绝。
4. 创建真实目标的父目录。
5. 再次检查路径。
6. 使用 `O_NOFOLLOW` 打开目标。
7. 写入内容。

两次检查加 `O_NOFOLLOW` 用于降低以下竞态风险：权限检查时链接指向项目内，真正写入前链接被替换为项目外路径。

删除流程新增 `assertEntry()`：

- 规范化父目录。
- 保留最后一级文件名。
- 与授权时的 `expectedEntry` 比较。
- 不一致则拒绝。
- 删除授权时确认的目录项。

新增的路径规范化逻辑同时支持：

- 已存在文件和目录。
- 中间符号链接。
- Windows junction。
- dangling symlink。
- 不存在的末尾路径。
- 循环链接检测。
- 最多 40 层符号链接。

### 2.8 `packages/core/src/environment/memory.ts`

内存文件系统同步实现 `MutationGuard` 语义：

- 写入时解析真实目标并与 `expectedCanonical` 比较。
- 删除时将目录项与 `expectedEntry` 比较。
- 不一致时返回 `Environment.Failed`。
- 写入和删除异常统一映射到内存环境文件系统错误。

这样测试环境与宿主机驱动保持相同的安全契约，避免测试通过但真实文件系统行为不同。

### 2.9 `packages/core/src/location-mutation.ts`

这是路径安全改造的核心入口。

`Target` 从原来的 `absolute`、`resource`、`externalDirectory` 扩展为：

- `absolute`：词法绝对路径。
- `canonical`：跟随已有符号链接或 junction 后的真实目标。
- `entry`：真实父目录加词法文件名，不跟随最终目录项。
- `resource`：权限系统使用的规范化资源。
- `externalDirectory`：目标越过 Location 后需要申请的外部目录边界。

Location 根目录本身也会先规范化。目标是否位于项目内不再只看词法路径，而是判断 canonical/entry 是否落在规范化后的 Location 根目录内。

例如：

```text
project/linked -> /outside
project/linked/file.txt
```

现在会得到：

```text
absolute  = project/linked/file.txt
canonical = /outside/file.txt
resource  = /outside/file.txt
```

随后先申请 `/outside/*` 的 `external_directory` 权限，再申请具体工具权限。

对于 dangling final symlink，即使真实文件尚不存在，也会读取链接内容并推导未来目标，避免利用“不存在路径”绕过外部目录判断。

### 2.10 `packages/core/src/file-mutation.ts`

把 `LocationMutation.Target` 落实到安全的写入、删除、锁和 BOM 同步流程。

主要变化：

- `readText()` 从接收字符串改为接收完整 Target，并从 `canonical` 读取。
- `syncTextBom()` 接收完整 Target，通过 guarded write 同步 BOM。
- 文件锁键由 `absolute` 改为 `canonical`，不同路径别名会归并到同一把锁。
- 新增 `refresh()`，在真正变更前重新解析请求路径。
- 新增 `verify()`，比较当前 canonical 与授权时 canonical。
- 新增 `verifyEntry()`，比较当前 entry 与授权时 entry。
- 新增统一 `remove()`，删除不再由 Patch 直接调用底层文件系统。
- `FileMutation.node` 新增 `LocationMutation.node` 依赖。

安全模型变成：权限阶段解析一次，提交阶段重新解析一次，底层驱动执行前再通过 guard 确认一次。

### 2.11 `packages/core/src/plugin/internal.ts`

负责把沙箱服务和 Script 工具接入内置插件运行时。

修改包括：

- 导入 `Sandbox`。
- 获取 `Sandbox.Service`。
- 把 Sandbox 服务加入插件 Context。
- 把 `Sandbox.node` 加入运行时依赖图。
- 把 `ScriptTool.Plugin` 加入内置工具列表。

如果缺少这些修改，Shell/Script 插件无法取得沙箱服务，新 Script 工具也不会出现在工具注册表中。

### 2.12 `packages/core/src/plugin/plan.ts`

强化 Plan Agent 的只读边界。

新增显式拒绝：

```text
shell *    -> deny
script *   -> deny
subagent * -> deny
```

原因是只禁止 `edit`、`write`、`patch` 并不足以形成只读模式，模型仍可能通过 Shell、Script 或委托子 Agent 间接修改文件。

Plan 模式系统提醒也增加 Shell/Script 不可用的文字。提示词用于减少无效调用，权限规则负责真正强制拦截。

### 2.13 `packages/core/src/session/runner/llm.ts`

把：

```text
toolOutput.truncate(outcome)
```

改为：

```text
toolOutput.truncate(sessionID, outcome)
```

Session ID 用于：

- 生成归档所有权哈希。
- 统计单 Session 配额。
- 判断哪个 Session 可以读取归档。

这是 Session 身份从执行链传到归档服务的关键连接点。

### 2.14 `packages/core/src/tool-output.ts`

原实现主要负责把模型可见输出限制在 2000 行或 50 KiB，并把完整输出保存到文件。修改后扩展为带 Session 所有权和配额管理的归档服务。

主要变化如下。

#### Session 身份

`truncate()` 必须接收 `sessionID`。归档文件名使用 Session ID 的 SHA-256 哈希，不直接泄露原始 Session ID。

#### 新增硬限制

默认限制包括：

- 单归档最多 10 MiB。
- 全局最多 256 个归档。
- 全局最多 256 MiB。
- 单 Session 最多 32 个归档。
- 单 Session 最多 32 MiB。

归档不完整时，metadata 会说明原始字节数、实际归档字节数和归档完整性。

#### 统一二次截断

旧实现看到工具已经设置 `metadata.truncated` 就直接返回。现在只有内容本身仍在模型可见上限内时才直接保留；如果内容依然过大，ToolOutput 继续统一截断和归档。

#### 并发与配额

多个 Location 可能共享同一全局数据目录，因此新增目录级 `KeyedMutex`，把以下操作串行化：

- 读取现有归档。
- 删除过期文件。
- 计算单 Session 配额。
- 计算全局配额。
- 写入新归档。

回收采用最旧优先策略，定时 cleanup 也会让旧文件重新收敛到当前配额。

#### 访问控制

新增 `access()`，返回：

- `unrelated`：不是工具输出目录。
- `archive`：当前 Session 自己的合法普通归档文件。
- `protected`：归档目录、其他 Session 文件、未知文件、子目录或符号链接等。

文件工具使用这个结果强制实施归档隔离。

#### 文件权限

在非 Windows 系统中：

- 归档目录设为 `0700`。
- 普通归档文件设为 `0600`。

权限修复不会跟随符号链接，防止通过伪造归档链接修改外部文件权限。

#### 清理实现

不再使用通用 `FileRetention`，因为通用清理不能表达 Session 所有权、文件和字节配额、符号链接保护等要求。

### 2.15 `packages/core/src/tool.ts`

增加工具执行来源校验和追踪。

注册普通宿主机工具时，如果规范化名称是 `shell` 或 `script`，直接返回 `Tool.RegistrationError`，防止插件通过同名工具覆盖内置沙箱工具。

沙箱工具必须同时满足：

- profile 与工具名一致。
- 名称属于受保护集合。
- `codemode === false`。
- 直接注册，不通过 CodeMode 改写。

每次执行还记录：

```text
tool.execution.target = host | sandbox
tool.execution.profile = shell | script
```

这里负责注册验证和审计。真正启动容器以及失败关闭仍由 Shell/Script 工具内部调用 `Sandbox.Service` 完成。

### 2.16 `packages/core/src/tool/plugin/shell.ts`

这是重写幅度最大的原有工具文件。

#### 删除宿主机执行模型

旧实现依赖 Shell Service、Shell session、Runtime job、Session synthetic message 和宿主机 Shell 配置。新实现不再启动宿主机 Shell，只调用 `Sandbox.Service.run()`。

#### 删除后台任务

移除：

- `background` 输入字段。
- 后台 Shell ID。
- 后台执行完成通知。
- 前台任务转后台。
- Session context 中的运行 Shell 展示。
- Shell 作业生命周期管理。

每次模型 Shell 调用现在对应一个一次性容器，调用完成或失败后清理。

#### 收紧超时

旧实现允许 `timeout = 0` 表示不限制，后台任务也可以默认无限时。新 Schema 要求：

```text
1 <= timeout <= 120000
```

默认和最大均为 120 秒。

#### 固定 Linux Shell

命令始终通过：

```text
/bin/sh -lc <command>
```

执行，不再根据宿主机操作系统或 `config.shell` 选择 PowerShell、cmd、bash 等。

#### 工作目录限制

`workdir` 必须位于当前 Location 且真实类型为目录。外部目录不能在申请 `external_directory` 后继续执行，而是直接拒绝，因为沙箱只挂载当前项目。

#### 保留权限扫描

仍使用 `ShellParse.scan()` 生成 Shell 权限资源，并继续支持实验性 portable scanner，但扫描环境固定为 `/bin/sh` 和 canonical cwd。

#### 失败关闭

Sandbox disabled、Docker/Podman 不可用、镜像不存在或容器参数失败时，只返回工具错误，不回退到宿主机。

#### 结果变化

- 非零退出码仍作为已完成工具结果返回。
- 沙箱超时变成带 `timeout: true` 的可读结果。
- 输出被沙箱硬截断时追加说明。
- 不再返回后台状态和 Shell session ID。
- 完整工具对象通过执行策略标记为可信的 `shell` 沙箱工具。

### 2.17 `packages/core/src/tool/plugin/edit.ts`

主要修改：

- 注入 `ToolOutput.Service`。
- 在权限请求和文件读取前检查归档访问结果。
- 只要目标不是 `unrelated`，就拒绝编辑。
- 原文件读取改用 canonical。
- Formatter 判断改用 canonical。
- BOM 同步改为传递完整 Target。
- 最终写入继续经过 `FileMutation.write()`。

即使当前 Session 能读取自己的归档，也不能编辑它。

### 2.18 `packages/core/src/tool/plugin/write.ts`

修改方向与 Edit 相同：

- 注入 ToolOutput 服务。
- 写入前拒绝归档文件或归档目录。
- 使用完整 Target 读取现有内容。
- BOM 检查和格式化使用 canonical。
- BOM 同步和写入使用 guarded Target。

新增文件和覆盖已有文件都会经过相同的路径重验证。

### 2.19 `packages/core/src/tool/plugin/patch.ts`

Patch 同时支持新增、更新、删除和移动，因此路径安全修改更广。

主要变化：

- 每个源路径和目标路径都先执行 ToolOutput 保护检查。
- 删除和更新验证通过完整 Target 从 canonical 读取。
- add/update 改为 `FileMutation.write()`。
- delete 改为 `FileMutation.remove()`。
- move 的目标写入和源删除都经过 FileMutation。
- 新增 `resolvedTargets` Map，让格式化阶段仍能取得完整 Target。
- Formatter 使用 canonical，BOM 同步使用完整 Target。

这样 Patch 的准备阶段和提交阶段都不会丢失已经授权的真实路径信息。

### 2.20 `packages/core/src/tool/plugin/read.ts`

增加工具输出归档所有权判断和 canonical 读取。

对 `ToolOutput.access()` 的处理：

- `unrelated`：执行正常权限流程。
- `archive`：允许当前 Session 精确读取自己的归档。
- `protected`：立即拒绝。

当前 Session 读取自己的归档时跳过 `external_directory`，但仍申请普通 `read` 权限。读取其他 Session 文件、整个归档目录、未知文件或符号链接则直接拒绝。

普通文件读取、缺失提示和读取后向上发现 `AGENTS.md` 的起点都改用 canonical，避免从符号链接的词法目录发现错误的指令文件。

### 2.21 `packages/core/src/tool/plugin/glob.ts`

修改包括：

- 注入 ToolOutput 服务。
- 禁止把工具输出目录或具体归档作为搜索根目录。
- 在权限请求前拒绝受保护目标。
- 判断目录类型时使用 canonical。
- Ripgrep 的 cwd 改为 canonical。

即使是当前 Session 自己的归档，也不能通过 Glob 枚举归档树。读取归档必须通过精确路径调用 Read。

### 2.22 `packages/core/src/tool/plugin/grep.ts`

与 Glob 的安全策略一致：

- 禁止搜索和枚举工具输出归档。
- 权限请求前完成保护判断。
- 搜索根改用 canonical。
- canonical 目标位于项目外时先申请 `external_directory`。
- 单文件搜索使用真实父目录和文件名调用 Ripgrep。

这同时修复了通过项目内符号链接搜索项目外文件而不触发外部权限的问题。

## 3. 测试文件

### 3.1 `packages/schema/test/agent.test.ts`

新增默认权限顺序测试：

- 找到通配 `allow`。
- 找到 `shell ask` 和 `script ask`。
- 确认它们位于通配规则之后。
- 确认规则内容准确。

测试顺序非常重要，因为权限系统采用最后匹配生效。

### 3.2 `packages/core/test/agent.test.ts`

更新运行时 Agent 权限预期：

- ToolOutput 的 `external_directory` 从 `allow` 改为 `ask`。
- ToolOutput 的 `edit` 必须为 `deny`。
- 在 Agent 初始构建和完整默认 Agent 集合中都进行验证。

### 3.3 `packages/core/test/config/agent.test.ts`

更新配置 Agent 测试使用的默认权限 fixture：

- 删除 ToolOutput 的 `external_directory allow`。
- 增加 ToolOutput 的 `edit deny`。

这是测试预期同步，没有新增独立生产行为。

### 3.4 `packages/core/test/config/tool-output.test.ts`

适配 `ToolOutput.truncate(sessionID, result)` 新签名。

原测试仍验证工具输出行数/字节限制可以从配置加载，并在配置更新后热重载；现在每次截断都带有明确 Session 身份。

### 3.5 `packages/core/test/file-mutation.test.ts`

新增两个关键竞态测试。

写入竞态测试：授权时链接指向项目内，写入前改为项目外，最终写入必须失败，项目外文件不得被创建。

删除竞态测试：授权后把中间链接切换到项目外，删除必须失败，内部和外部同名文件都必须保留。

测试包装器也更新为透传 mutation guard，确保 instrumentation 不会丢失真实安全参数。

### 3.6 `packages/core/test/location-mutation.test.ts`

测试预期从词法路径模型更新为 canonical 模型，覆盖：

- 普通目标和未来目标的 canonical。
- 项目内链接指向项目外时触发外部权限。
- 项目内链接指向项目内时 resource 使用真实相对路径。
- dangling final symlink 推导外部目标。
- Windows junction 等价行为。

旧测试中允许的符号链接逃逸行为被改为必须申请外部目录权限。

### 3.7 `packages/core/test/plugin/plan.test.ts`

新增断言：

- Plan 系统提醒明确说明 Shell/Script 不可用。
- Plan Agent 权限拒绝 Shell、Python Script、TypeScript Script 和 Subagent。

证明限制同时存在于提示词层和强制权限层。

### 3.8 `packages/core/test/session-instructions.test.ts`

Read 工具新增 ToolOutput 依赖后，该测试运行图也补入：

- `ToolOutput.node`。
- `access() -> unrelated` 的 mock。

没有改变 SessionInstructions 的测试目标，只是明确测试读取的文件不是归档。

### 3.9 `packages/core/test/session-runner-tool-registry.test.ts`

新增工具 Hook 回归测试：

1. 初始工具输入无效。
2. `tool.execute.before` Hook 把输入改成有效值。
3. 执行器解码 Hook 修改后的最终输入。
4. 工具使用新输入成功执行。

用于保证加入执行策略和 tracing 后，原有 Hook 顺序没有变化。

### 3.10 `packages/core/test/tool-edit.test.ts`

主要变化：

- 加入 ToolOutput 测试依赖和可控制 mock。
- 文件系统包装器透传 mutation guard。
- 验证归档目标在权限请求和文件读取前被拒绝。
- 内部链接指向外部时必须申请外部权限。
- 新增授权后链接被替换的竞态测试。
- 同时覆盖 Windows junction。

### 3.11 `packages/core/test/tool-write.test.ts`

新增和调整：

- ToolOutput mock。
- guard 参数透传。
- 归档目标在权限和写入前拒绝。
- 内部链接指向外部时依次申请外部目录和 edit 权限。
- 内部链接指向内部时仍允许写入。
- 内部链接的权限资源使用真实 canonical 相对路径。

证明安全修复不会粗暴禁止所有符号链接，只限制未经授权的边界逃逸。

### 3.12 `packages/core/test/tool-patch.test.ts`

测试覆盖：

- ToolOutput 服务依赖。
- write/remove guard 透传。
- Patch 在权限、读取和应用前拒绝归档目标。
- 经内部链接修改外部文件时申请外部权限。
- Windows junction。
- edit 权限通过后，如果链接在 commit 前改变，Patch 必须失败。
- 内部文件和外部哨兵文件都不能被误修改。

### 3.13 `packages/core/test/tool-read.test.ts`

增加：

- ToolOutput mock。
- canonical target 控制。
- LocationMutation mock 返回 canonical 和 entry。
- 符号链接逃逸读取使用真实外部路径并申请外部权限。
- 当前 Session 自己的归档可以精确读取。
- 读取自己的归档不申请 `external_directory`。
- 受保护归档在权限和底层读取前拒绝。

### 3.14 `packages/core/test/tool-search.test.ts`

Glob/Grep 测试节点加入 ToolOutput 依赖，并验证：

- Glob 不能搜索归档路径。
- Grep 不能搜索归档路径。
- 拒绝发生在权限请求前。
- 通过工作区链接搜索外部目录时先申请 `external_directory`。
- 拒绝外部权限后不能继续执行搜索。
- Windows junction 同样受保护。

### 3.15 `packages/core/test/tool-output.test.ts`

这是测试改动最大的文件之一。

覆盖内容包括：

- 所有 `truncate()` 调用传入 Session ID。
- 已报告 truncated 但内容仍过大时执行二次截断。
- 单归档硬字节上限。
- UTF-8 安全截断边界。
- metadata 中的原始字节数、归档字节数和完整性。
- 文件名不包含原始 Session ID。
- 单 Session 文件和字节配额。
- 跨 Session 的全局文件和字节配额。
- 并发写入不能突破配额。
- cleanup 对现存超额文件进行收敛。
- 当前 Session 精确归档返回 `archive`。
- 其他 Session、目录、子目录和旧格式文件返回 `protected`。
- 普通无关路径返回 `unrelated`。
- 文件名匹配但实际为符号链接时仍拒绝。
- cleanup 修复目录和普通文件权限，但不跟随符号链接。

### 3.16 `packages/core/test/tool-shell.test.ts`

该测试文件随 Shell 执行模型被大幅重写。

删除的旧测试方向包括：

- Shell session ID。
- 后台执行和后台完成通知。
- 前台转后台。
- Session context 中展示运行 Shell。
- 外部信号终止。
- 移除已结束 Shell。
- 宿主机 Shell 配置。
- 无超时后台任务。

新增或重构的测试覆盖：

- command 不能为空。
- timeout 必须大于零且不超过 120 秒。
- `background` 不属于最终输入。
- Schema 不暴露网络、镜像、CPU、内存等控制参数。
- 普通宿主机工具不能覆盖 `shell` 名称。
- 命令通过 `/bin/sh -lc` 进入 Sandbox。
- projectDirectory、canonical cwd、Session ID 和 timeout 正确传入。
- Shell 权限扫描继续工作。
- 容器内路径不会错误触发宿主机 external_directory。
- 非零退出码仍是有用的完成结果。
- 输出截断信息正确。
- timeout 返回可读结果。
- 权限拒绝后不会分配容器。
- 外部 workdir 在 Sandbox 调用前拒绝。
- Sandbox disabled 时失败关闭。
- 不发生宿主机回退。

## 4. 安全和用户文档

### 4.1 `SECURITY.md`

原文中的 `No Sandbox` 被替换为完整的模型沙箱威胁模型。

主要说明：

- 模型侧 `shell`、`script` 在一次性 Linux 容器运行。
- 沙箱不可用时失败关闭。
- 容器无网络、非 root、根文件系统只读、资源有界。
- 当前 Location 以读写方式挂载到 `/workspace`。
- 沙箱不能保护工作区中本来就存在的秘密。
- 文件系统根目录或 OpenCode 管理目录不能作为项目挂载。
- Unix socket、FIFO、嵌套挂载和硬链接可能扩大工作区权限。
- Docker/Podman 和宿主机配置属于可信计算基础。

同时明确以下执行面不经过模型沙箱：

- 文件工具。
- PTY。
- Shell HTTP/API。
- 用户插件。
- MCP Server。

Server Mode 被重新定义为单用户边界：HTTP 密码不建立租户身份，不可信用户需要分别部署服务进程、系统账号、数据目录和容器运行时边界。

`Out of Scope` 表格也相应调整。突破文档声明的模型容器边界现在属于有效安全问题，而不是一概排除。

### 4.2 `packages/www/src/docs/content/permissions.mdx`

权限文档全面同步实现行为，主要包括：

- 配置示例增加 `script` 权限。
- `script` 权限资源是 `python` 或 `typescript`。
- Shell/Script cwd 只能位于当前 Location。
- 文件 mutation 权限基于 canonical 路径。
- 介绍模型侧一次性容器沙箱。
- 说明 `/workspace` 是读写挂载。
- 说明 Shell 权限等价于容器内任意代码执行。
- 说明 Script 授权是语言级授权，不是源码哈希授权。
- 说明允许 Shell 后，Script 不是额外安全边界。
- 区分模型 Shell 与宿主机 PTY/Shell API。
- 记录默认全局和单 Session 并发、排队限制。
- 明确服务是单用户服务而非多租户系统。
- 更新 Build、Plan、General 等 Agent 的默认权限表。
- 说明工具输出归档的 Session 所有权和只读规则。
- 说明 Plan Agent 会重新施加 Shell、Script、Subagent 禁止规则。
- 更新保存授权说明：Script 保存的是语言资源。

## 5. 修改链路总结

这 40 个原有文件形成五条主要联动链。

### 工具执行链

```text
tool.ts
  -> tool/plugin/shell.ts
  -> plugin/internal.ts
  -> session/runner/llm.ts
```

负责工具来源验证、沙箱执行、运行时服务组合和 Session 归档身份传递。

### 默认权限链

```text
schema/agent.ts
  -> core/agent.ts
  -> plugin/plan.ts
```

负责 Shell/Script 默认询问、工具输出只读和 Plan 模式强制禁止。

### 路径安全链

```text
location-mutation.ts
  -> file-mutation.ts
  -> environment/files.ts
  -> environment/local.ts
  -> environment/memory.ts
```

负责 canonical 路径解析、权限边界、提交前重验证和底层 mutation guard。

### 文件工具链

```text
read / edit / write / patch / glob / grep
  -> ToolOutput.access()
  -> LocationMutation.Target
  -> FileMutation 或 canonical 搜索
```

负责归档所有权、归档只读、符号链接逃逸和搜索边界。

### 验证与文档链

对应测试、`SECURITY.md`、权限文档和根构建脚本共同保证实现、部署方式和公开安全承诺保持一致。

总体而言，本次修改不是简单地把 Shell 命令替换成 `docker run`，而是同时解决了：

- 模型命令直接在宿主机执行。
- 受保护工具名称可能被插件覆盖。
- 符号链接和 junction 越过 Location。
- 权限批准后路径被替换的竞态。
- 工具输出跨 Session 读取和修改。
- 归档文件无限增长。
- Plan 模式通过其他工具间接执行。
- 安全文档与真实运行边界不一致。
