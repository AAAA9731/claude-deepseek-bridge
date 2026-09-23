# claude-deepseek-bridge

让 **Claude Code** 把规格清楚、可以验收的活，交给本机的 **DeepSeek Harness**（`dsh`，便宜得多）去做：Claude 负责拆任务、写 brief、验收，DeepSeek 负责干活。这是一整套工具：

| 组件 | 位置 | 作用 |
|---|---|---|
| **deepseek-delegate** skill | `skill/deepseek-delegate/` | 写给 Claude 的说明：什么活该外包、怎么调用 dsh、brief 模板、常见报错、必须做的验收流程、中断后如何续做 |
| **dsh-mcp** skill | `skill/dsh-mcp/` | 让 Claude 给 dsh **安装、卸载、列出、验证任意 MCP server**，可以从 Claude Code、Codex 或 Claude Desktop 的现有配置里直接导入 |
| **dsv** | `bin/dsv.mjs` | DeepSeek 会话查看器：常驻的全屏 TUI，另有 `ls` / `show` / `watch` 子命令 |

## 工作原理

```
你 ──► Claude Code
         │  deepseek-delegate：判断要不要外包，写 brief
         │  cd <项目> && dsh --profile headless [--patch ~/.dsh/patches/<name>-mcp.yml …] "$(cat brief.md)"
         ▼
       dsh（deepseek-flash）── 读写文件 / 跑命令 / 调用按需加载的 MCP 工具
         │
         ├─► stdout：报告（第一行 RESULT: OK|FAIL|BLOCKED）──► Claude 用 git diff、测试等方式验收
         └─► ~/.dsh/sessions/**/session.v3.jsonl.zstd ──► dsv 读取并显示

       dsh-mcp：每个 MCP server 对应 ~/.dsh/patches/<name>-mcp.yml，调用时用 --patch 按需加载
```

- 没有私有接口：Claude 就是在 shell 里调用 `dsh` 的一次性（headless）模式。
- 每次调用都是全新会话，所以 brief 必须自包含。skill 里有模板。
- MCP 默认都不加载，只有任务需要时才用 `--patch` 加上，因为每个 server 的工具定义都会让每次请求变贵。
- dsv 只读会话日志，不和 dsh 进程通信。谁发起的 dsh 会话它都能看到。

## 依赖

- Windows（目前只在 Windows 11 + PowerShell / Git Bash 下测过）
- Node.js ≥ 23.8（dsv 用了内置 zstd）
- [Claude Code](https://claude.com/claude-code)
- DeepSeek Harness CLI：`npm i -g @deepseek-ai/dsh`，并完成登录或 API 配置
- 各个 MCP server 自己的依赖（npx、uv 等），安装时由 dsh-mcp skill 检查

## 安装

克隆仓库后，**双击 `install.cmd`**，或在 PowerShell 里运行：

```powershell
.\scripts\install.ps1             # 安装 / 更新
.\scripts\install.ps1 -Uninstall  # 卸载
```

脚本是**幂等**的：每一步都先比较，只更新有变化的部分，没有变化时输出「一切已是最新」。所以 `git pull` 之后再运行一次，就完成了更新。它会做这几件事：

1. 检查依赖：Node ≥ 23.8、npm、dsh。
2. 把 `skill/` 下的所有 skill 同步到 `~/.claude/skills/`。Claude Code CLI 和 Claude 桌面 app 的 Code 标签页共用这个目录。仓库里删掉或改名的 skill，下次更新时会自动清理。已经开着的会话要重开才能看到新 skill。
3. 用 `npm link` 提供全局 `dsv` 命令，它直接指向本仓库的 `bin/dsv.mjs`，所以改代码立即生效。
4. 自检。

覆盖或删除文件前，会先备份到 `~/.claude-deepseek-bridge/backups/`。**`~/.dsh/patches/` 里的 MCP 配置属于你自己，安装和卸载都不会动它们。**

## 使用

### 让 Claude 外包

正常和 Claude Code 说话就行。遇到符合条件的活，它会自己用 deepseek-delegate。你也可以明确说「这个交给 DeepSeek」。

### 给 DeepSeek 装 / 卸 MCP

直接跟 Claude Code 说，比如：

- 「给 dsh 装上 GitHub MCP」
- 「把我 Claude Code 里配的 xxx MCP 导入给 dsh」
- 「dsh 现在装了哪些 MCP」
- 「卸掉 dsh 的 xxx MCP」

Claude 会用 dsh-mcp skill 写好 `~/.dsh/patches/<name>-mcp.yml`，并实际连一次，确认工具能用。凭据不会明文写进配置，而是改成引用环境变量。

手动查看已安装的 MCP：`head -n 4 ~/.dsh/patches/*-mcp.yml`

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

## 已知限制

- **路径过长时 dsh 会直接退出**（Win32 工作目录长度限制），要在短路径下调用。
- dsh 在沙箱里用受限令牌运行，`git` 会报 `dubious ownership`。要让它用 `git -c safe.directory=<路径> …`。
- MCP 配置里如果转发了一个**没有设置**的环境变量，整个 dsh 会启动失败（`invalid config`）。dsh-mcp skill 会用 `?? ''` 规避这个问题。
- dsh 的会话日志格式（`session.v3.jsonl.zstd`）不是公开 API，dsh 升级后 dsv 可能需要跟着调整。
- 省多少钱取决于任务大小：Claude 写 brief 和验收仍然消耗 token，任务越大、越机械越划算。
- Windows 上 TUI 的鼠标支持取决于终端。键盘操作始终可用。

## 许可证

Copyright (C) 2026 AAAA9731

本项目以 [GNU Lesser General Public License v2.1](LICENSE)（LGPL-2.1）发布。

本项目与 Anthropic、DeepSeek 均无官方关联。Claude、Claude Code 是 Anthropic 的商标，DeepSeek 是 DeepSeek 的商标。
