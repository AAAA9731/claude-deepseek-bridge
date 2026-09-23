# claude-deepseek-bridge 一键安装 / 更新（幂等：重复运行只更新有变化的部分）
#   .\scripts\install.ps1             安装或更新
#   .\scripts\install.ps1 -Uninstall  卸载本脚本安装的东西
# 装到：~/.claude/skills（Claude Code CLI 与 Claude 桌面 app 的 Code 标签共用）和全局 dsv 命令。
# 不碰 ~/.dsh/patches：dsh 的 MCP 由 dsh-mcp skill 按需安装、属于用户自己的配置。
param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'

$Repo      = Split-Path -Parent $PSScriptRoot
$PkgName   = 'claude-deepseek-bridge'
$SkillsSrc = Join-Path $Repo 'skill'
$SkillsDst = Join-Path $env:USERPROFILE '.claude\skills'
$StateDir  = Join-Path $env:USERPROFILE ".$PkgName"
$BackupDir = Join-Path $StateDir 'backups'          # kept out of the skills folder so Claude never loads it
$Manifest  = Join-Path $StateDir 'installed-skills.txt'

$script:changed = 0
function Say($tag, $msg, $color) { Write-Host ('  [{0}] ' -f $tag) -ForegroundColor $color -NoNewline; Write-Host $msg }
function Ok($msg)    { Say ' ok ' $msg 'DarkGray' }
function Did($msg)   { Say 'done' $msg 'Green'; $script:changed++ }
function Warn($msg)  { Say 'warn' $msg 'Yellow' }
function Section($t) { Write-Host ''; Write-Host $t -ForegroundColor Cyan }

function Backup($path, $label) {
    New-Item -ItemType Directory -Force $BackupDir | Out-Null
    $bak = Join-Path $BackupDir ('{0}.{1}.bak' -f ($label -replace '[\\/:~]', '_'), (Get-Date -Format 'yyyyMMdd-HHmmss'))
    Copy-Item $path $bak -Recurse -Force
    return $bak
}

# Copy one file if missing or different; back up a differing file before overwriting.
function Sync-File($src, $dst, $label) {
    if (Test-Path $dst) {
        if ((Get-FileHash $src).Hash -eq (Get-FileHash $dst).Hash) { Ok "$label 已是最新"; return }
        $bak = Backup $dst $label
        Copy-Item $src $dst -Force
        Did "$label 已更新（旧版备份到 $bak）"
    } else {
        New-Item -ItemType Directory -Force (Split-Path $dst) | Out-Null
        Copy-Item $src $dst -Force
        Did "$label 已安装"
    }
}

function Get-InstalledSkills { if (Test-Path $Manifest) { @(Get-Content $Manifest | Where-Object { $_.Trim() }) } else { @() } }

function Get-NpmPrefix { (& npm prefix -g).Trim() }

# Launchers written by hand before this repo existed; they point at ~/.dsh/bin/dsv.mjs.
function Remove-LegacyShims($prefix) {
    foreach ($name in 'dsv', 'dsv.cmd', 'dsv.ps1') {
        $p = Join-Path $prefix $name
        if ((Test-Path $p) -and ((Get-Content $p -Raw) -match '\.dsh[\\/]+bin[\\/]+dsv\.mjs')) {
            Remove-Item $p -Force
            Did "移除旧的 dsv 启动器 $name"
        }
    }
}

function Test-DsvLinked($prefix) {
    $link = Join-Path $prefix "node_modules\$PkgName"
    if (-not (Test-Path $link)) { return $false }
    $item = Get-Item $link -Force
    $target = if ($item.Target) { @($item.Target)[0] } else { $item.FullName }
    return ([IO.Path]::GetFullPath($target).TrimEnd('\') -ieq [IO.Path]::GetFullPath($Repo).TrimEnd('\')) -and
           (Test-Path (Join-Path $prefix 'dsv.cmd'))
}

$repoSkills = @(Get-ChildItem $SkillsSrc -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'SKILL.md') } | ForEach-Object Name)

# ── 卸载 ────────────────────────────────────────────────────────────────────
if ($Uninstall) {
    Section '卸载 claude-deepseek-bridge'
    $prefix = Get-NpmPrefix
    if (Test-Path (Join-Path $prefix "node_modules\$PkgName")) {
        Push-Location $Repo; try { & npm unlink -g $PkgName 2>$null | Out-Null } finally { Pop-Location }
        Did '已移除全局 dsv 命令'
    } else { Ok 'dsv 未通过 npm link 安装' }
    Remove-LegacyShims $prefix
    foreach ($name in @($repoSkills + (Get-InstalledSkills) | Sort-Object -Unique)) {
        $dst = Join-Path $SkillsDst $name
        if (Test-Path $dst) { Remove-Item $dst -Recurse -Force; Did "已删除 skill $name" }
    }
    if (Test-Path $Manifest) { Remove-Item $Manifest -Force }
    Ok '~/.dsh/patches 里的 MCP 配置保持不动（它们属于你自己的配置）'
    Write-Host ''
    Write-Host '卸载完成。' -ForegroundColor Green
    return
}

