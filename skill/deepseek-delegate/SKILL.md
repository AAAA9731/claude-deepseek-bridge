---
name: deepseek-delegate
description: Use when a task or sub-task has a clear spec and a checkable result — file organizing, format conversion, first-draft or boilerplate code, implementing one task of a written plan, writing tests, batch edits, read-only codebase surveys, running a regression/build and reporting, routine work through an MCP server (e.g. an editor or database) — and could be done by the local DeepSeek agent (dsh) instead of Claude to save tokens. Also when the user says "交给 DeepSeek" / "用便宜模型" / "delegate to deepseek".
---

# DeepSeek 委派（dsh headless）

本机装有 DeepSeek Harness CLI（`dsh`，npm 包 `@deepseek-ai/dsh`，模型 deepseek-flash）。它是完整的编码 agent，能读写文件、跑 PowerShell，也能按需加载 MCP server，价格远低于 Claude。**分工：Claude 负责定方案、写 brief、验收和收尾；dsh 负责干活。** dsh 的产出只算初稿，Claude 验收后才能告诉用户完成。

## 派不派

判断标准：**能写出一份不需要中途沟通的 brief，并且有办法快速验证结果**，就派出去。

| 派给 dsh | Claude 自己做 |
|---|---|
| 实施计划里的**一个** Task（代码已经写在计划或 spec 里） | 定方案、写计划、跨模块做取舍 |
| 按参照文件写初版代码、转换器、校验、测试 | 难定位的 bug，并发、性能、安全问题 |
| 只读调查：读很多文件，把报告写到文件里 | 需求还模糊，需要和用户来回确认 |
| 跑编译、回归、黄金比对，并按固定格式报告 | 一两行的小改动（写 brief 比自己改还贵） |
| 批量重命名、格式转换、机械性的批量修改 | 删除重要数据、git 提交或推送、对外发布 |

**规模上限**：一次只派一个计划 Task。实际数据里 5–16 分钟、100–250 次工具调用都能正常完成。指令接近 10K 字、同时改好几个子系统的任务中断过。更大的活先拆开，每个做完就验收，再派下一个。

## 调用

```bash
cd "<项目目录>" && timeout 2700 dsh --profile headless "$(cat "$TEMP/brief-xxx.md")" > "$TEMP/dsh-xxx.out" 2> "$TEMP/dsh-xxx.err"
```

- **必须后台运行**：Bash 工具加 `run_in_background: true`，做完会通知你。前台 Bash 最多等 10 分钟，超时会把 dsh 杀掉，而大一点的 Task 常常超过 10 分钟。
- **brief 先写进文件**，放在 `$TEMP` 或项目的 `.superpowers/…` 目录下。长需求可以放在 brief 里，或者在 brief 里写明「先完整阅读 <路径>」。
- stdout 是最终报告，stderr 是推理过程，出问题时再看。
- 每次调用都是**全新会话**，不记得之前的内容，brief 必须自包含。dsh 也没法中途问你问题：遇到拿不准的地方，它会停下来写进报告。
- **需要 MCP 工具时**：先运行 `head -n 4 ~/.dsh/patches/*-mcp.yml`，看已经装了哪些 MCP，以及各自的用途、前提和用法。然后用 `--patch <文件>` 加载需要的那几个，可以写多次。每个文件的「前提」要先确认满足。缺少需要的 MCP 时，用 **dsh-mcp** skill 安装。不需要 MCP 的任务一个都不要加，因为工具定义会让每次请求都多出大量 token。
- 工作目录要用**短路径**的项目根目录。路径太长时，dsh 会直接以 exit 126 退出。
- 不要让两个 dsh **同时改同一批文件**。不相关的任务可以并行派出。

## brief 模板

