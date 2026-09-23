# claude-deepseek-bridge

让 **Claude Code 或 Codex** 尽早把目标明确、可以验收的工作交给本机 **DeepSeek Harness**（`dsh`）：主代理给目标、边界和验收标准，DeepSeek 自行调查、实现、验证，主代理检查结果。

目标是在保持任务要求和验收标准的前提下减少主代理开销。优化的是通过验收的总成本，包括派单、检查和返工；不要求主代理预先写好实现计划或代码。本项目是 **skills + CLI 工具**，本身不是 MCP server。

| 组件 | 位置 | 作用 |
|---|---|---|
| **deepseek-delegate** skill | `skill/deepseek-delegate/` | 委派条件、brief 模板、按宿主调用 dsh、结果验收与返工流程 |
| **dsh-mcp** skill | `skill/dsh-mcp/` | 给 dsh 安装、卸载、列出和验证 MCP server；支持从 Claude Code、Codex 或 Claude Desktop 配置中导入指定 server |
| **dsv** | `bin/dsv.mjs` | DeepSeek 会话查看器：常驻的全屏 TUI，另有 `ls` / `show` / `watch` 子命令 |
| **dsb** | `bin/dsb.mjs` | 统一委派、取消、结果查询、保留要求的返工、验收记录和用量汇总 |

## 工作原理

```
你 ──► Claude Code / Codex
         │  deepseek-delegate：判断要不要外包，写 brief
         │  dsb run --cwd <项目> --brief <文件> [--patch <MCP 配置> …]
         │  保存原始要求、Git 状态基线、作业 ID；同仓库加锁
         ▼
       dsh ── 读写文件 / 跑命令 / 调用按需加载的 MCP 工具
         │
         ├─► 短报告 + 真实退出码 ──► 主代理验收 ──► dsb review
         └─► ~/.dsh/sessions/**/session.v3.jsonl.zstd ──► dsv 读取并显示

       dsh-mcp：每个 MCP server 对应 ~/.dsh/patches/<name>-mcp.yml，调用时用 --patch 按需加载
```

- 执行使用 `dsh` 的 headless CLI，启动器按参数数组启动 Node，不经过 shell 拼接任务文本。
- 每次调用都是新会话，brief 必须自包含。`dsb retry` 沿用保存的原始要求、项目和 MCP patch，再补充失败证据；它不是旧会话恢复。
- MCP 只按任务加载，避免不必要的工具定义和启动开销；实际成本还取决于缓存、执行轮数和返工。
- dsv 只读会话日志，不和 dsh 进程通信。谁发起的 dsh 会话它都能看到。

## 依赖