Write-Host 'claude-deepseek-bridge 安装 / 更新' -ForegroundColor Cyan
Write-Host "仓库：$Repo" -ForegroundColor DarkGray

# ── 1. 依赖 ─────────────────────────────────────────────────────────────────
Section '1/3 检查依赖'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw '找不到 Node.js，请先安装 Node.js 23.8 或更高版本。' }
$nodeVer = [version]((& node --version).TrimStart('v'))
if ($nodeVer -lt [version]'23.8.0') { throw "需要 Node.js >= 23.8（dsv 用到内置 zstd），当前是 $nodeVer" }
Ok "Node.js $nodeVer"
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw '找不到 npm。' }
Ok "npm $((& npm --version).Trim())"
if (Get-Command dsh -ErrorAction SilentlyContinue) { Ok "dsh $((& dsh --version).Trim())" }
else { Warn 'dsh 没装：npm i -g @deepseek-ai/dsh（装好并登录后，skill 才能真正调用 DeepSeek）' }

# ── 2. Skills ───────────────────────────────────────────────────────────────
Section "2/3 Skills → ~/.claude/skills（Claude Code CLI 与桌面 app 的 Code 标签共用）"
foreach ($name in $repoSkills) {
    $src = Join-Path $SkillsSrc $name
    foreach ($f in Get-ChildItem $src -File -Recurse) {
        $rel = $f.FullName.Substring($src.Length).TrimStart('\')
        Sync-File $f.FullName (Join-Path (Join-Path $SkillsDst $name) $rel) "$name/$($rel -replace '\\','/')"
    }
}
# Skills this script installed before but that no longer exist in the repo (renamed/removed).
foreach ($old in Get-InstalledSkills) {
    if ($repoSkills -notcontains $old) {
        $dst = Join-Path $SkillsDst $old
        if (Test-Path $dst) { $bak = Backup $dst "skill-$old"; Remove-Item $dst -Recurse -Force; Did "移除仓库里已不存在的 skill $old（备份到 $bak）" }
    }
}
New-Item -ItemType Directory -Force $StateDir | Out-Null
$want = ($repoSkills -join "`n") + "`n"
if (-not (Test-Path $Manifest) -or ((Get-Content $Manifest -Raw) -ne $want)) { [IO.File]::WriteAllText($Manifest, $want) }

# ── 3. dsv ──────────────────────────────────────────────────────────────────
Section '3/3 dsv 命令'
$prefix = Get-NpmPrefix
Remove-LegacyShims $prefix
if (Test-DsvLinked $prefix) {
    Ok 'dsv 已链接到本仓库'
} else {
    Push-Location $Repo
    try { & npm link --no-fund --no-audit 2>&1 | Out-Null; if ($LASTEXITCODE -ne 0) { throw "npm link 失败（exit $LASTEXITCODE）" } } finally { Pop-Location }
    if (-not (Test-DsvLinked $prefix)) { throw 'npm link 之后没找到指向本仓库的 dsv，请检查 npm 全局目录权限。' }
    Did "dsv 已链接 -> $Repo\bin\dsv.mjs（改仓库代码立即生效）"
}

# ── 自检 ────────────────────────────────────────────────────────────────────
Section '自检'
$fail = 0
foreach ($name in $repoSkills) {
    if (Test-Path (Join-Path $SkillsDst "$name\SKILL.md")) { Ok "skill $name" } else { Warn "skill $name 缺失"; $fail++ }
}
& node --check (Join-Path $Repo 'bin\dsv.mjs'); if ($LASTEXITCODE -eq 0) { Ok 'dsv.mjs 语法正常' } else { Warn 'dsv.mjs 语法检查失败'; $fail++ }
$dsvCmd = Get-Command dsv -ErrorAction SilentlyContinue
if ($dsvCmd) { Ok "PATH 中的 dsv：$($dsvCmd.Source)" } else { Warn 'PATH 里找不到 dsv（新开一个终端再试）'; $fail++ }

Write-Host ''
if ($fail) { Write-Host "完成，但有 $fail 项自检没通过，见上面的 warn。" -ForegroundColor Yellow }
elseif ($script:changed) { Write-Host "安装 / 更新完成（$($script:changed) 项有变化）。新开的 Claude Code 会话即可使用；已经开着的会话需要重开。" -ForegroundColor Green }
else { Write-Host '一切已是最新，没有改动。' -ForegroundColor Green }
Write-Host '给 DeepSeek 装 MCP：在 Claude Code 里说「给 dsh 装 xxx MCP」。查看会话：dsv' -ForegroundColor DarkGray