```
【目标】一句话说清要做成什么。
【位置】当前目录是 <项目> 根目录。先读：<spec/计划/参照文件的准确路径>
【要求】
- 具体规则（代码逐字照抄计划里的代码块 / 模仿 <文件> 的写法 / 数值不能改）
- 允许执行的命令：<比如 git -c safe.directory='<项目路径>' status/diff（只读）>
【限制】只改或只新建 <文件列表>；不删除文件；不 git add/commit；不安装依赖。
  用到 MCP 时：列出它可以调用的工具或操作；能执行任意代码的工具（比如 execute_code）只能跑本指令或计划里给出的代码；构建、发布、删除这类工具不要调用；有状态的对象（场景、文档、数据库）改完要保存，结束时恢复到原来的状态。
  遇到指令矛盾、文件不存在、要求无法满足：停下来，在报告里写清楚，不要自己变通。
【完成后】运行 <验证命令>。报告第一行固定写成：
  RESULT: OK|FAIL|BLOCKED  差异: <无/简述>  原因: <-/简述>
  然后列出：改动或新建的文件，验证结果，需要 Claude 决定的问题。
```

派出去之前自查一遍：
1. brief 里的每个路径都实际存在。「not found」大多是 brief 写错了路径。
2. 要求和限制之间没有矛盾。比如一边写「不执行 git」，一边又要求「先用 git diff 看改动」。
3. 需要跑沙箱外命令的步骤，要么交给 Claude 自己做，要么在 brief 里说明跳过。

## 常见报错

| 报错 | 原因 | 怎么处理 |
|---|---|---|
| `sandbox escalation to "danger-full-access" requires approval, but no approval channel is available` | 命令要访问工作区外面（比如调用外部脚本、写系统目录）。headless 模式没法弹出审批，所以直接拒绝 | 把这一步留给 Claude 自己跑。只有用户明确同意时，才能用 `DSH_PERMISSION_MODE=danger-full-access` 关掉沙箱 |
| `detected dubious ownership` | 沙箱用受限令牌运行 git | 在 brief 里写明要用 `git -c safe.directory='<路径>' …` |
| `cannot modify …: file has not been read` | dsh 的写入规则要求先读后写 | 它通常会自己修复。brief 里可以提示「覆盖已有文件前先读一遍」 |
| `ReplaceFileW EIO (Win32 1175)` / rg `IO error` | 文件被编辑器、IDE 或其他程序暂时占用 | 属于偶发错误，重试即可。验收时要确认这个文件最后确实写进去了 |
| `cannot read …: not found` | brief 里的路径写错了，或者文件已经被移动 | 派之前核对路径 |
| exit 126 `path longer than allowed` | 工作目录路径太长 | 换短路径 |

## 验收（必须做）

1. 派之前记下 `git status`。做完后用 `git status` 和 `git diff` 看**实际改动**，不要只信 dsh 的自述。
2. 先看报告第一行。OK 也要抽查，FAIL 和 BLOCKED 要读完整报告。报告很长时，如果装了 `local-sieve` skill，可以先用它筛一遍。
3. 自己跑一次验证：编译、测试、脚本试跑。用到 MCP 的任务，Claude 再用自己的同一个 MCP，或者只读查询，核对一下最终状态。
4. 小问题 Claude 直接修。大问题带着具体错误重新派一次，最多重派 2 次，还不行就 Claude 自己做。
5. 向用户汇报时，说清楚哪些是 dsh 做的，Claude 验证或修正了什么。

## 中断与续做

dsh 被杀掉或者卡住时（`dsv ls` 里显示「已中断」），**不要从头重派**。重新派一次，在 brief 最前面加上：

```
【续做说明】上次执行到一半中断了，工作区已有部分改动：<git status 列出的文件>。
先用 git diff 和读文件弄清哪些已经完成、完成得对不对，只补完剩下的部分，并修正不符合要求的地方，不要推倒重来。下面是原任务的完整要求。
```

## 查看 dsh 在做什么

`dsv show latest --no-reasoning`（或 `dsv show <id前缀>`）可以看 dsh 的完整过程：调用了哪些工具、结果是什么、哪里报了错。`dsv ls` 列出会话和状态。用户在自己的终端里直接运行 `dsv`，会打开一个实时的 TUI。Claude 的 Bash 里没有 TTY，运行 `dsv` 只会得到普通列表，不会卡住。
