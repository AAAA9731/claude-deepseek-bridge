---
name: dsh-mcp
description: Use when the user wants to install, add, import, list, update, fix or uninstall an MCP server for the DeepSeek agent (dsh / DeepSeek Harness), or when a dsh task needs mcp__<name>__ tools that aren't configured, or dsh fails to start with "invalid config" from @deepseek-ai/dsh-mcp-client.
---

# 给 dsh 安装 / 卸载 MCP

dsh 自带 MCP 客户端插件 `@deepseek-ai/dsh-mcp-client`。**一个 MCP server 对应 `~/.dsh/patches/` 下的一个 patch 文件。** 调用 dsh 时加 `--patch <文件>` 才会加载，这个 server 的工具以 `mcp__<serverName>__<tool>` 的名字出现。不加就不加载：每个 server 的工具定义都会让每次请求多出 token，所以按需加载。

## 列出已安装的

```bash
head -n 4 ~/.dsh/patches/*-mcp.yml
```

每个文件开头 4 行注释的格式是固定的（见下面的模板），deepseek-delegate skill 也靠这几行判断有哪些 MCP 可以用。

## 安装

1. **弄清 server 的启动方式**：
   - 用户在别的客户端里配过的话，直接照搬（见下方「从现有配置导入」）。
   - 否则看这个 server 的官方文档：是 stdio（启动一个本地命令）还是 HTTP（连一个 URL）、需要哪些环境变量、有什么前提条件。
2. **写 patch 文件** `~/.dsh/patches/<name>-mcp.yml`，照下面的模板填。
3. **验证**，三步都要做（见「验证」）。
4. 告诉用户：装在哪个文件、怎么用（`--patch …`）、运行前提、需要用户自己设置的环境变量。

### 模板

```yaml
# dsh-mcp: <name>
# 用途: <一句话：这个 MCP 能做什么>
# 前提: <运行前要满足的条件；没有就写 无>
# 用法: dsh --profile headless --patch ~/.dsh/patches/<name>-mcp.yml "<任务>"
- insert:
    - id: mcp-<name>
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: <name>              # [A-Za-z0-9_-]{1,32}，工具名前缀，所有已装的里不能重复
        transport: stdio                # stdio | streamable-http
        # ── stdio ──
        command: npx                    # npx / uvx / node / 绝对路径都行（Windows 下 .cmd 也能直接启动）
        args: ['-y', '<package>@<version>']
        env:                            # 可选，显式传给子进程的变量
          API_TOKEN: !!js process.env.API_TOKEN ?? ''
        # cwd: <工作目录>
        # ── streamable-http ──
        # url: http://127.0.0.1:3000/mcp
        # headers: { Authorization: !!js '`Bearer ${process.env.MCP_TOKEN ?? ""}`' }
        toolCallTimeoutMs: 120000       # 默认 60000；构建、编辑器这类慢工具要调大
        failOnStartupError: true        # 连不上就直接报错，不要悄悄少了一批工具
```

其他可选字段：`reconnect.enabled / initialDelayMs / maxDelayMs / maxAttempts`（默认会自动重连）。完整字段说明见 dsh 安装目录下的 `node_modules/@deepseek-ai/dsh-mcp-client/README.md`。

### 环境变量和凭据（最容易出错的地方）

- 名字里带 `KEY` / `PASSWORD` / `SECRET` / `TOKEN` 的变量，以及所有 `DSH_*` 变量，**不会被 MCP 子进程继承**。其他变量（`PATH` 这类）会正常继承。要转发凭据，必须在 `env` 里显式写出来。
- **显式转发时一定要写 `?? ''`**。如果写 `!!js process.env.X`，而 X 没有设置，值就是 undefined，**整个 dsh 会以 `invalid config` 启动失败**，连不用这个 MCP 的任务也跑不了。
- **不要把 token、密码明文写进 patch。** 从别的配置导入时遇到明文凭据，不要复制，改成 `!!js process.env.<NAME> ?? ''`，然后告诉用户自己设置这个变量（`setx <NAME> …`，设置后要新开终端才生效）。

### 从现有配置导入

| 来源 | 在哪里找 |
|---|---|
| Claude Code | `claude mcp list` / `claude mcp get <name>`；`~/.claude.json` 的 `mcpServers`，以及其中 `projects.<路径>.mcpServers`；项目根目录的 `.mcp.json` |
| Codex | `~/.codex/config.toml` 里的 `[mcp_servers.<name>]` |
| Claude Desktop | `%APPDATA%\Claude\claude_desktop_config.json` 的 `mcpServers` |

字段对照：
- `command` / `args` / `env` / `cwd` 原样照搬。
- `type: "http"` 或 `url = …` → `transport: streamable-http` + `url` + `headers`。
- Codex 的 `env_vars = ["X"]` → `env: { X: !!js process.env.X ?? '' }`。
- `tool_timeout_sec` → `toolCallTimeoutMs`（×1000）。`startup_timeout_sec` 没有对应字段，丢掉即可。
- 只针对某一个项目的参数（比如指定默认项目或实例），先问用户：保留，还是去掉让它通用。

## 验证（安装或修改后都要做）

在**短路径**目录里运行（dsh 在长路径下会直接退出）：

```bash
# 1. 配置能加载：输出里要能看到这一段
cd "$TEMP" && dsh --profile headless --patch ~/.dsh/patches/<name>-mcp.yml --dump-config 2>&1 | grep -A4 "id: mcp-<name>"
# 2. 真的能连上：exit 0，并且工具数大于 0
cd "$TEMP" && timeout 300 dsh --profile headless --patch ~/.dsh/patches/<name>-mcp.yml "列出所有 mcp__<name>__ 开头的工具名，不要调用任何工具。第一行写：RESULT: OK 工具数: <N>"
```

3. 满足前提条件后，让它调用一个**只读**工具，确认返回的是真实数据。

失败怎么排查：
- exit 1，stderr 里有 `invalid config`：多半是转发了一个没设置的变量，或者字段写错了。
- exit 1，报启动错误：命令找不到、依赖没装、服务没启动。
- exit 0 但工具数是 0：server 启动了但没有注册任何工具，去看这个 server 自己的日志。

## 更新

直接改 patch 文件，比如换版本号、改参数，然后重新验证。`serverName` 尽量不要改，改了之后工具名就变了，已经写好的 brief 和计划里用到的旧工具名都会失效。

## 卸载

1. 确认要删哪个：`head -n 4 ~/.dsh/patches/<name>-mcp.yml`。
2. **先征得用户同意**，再删除 `~/.dsh/patches/<name>-mcp.yml`。
3. 在项目里搜一下还有没有引用：`grep -rn "<name>-mcp.yml" .`。有的话，提醒用户那些 brief 或计划需要更新。

server 本身安装的依赖（npm 包、uv 缓存、服务进程）不在 dsh 管理范围内，要不要清理由用户决定。

## 一直加载（不推荐）

每次都写 `--patch` 嫌麻烦的话，可以建一个自定义 profile：`dsh --profile <名字> --from-default-profile headless`，把 insert 写进 `~/.dsh/profiles/<名字>/cordis.patch.yml`，以后用 `--profile <名字>` 调用。代价是这个 profile 下的所有任务都会带上这些工具定义，每次请求都更贵。
