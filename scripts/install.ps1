# Select exactly one host for each install/update/uninstall operation.
param(
    [ValidateSet('Claude', 'Codex')][string]$Target,
    [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
if (-not $Target) { throw 'Specify -Target Claude or -Target Codex. No default host is installed or uninstalled.' }
$Repo = Split-Path -Parent $PSScriptRoot
$PkgName = 'claude-deepseek-bridge'
$SkillsSrc = Join-Path $Repo 'skill'
$StateDir = Join-Path $env:USERPROFILE ".$PkgName"
$BackupDir = Join-Path $StateDir 'backups'
$Clients = @{
    Claude = @{ Root = (Join-Path $env:USERPROFILE '.claude\skills'); Manifest = (Join-Path $StateDir 'installed-skills.txt') }
    Codex = @{ Root = (Join-Path $env:USERPROFILE '.agents\skills'); Manifest = (Join-Path $StateDir 'installed-skills-codex.txt') }
}
$Selected = @($Target)
$script:changed = 0
function Say($tag, $msg, $color) { Write-Host ('  [{0}] ' -f $tag) -ForegroundColor $color -NoNewline; Write-Host $msg }
function Ok($msg) { Say ' ok ' $msg 'DarkGray' }
function Did($msg) { Say 'done' $msg 'Green'; $script:changed++ }
function Warn($msg) { Say 'warn' $msg 'Yellow' }
function Section($msg) { Write-Host ''; Write-Host $msg -ForegroundColor Cyan }

function Backup($path, $label) {
    New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
    $suffix = (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
    $bak = Join-Path $BackupDir ('{0}.{1}.bak' -f ($label -replace '[\\/:~]', '_'), $suffix)
    Copy-Item -LiteralPath $path -Destination $bak -Recurse -Force
    return $bak
}
function Get-InstalledSkills($client) {
    $manifest = $Clients[$client].Manifest
    if (Test-Path -LiteralPath $manifest) {
        foreach ($name in Get-Content -LiteralPath $manifest) {
            $name = $name.Trim()
            if (-not $name) { continue }
            if ($name -notmatch '^[a-z0-9][a-z0-9-]{0,63}$') { throw "Invalid skill name in $($manifest): $name" }
            $name
        }
    }
}
# Verify the exact destination and reject links before copying/removing a skill.
function Get-SkillPath($client, $name) {
    if ($name -notmatch '^[a-z0-9][a-z0-9-]{0,63}$') { throw "Invalid skill name: $name" }
    $root = [IO.Path]::GetFullPath($Clients[$client].Root).TrimEnd('\')
    $dst = [IO.Path]::GetFullPath((Join-Path $root $name))
    if (-not $dst.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "Skill path escapes destination: $dst" }
    $ancestor = $dst
    while ($ancestor) {
        if (Test-Path -LiteralPath $ancestor) {
            $item = Get-Item -LiteralPath $ancestor -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Linked skill path needs manual handling: $ancestor" }
        }
        $ancestor = Split-Path -Parent $ancestor
    }
    if (Test-Path -LiteralPath $dst) {
        foreach ($item in Get-ChildItem -LiteralPath $dst -Recurse -Force) {
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Linked skill content needs manual handling: $($item.FullName)" }
        }
    }
    return $dst
}
function Remove-Skill($client, $name) {
    $dst = Get-SkillPath $client $name
    if (Test-Path -LiteralPath $dst) {
        $bak = Backup $dst "$client-$name"
        Remove-Item -LiteralPath $dst -Recurse -Force
        Did "$client skill $name removed (backup: $bak)"
    }
}
function Sync-File($src, $dst, $label) {
    if (Test-Path -LiteralPath $dst) {
        if ((Get-FileHash -LiteralPath $src).Hash -eq (Get-FileHash -LiteralPath $dst).Hash) { Ok "$label up to date"; return }
        $bak = Backup $dst $label
        Copy-Item -LiteralPath $src -Destination $dst -Force
        Did "$label updated (backup: $bak)"
    } else {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
        Copy-Item -LiteralPath $src -Destination $dst -Force
        Did "$label installed"
    }
}
function Get-NpmPrefix {
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw 'npm is required.' }
    $prefix = & npm prefix -g
    if ($LASTEXITCODE -ne 0 -or -not $prefix) { throw 'Cannot read npm global prefix.' }
    return ($prefix | Out-String).Trim()
}
function Test-BridgeLinked($prefix) {
    $link = Join-Path $prefix "node_modules\$PkgName"
    if (-not (Test-Path -LiteralPath $link)) { return $false }
    $item = Get-Item -LiteralPath $link -Force
    $linkedPath = if ($item.Target) { @($item.Target)[0] } else { $item.FullName }
    if (-not [IO.Path]::IsPathRooted($linkedPath)) { $linkedPath = Join-Path (Split-Path -Parent $link) $linkedPath }
    return [IO.Path]::GetFullPath($linkedPath).TrimEnd('\') -ieq [IO.Path]::GetFullPath($Repo).TrimEnd('\')
}
function Remove-LegacyShims($prefix) {
    foreach ($name in 'dsv', 'dsv.cmd', 'dsv.ps1') {
        $file = Join-Path $prefix $name
        if ((Test-Path -LiteralPath $file) -and ((Get-Content -LiteralPath $file -Raw) -match '\.dsh[\\/]+bin[\\/]+dsv\.mjs')) {
            $null = Backup $file "legacy-$name"
            Remove-Item -LiteralPath $file -Force
            Did "Removed legacy launcher $name"
        }
    }
}
if ($Uninstall) {
    Section "Uninstall: $($Selected -join ', ')"
    foreach ($client in $Selected) { foreach ($name in @(Get-InstalledSkills $client)) { $null = Get-SkillPath $client $name } }
    foreach ($client in $Selected) {
        foreach ($name in @(Get-InstalledSkills $client)) { Remove-Skill $client $name }
        if (Test-Path -LiteralPath $Clients[$client].Manifest) { Remove-Item -LiteralPath $Clients[$client].Manifest -Force }
    }
    $remaining = @('Claude', 'Codex' | ForEach-Object { Get-InstalledSkills $_ })
    if ($remaining.Count) { Ok 'Another host is installed; keeping shared dsb / dsv commands.' }
    else {
        $prefix = Get-NpmPrefix
        if (Test-BridgeLinked $prefix) {
            & npm unlink -g $PkgName --ignore-scripts --no-fund --no-audit | Out-Host
            if ($LASTEXITCODE -ne 0) { throw "npm unlink failed (exit $LASTEXITCODE)." }
            Did 'Removed shared dsb / dsv commands.'
        } else { Ok 'No global link to this checkout; leaving other installations alone.' }
        Remove-LegacyShims $prefix
    }
    Ok 'dsh, credentials, MCP patches and job history are preserved.'
    return
}
Write-Host "claude-deepseek-bridge: $($Selected -join ', ')" -ForegroundColor Cyan
Write-Host "Checkout: $Repo" -ForegroundColor DarkGray
Section '1/3 Dependencies and source checks'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js >= 23.8 is required.' }
$nodeVer = [version]((& node --version).TrimStart('v'))
if ($nodeVer -lt [version]'23.8.0') { throw "Node.js >= 23.8 required for zstd; found $nodeVer." }
Ok "Node.js $nodeVer"
$prefix = Get-NpmPrefix
if (Get-Command dsh -ErrorAction SilentlyContinue) { Ok "dsh $((& dsh --version).Trim())" }
else { Warn 'Install dsh with: npm i -g @deepseek-ai/dsh, then configure its authentication before delegating.' }
foreach ($entry in 'bin\dsv.mjs', 'bin\dsb.mjs', 'lib\bridge.mjs', 'lib\sessions.mjs') {
    & node --check (Join-Path $Repo $entry)
    if ($LASTEXITCODE -ne 0) { throw "Source check failed: $entry" }
}
$repoSkills = @(Get-ChildItem -LiteralPath $SkillsSrc -Directory | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'SKILL.md') } | ForEach-Object Name)
if (-not $repoSkills.Count) { throw 'No skills found in this checkout.' }
foreach ($client in $Selected) {
    foreach ($name in @($repoSkills + @(Get-InstalledSkills $client) | Sort-Object -Unique)) { $null = Get-SkillPath $client $name }
}
Section '2/3 Skills'
foreach ($client in $Selected) {
    foreach ($name in $repoSkills) {
        $src = Join-Path $SkillsSrc $name
        $dst = Get-SkillPath $client $name
        foreach ($file in Get-ChildItem -LiteralPath $src -File -Recurse) {
            $rel = $file.FullName.Substring($src.Length).TrimStart('\')
            Sync-File $file.FullName (Join-Path $dst $rel) "$client/$name/$rel"
        }
    }
    foreach ($old in @(Get-InstalledSkills $client)) { if ($repoSkills -notcontains $old) { Remove-Skill $client $old } }
    New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
    $want = ($repoSkills -join [Environment]::NewLine) + [Environment]::NewLine
    $manifest = $Clients[$client].Manifest
    if (-not (Test-Path -LiteralPath $manifest) -or (Get-Content -LiteralPath $manifest -Raw) -ne $want) {
        [IO.File]::WriteAllText($manifest, $want)
    }
    Ok "$client skills: $($Clients[$client].Root)"
}
Section '3/3 Shared commands'
Remove-LegacyShims $prefix
if ((Test-BridgeLinked $prefix) -and (Test-Path -LiteralPath (Join-Path $prefix 'dsv.cmd')) -and (Test-Path -LiteralPath (Join-Path $prefix 'dsb.cmd'))) {
    Ok 'dsb / dsv already linked to this checkout.'
} else {
    Push-Location $Repo
    try {
        & npm link --offline --ignore-scripts --package-lock=false --no-fund --no-audit | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "npm link failed (exit $LASTEXITCODE)." }
    } finally { Pop-Location }
    if (-not (Test-BridgeLinked $prefix)) { throw 'npm link did not create the expected global link.' }
    Did 'Linked dsb / dsv to this checkout; keep this directory in place.'
}
foreach ($name in 'dsb', 'dsv') {
    if (-not (Test-Path -LiteralPath (Join-Path $prefix "$name.cmd"))) { throw "Missing global launcher: $name" }
    $command = Get-Command $name -ErrorAction SilentlyContinue
    if ($command) { Ok "$($name): $($command.Source)" }
    else { Warn "$name is not on PATH; add $prefix to PATH or open a new terminal." }
}
Write-Host ''
if ($script:changed) { Write-Host "Complete: $($script:changed) changes. Reopen the host session if skills do not appear." -ForegroundColor Green }
else { Write-Host 'Everything is up to date.' -ForegroundColor Green }
Write-Host 'Delegate: dsb run --cwd <project> --brief <file>. Sessions: dsv. Usage: dsb stats.'