- Windows（目前只在 Windows 11 + PowerShell / Git Bash 的本机环境验证）
- Node.js ≥ 23.8（dsv 用了内置 zstd）
- [Claude Code](https://claude.com/claude-code) 或本机 Codex（CLI / 桌面应用）
- DeepSeek Harness CLI：`npm i -g @deepseek-ai/dsh`，并完成登录或 API 配置
- 各个 MCP server 自己的依赖（npx、uv 等），安装时由 dsh-mcp skill 检查

沿用宿主已有的登录方式，增加 Codex 支持不需要额外的 OpenAI API key。DeepSeek 的鉴权仍由本机 dsh 配置。WSL、远程或云端任务拥有各自的文件系统和运行环境，不能直接使用 Windows 上的这次安装；这些环境尚未验证。

## 安装

按你使用的宿主选择对应的安装方式。双击 `install.cmd` 会显示选择菜单，每次只安装所选宿主；PowerShell 脚本必须显式指定 `-Target`。

### Claude Code

```powershell
.\scripts\install.ps1 -Target Claude
```

skill 安装到 `~/.claude/skills/`。更新时使用同一条命令，卸载时运行：

```powershell
.\scripts\install.ps1 -Target Claude -Uninstall
```

### Codex

```powershell
.\scripts\install.ps1 -Target Codex
```

skill 安装到 `~/.agents/skills/`（[官方 skill 文档](https://learn.chatgpt.com/docs/build-skills)）。更新时使用同一条命令，卸载时运行：

```powershell
.\scripts\install.ps1 -Target Codex -Uninstall
```

需要两个宿主时，分别执行两条安装命令。安装和卸载都不会替你选择另一个宿主。

### 安装行为

`git pull` 后重新运行对应宿主的安装命令即可更新。脚本比较文件内容，只同步有变化的部分：

1. 检查依赖：Node ≥ 23.8、npm、dsh。
2. 把 `skill/` 下的两个 skill 同步到所选宿主目录，并清理本项目此前安装、如今已删除或改名的 skill。
3. 用 `npm link` 提供全局 `dsv` 和 `dsb` 命令，直接指向本仓库，所以改代码立即生效。
4. 自检。

安装后重新打开宿主会话，让它发现新增的 skill。覆盖或删除托管文件前，脚本先备份到 `~/.claude-deepseek-bridge/backups/`。只卸载一个宿主时，只要另一个宿主仍有本项目安装的 skill，就保留共享的 `dsb` / `dsv` 命令。**`~/.dsh/patches/` 中的 MCP 配置不随安装或卸载改动。**

### Agent 安装说明

选择对应的提示词发给 agent，让它完成安装。

**安装到 Claude Code：**

> 请按 README 的 Agent 安装说明，将 https://github.com/AAAA9731/claude-deepseek-bridge 安装到 Claude Code，保留已有配置，并完成不调用付费模型的安装检查。

**安装到 Codex：**

> 请按 README 的 Agent 安装说明，将 https://github.com/AAAA9731/claude-deepseek-bridge 安装到 Codex，保留已有配置，并完成不调用付费模型的安装检查。

给执行安装的 agent：用户明确要求安装本仓库后，只安装到用户指定的宿主。用户只贴链接并要求安装、未指定宿主时，使用当前执行安装的宿主；无法确定当前宿主时再询问。不要自动安装到其他宿主。只有用户明确要求两者时，才分别执行两条安装命令。

1. 阅读本 README 和 `scripts/install.ps1`，确认安装范围。此脚本面向本机 Windows；不要直接套用到 Linux、WSL 或云端环境。使用宿主正常的权限申请机制，不修改沙箱或组织策略。
2. 选择持久目录，例如 `~/Documents/claude-deepseek-bridge`。全局命令通过 `npm link` 指向此目录，安装后不能删除或移动它。目录尚不存在时，从下方的确切仓库地址克隆；已有目录时先确认它是本仓库的克隆，检查 `git status`，仅在不会覆盖本地工作时 `git pull --ff-only`。保留未提交修改和分叉历史，不执行强制重置；同名目录属于其他项目时另选持久目录。
3. 确认 Git、Node.js ≥ 23.8 和 npm 可用。只在缺少 dsh 时执行 `npm i -g @deepseek-ai/dsh`；保留已有 dsh 配置和凭据。鉴权未完成时说明还需在本机登录或配置，不要求用户把 key 粘贴到对话中。
4. 从确认过的目录执行安装脚本。直接运行 PowerShell 脚本，避免 `install.cmd` 的交互选择和暂停。首次安装可先克隆到尚不存在的持久目录：

```powershell
$bridgeRepo = Join-Path $HOME 'Documents/claude-deepseek-bridge'
git clone https://github.com/AAAA9731/claude-deepseek-bridge.git $bridgeRepo
```

阅读克隆后的 README 和安装脚本，再执行所选宿主对应的命令：

| 安装目标 | 命令 |
|---|---|
| Claude Code | `powershell -NoProfile -ExecutionPolicy Bypass -File "$bridgeRepo/scripts/install.ps1" -Target Claude` |
| Codex | `powershell -NoProfile -ExecutionPolicy Bypass -File "$bridgeRepo/scripts/install.ps1" -Target Codex` |

5. 检查所选宿主目录中存在 `deepseek-delegate/SKILL.md` 和 `dsh-mcp/SKILL.md`，运行 `dsb --help` 和 `dsv ls 1`。没有历史会话是正常情况；检查过程不启动真实模型。命令暂未出现在 PATH 时检查 npm 全局路径并重新打开终端，不重复安装或发起付费调用来验证。
6. 汇报实际安装目录、所选宿主、检查结果，以及尚缺的依赖或鉴权。提醒用户重开会话以发现 skill。本项目无需注册新的 MCP server，也无需新增 OpenAI API key。

## 使用

### 委派任务

正常和 Claude Code 或 Codex 说话即可，宿主可按 skill 的描述自动选择委派。也可以明确调用：

| 宿主 | 示例 |
|---|---|
| Claude Code | `/deepseek-delegate 实现这个功能，保持现有接口并运行相关验证` |
| Codex | `$deepseek-delegate 实现这个功能，保持现有接口并运行相关验证` |

主代理先明确目标和验收标准，把需要读取的项目规则、材料位置及必要 MCP 写进简短的自包含 brief。DeepSeek 完成后，主代理检查关键改动和验证证据，再记录验收结果；出现需求歧义或执行偏差时据实处理，不把模型报告当成验收结论。

### 给 DeepSeek 装 / 卸 MCP

直接跟任一宿主说，例如：

- 「给 dsh 装上 GitHub MCP」
- 「把我 Claude Code 里配的 xxx MCP 导入给 dsh」
- 「dsh 现在装了哪些 MCP」
- 「卸掉 dsh 的 xxx MCP」

主代理按 dsh-mcp skill 写好 `~/.dsh/patches/<name>-mcp.yml`，先本地检查配置，再验证连接与一次只读调用。已有有效配置直接复用；缺少凭据或依赖时报告缺失，不反复启动模型尝试。凭据使用环境变量引用。

PowerShell 中可查看配置简介：

```powershell
Get-ChildItem "$HOME/.dsh/patches/*-mcp.yml" | ForEach-Object { Get-Content -LiteralPath $_.FullName -TotalCount 4 }
```

### dsv

```
dsv                 全屏 TUI（需要真实终端）
dsv ls [N]          最近 N 个会话
dsv show <ID|latest> [--full] [--no-reasoning] [--all]
dsv watch [ID]      实时跟踪；不指定 ID 时，出现新会话会自动切换过去
```

TUI 操作：

| 按键 / 鼠标 | 作用 |
|---|---|
| `↑↓` `j k` | 选择会话；在内容区时移动光标 |
| `Enter` / `Tab` / 点击内容 | 进入内容区；在内容区时展开或收起光标所在的块 |
| `Esc` | 回到列表 |
| `PgUp` `PgDn` / 滚轮 | 翻页 |
| `g` / `G` | 顶部 / 底部（回到底部会恢复自动跟随） |
| `e` / `E` | 当前会话全部展开 / 全部收起 |
| 底栏 `1`–`5` 或点击按钮 | 开关：自动跟随、思考、全部展开、系统消息、提示音 |
| `q` / `Ctrl+C` | 退出 |

窗口宽度 ≥ 110 列时是双栏布局（左边列表，右边内容），更窄时是单栏。

`有更新 / 无更新` 只描述日志，不能据此确认进程运行或中断；`已结束` 也不等于任务验收通过。桥接任务使用 `dsb status` 查询运行记录。会话详情显示已观测 token，用量缺失显示不可用。

### dsb

```text
dsb run --cwd "项目路径" --brief "brief.md" --timeout 2700
dsb run --cwd "项目路径" --brief "brief.md" --patch "MCP 配置.yml"
dsb status <作业 ID>
dsb result <作业 ID>
dsb cancel <作业 ID>
dsb retry <作业 ID> --feedback "失败证据.md"
dsb review <作业 ID> --verdict accepted --note "已检查关键 diff 并运行相关测试"
dsb stats
```

`run` / `retry` 保持连接直到进程结束；其余命令不调用模型。宿主应保留并等待原来的执行任务：

- Claude Code：使用 Bash 的后台执行和 TaskOutput。
- Codex：使用当前环境提供的执行工具；`exec_command` 返回 `session_id` 后，用 `write_stdin` 等待同一会话。不要套用 Claude 的工具参数，也不要为查进度重新启动委派。

按宿主支持的方式等待完成，避免高频轮询。遵守当前环境的权限流程；skill 不会把 Claude 或 Codex 的项目规则自动传给 dsh，需要在 brief 中明确相关规则。

输出为 JSONL，启动返回作业 ID，结束返回短报告；完整报告和错误日志保存在 `$DSH_HOME/bridge/jobs/<ID>/`（默认 `~/.dsh/bridge/jobs/<ID>/`）。没有安装全局命令时可用 `node <仓库>/bin/dsb.mjs`。

每次作业保存原始 brief、实际提示词、MCP patch 路径与摘要、运行前后 Git 状态清单、真实退出码和匹配的会话用量。Git 清单不是备份，也不能自动区分同一文件内用户与 agent 的修改；主代理仍须核对。正常返回最多显示报告前 6000 字节，截断时附完整路径。

`processState` 表示进程结果，`reportedResult` 表示模型自述，`review.verdict` 表示主代理验收，三者分开。默认 `unreviewed`；验收可记录 `accepted`、`rework` 或 `blocked`。进程失败或非 OK 报告不能直接标为 accepted。取消请求需要等待退出确认；超时会尝试清理进程树。

同一 Git 工作区的桥接作业串行运行，独立工作区可以并行。锁无法拦住主代理、IDE、用户或直接启动的 dsh；外部 MCP 对象也需要自行协调。启动器崩溃或进程清理失败时保留锁，不自动重派。确认原任务及相关子进程已停止、核对部分成果后，才运行 `dsb unlock <ID> --confirmed-stopped`。

返工保持原始要求和 patch；原始文件或 patch 已变化时拒绝重试，要求重新审视目标并创建新任务。用户改变需求也应创建新的自包含 brief。它不自动重试模型，也不自动判定验收成功。

### 用量与成本

`dsb stats` 按任务及返工次数汇总验收结果、未缓存输入、输出和缓存 token。只归集通过唯一任务标记匹配的父会话，缺失用量不当作零；内部子代理或其他辅助请求不一定包含在内，不能冒充完整账单。会话格式的解析按本机 dsh v3 日志验证，升级后需要兼容性检查。

可选地，在 `dsb review` 加 `--accounting <JSON 文件>` 保存有来源的费用：

```json
{"currency":"USD","source":"按该次任务实际用量和价格计算","claudeCost":0.12,"deepseekCost":0.03}
```

Codex 任务使用 `codexCost` 代替 `claudeCost`。三个费用字段分别保存和汇总，不混为同一种宿主费用。这里的金额只是格式示例，不是价格或实测结果。未知费用省略对应字段；不同货币分组，不自动换算。主代理费用应包括该次派单、验收和返工处理，避免在多个尝试间重复计入。订阅额度与 API 支出分开看；没有等价的主代理独立完成任务基线时，不计算或宣称节省比例。

## 本地检查

```text
npm run check
```

此命令检查 JavaScript 语法，不调用模型。`dsb --help` 和 `dsv ls` 可用于检查本机命令及已有日志；它们不能代替真实委派和验收。

## 已知限制

- **路径过长时 dsh 会直接退出**（Win32 工作目录长度限制）。使用同一授权项目已有的短路径入口；否则由主代理处理，不自行复制、移动或切换项目。
- dsh 在沙箱里用受限令牌运行，`git` 会报 `dubious ownership`。要让它用 `git -c safe.directory=<路径> …`。
- MCP 配置里如果转发了一个**没有设置**的环境变量，整个 dsh 会启动失败（`invalid config`）。dsh-mcp skill 会用 `?? ''` 规避这个问题。
- dsh 的会话日志格式（`session.v3.jsonl.zstd`）不是公开 API，升级后 dsv 与用量读取器可能需要调整；任务执行不依赖日志匹配成功。
- 本机验证版本为 dsh CLI `0.1.5-rc.1`，其依赖包可能有不同补丁版本。`dsb` 支持 `--dsh-entry <dsh/lib/bin.js>` 指定本地入口；CLI 与日志格式变化需重新验证。
- headless 无法中途追问或原地追加消息，返工重新建会话。Windows 命令行过长会在启动前拒绝，brief 应简短并引用已有项目材料。
- 是否省钱取决于任务与返工情况：主代理写 brief 和验收仍然消耗 token，优先委派目标明确、检查成本较低的工作。
- Windows 上 TUI 的鼠标支持取决于终端。键盘操作始终可用。

## 许可证

Copyright (C) 2026 AAAA9731

本项目以 [GNU Lesser General Public License v2.1](LICENSE)（LGPL-2.1）发布。

本项目与 Anthropic、OpenAI、DeepSeek 均无官方关联。相关产品名称与商标归其各自所有者所有。
