# 故障与恢复

仅在调用失败、长时间没有进展或需要续做时读取。

| 现象 | 处理 |
|---|---|
| `sandbox escalation ... requires approval, but no approval channel is available` | headless 无法交互审批。由主代理在已有授权内处理受阻步骤，或报告需要的权限；不要自动关闭沙箱。 |
| `detected dubious ownership` | 确认是本次授权项目后，在该条 Git 命令使用 `git -c safe.directory='<项目路径>' ...`，不改全局信任配置。 |
| `cannot modify ...: file has not been read` | 覆盖已有文件前先读取，核对是否有其他进程改动。 |
| `ReplaceFileW EIO (Win32 1175)` / 文件占用相关 IO error | 先检查文件当前内容和占用情况。确认是暂时性失败后重试受影响步骤，验收实际写入结果，不盲目重跑整个任务。 |
| `cannot read ...: not found` | 核对路径与工作目录。可在授权范围内定位已移动的文件；无法确认正确目标时报告阻塞。 |
| exit 126 `path longer than allowed` | 检查工作目录长度。使用同一授权项目已有的短路径入口，或由主代理处理；不要自行复制、移动仓库或改到其他项目执行。 |
| `invalid config` / MCP 启动失败 | 使用 `dsh-mcp` skill 检查所加载的 patch、依赖和必需环境变量；不要在诊断输出中打印凭据。 |

## 确认是否结束

先查 `dsb status <ID>` 和宿主任务记录：Claude Code 查看后台任务，Codex 查看对应命令会话及退出码。宿主工具返回 `session_id` 只表示命令仍在运行，不能当作任务完成。`dsv` 的“有更新/无更新”只描述日志：五分钟无新日志可能只是长命令在运行，不能用它判定进程是否结束。

`dsb cancel <ID>` 返回的是取消请求已排队。等作业进入 `cancelled` 后才重派。`cleanup_failed` 表示进程树清理未确认成功，`unknown` 表示启动器意外结束且缺少退出记录；两者都保留锁。检查作业记录中的进程和部分成果，确认原任务及相关子进程停止后，才用 `dsb unlock <ID> --confirmed-stopped` 清理本作业的锁，再创建新任务。不要删除别人的锁或仅按超时猜测进程已经退出。

任务仍在运行时先检查当前进度。headless 没有交互式追问或原地追加任务接口；`dsb retry` 也是携带原始要求与修复反馈的新会话。

## 从部分成果续做

确认旧任务结束，检查现有改动与派单前基线，保留已验证的成果。新的 brief 应包含必要的原始目标、限制及验收条件，并加上：

```text
【续做】上次任务已结束，原因：<实际退出/取消/失败原因>。
已确认完成：<成果与证据>。待处理：<失败或未完成部分>。
相关改动/日志：<路径>。其中已有用户改动：<需要保留的内容>。
先核对当前状态，再补齐剩余工作；不要推倒重来，不重复已完成的外部操作。
```

外部应用操作超时且结果不明确时，先只读查询其当前状态，再决定是否重试。无法确认执行结果时报告不确定性，不通过重复操作猜测成功与否。

## 没有 dsb 时直接调用

先确认是否只是 PATH 尚未更新；两个宿主都可以用 `node "<仓库>/bin/dsb.mjs" ...`。确实无法使用启动器时，按实际 shell 选择直接调用方式，仍由宿主保留并管理进程。分别记录宿主会话 ID、报告、错误日志和实际退出码。

Git Bash 示例（需要可用的 `timeout` 命令）：

```bash
cd "<项目目录>" && timeout 2700 dsh --profile headless "$(cat "$TEMP/brief-xxx.md")" > "$TEMP/dsh-xxx.out" 2> "$TEMP/dsh-xxx.err"
```

PowerShell 没有对应的 GNU `timeout`；只有宿主执行工具能提供足够的超时及终止控制时才直接调用：

```powershell
$dshBrief = Get-Content -LiteralPath '<brief 文件>' -Raw -Encoding UTF8
Set-Location -LiteralPath '<项目目录>'
& dsh --profile headless $dshBrief 1> '<报告文件>' 2> '<错误日志>'
exit $LASTEXITCODE
```

按任务调整超时，必要时加 `--patch`。直接调用没有桥接锁、作业记录和自动关联用量，主代理自行协调范围并确认终止。不能控制生命周期时先恢复 `dsb`，不要以丢弃进程句柄或无限等待替代。不要将其他会话的 `latest` 结果当作本次任务报告。
