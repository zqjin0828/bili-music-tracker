# install.ps1 — 一键准备 B站听歌追踪器的可安装目录
#
# 作用：把 zip 解压到一个固定目录，然后打开 chrome://extensions/ 页面，
#       你只需要点「加载已解压的扩展程序」并选择下面打印出的路径即可。
#
# 用法（在本脚本所在目录）：
#   powershell -ExecutionPolicy Bypass -File .\install.ps1
#
# 或者指定 zip 路径：
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 -Zip .\bili-music-tracker-v1.3.1.zip

[CmdletBinding()]
param(
    [string]$Zip = "",
    [string]$Dest = "$env:USERPROFILE\bili-music-tracker"
)

$ErrorActionPreference = 'Stop'

function Write-Step($n, $msg) { Write-Host "[$n] $msg" -ForegroundColor Cyan }
function Write-Ok($msg)       { Write-Host "    OK  $msg" -ForegroundColor Green }
function Write-Warn2($msg)    { Write-Host "    !   $msg" -ForegroundColor Yellow }

Write-Host ""
Write-Host "B站听歌追踪器 · 安装准备" -ForegroundColor White
Write-Host "----------------------------------------" -ForegroundColor DarkGray
Write-Host ""

# ---- 1. 定位 zip ----
Write-Step 1 "定位压缩包"
if (-not $Zip) {
    $here = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
    $cand = Get-ChildItem -Path $here -Filter 'bili-music-tracker-v*.zip' -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending | Select-Object -First 1
    if ($cand) { $Zip = $cand.FullName }
}
if (-not $Zip -or -not (Test-Path $Zip)) {
    Write-Host ""
    Write-Host "找不到 zip 压缩包。" -ForegroundColor Red
    Write-Host "请把 bili-music-tracker-v1.3.1.zip 和本脚本放在同一目录，" -ForegroundColor Yellow
    Write-Host "或用 -Zip 参数指定路径。例如：" -ForegroundColor Yellow
    Write-Host '  powershell -ExecutionPolicy Bypass -File .\install.ps1 -Zip "C:\Users\你\Downloads\bili-music-tracker-v1.3.1.zip"' -ForegroundColor Gray
    exit 1
}
Write-Ok ("找到 " + (Split-Path $Zip -Leaf))

# ---- 2. 校验 zip 可解压 ----
Write-Step 2 "校验压缩包"
try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($Zip)
    $entryCount = $archive.Entries.Count
    $hasManifest = ($archive.Entries | Where-Object { $_.FullName -eq 'manifest.json' }).Count -gt 0
    $archive.Dispose()
} catch {
    Write-Host "压缩包损坏或不是合法 zip：$($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
if (-not $hasManifest) {
    Write-Warn2 "包内没找到 manifest.json —— 可能不是扩展包，继续但请自行确认"
} else {
    Write-Ok "$entryCount 个条目，manifest.json 存在"
}

# ---- 3. 解压 ----
Write-Step 3 "解压到目标目录"
if (Test-Path $Dest) {
    $backup = "$Dest.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Write-Warn2 "目标目录已存在，先备份到 $(Split-Path $backup -Leaf)"
    Move-Item -Path $Dest -Destination $backup -Force
}
New-Item -ItemType Directory -Path $Dest -Force | Out-Null
Expand-Archive -Path $Zip -DestinationPath $Dest -Force
Write-Ok $Dest

# ---- 4. 检查解压结果 ----
Write-Step 4 "检查关键文件"
$need = @('manifest.json', 'background.js', 'popup\popup.html', 'popup\popup.js',
          'popup\popup.css', 'src\ai-client.js', 'src\fav-index.js', 'src\content.js')
$missing = @()
foreach ($f in $need) {
    if (Test-Path (Join-Path $Dest $f)) { Write-Ok $f } else { $missing += $f }
}
if ($missing.Count -gt 0) {
    Write-Host ""
    Write-Host "以下文件缺失，扩展可能无法加载：" -ForegroundColor Red
    $missing | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
    Write-Host "请重新下载完整的 zip 包。" -ForegroundColor Yellow
    exit 1
}

# ---- 5. 复制到剪贴板 + 打开扩展页 ----
Write-Step 5 "打开浏览器扩展管理页"
Set-Clipboard -Value $Dest
Write-Ok "路径已复制到剪贴板"

$opened = $false
foreach ($browser in @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
)) {
    if (Test-Path $browser) {
        Start-Process $browser "chrome://extensions/"
        Write-Ok ("已打开 " + (Split-Path $browser -Leaf))
        $opened = $true
        break
    }
}
if (-not $opened) {
    Write-Warn2 "没找到 Chrome / Edge，请手动打开浏览器访问 chrome://extensions/"
}

# ---- 完成 ----
Write-Host ""
Write-Host "----------------------------------------" -ForegroundColor DarkGray
Write-Host "准备完成！接下来只需 3 步：" -ForegroundColor White
Write-Host ""
Write-Host "  1. 在打开的扩展页右上角，打开「开发者模式」开关" -ForegroundColor White
Write-Host "  2. 点左上角「加载已解压的扩展程序」" -ForegroundColor White
Write-Host "  3. 在弹出的选择框里，粘贴刚刚复制的路径（Ctrl+V）并确定" -ForegroundColor White
Write-Host ""
Write-Host "  目录路径：" -NoNewline -ForegroundColor Gray
Write-Host $Dest -ForegroundColor Cyan
Write-Host ""
Write-Host "  提示：首次加载会请求「Cookie」权限（用于读取 bili_jct 以支持一键新建收藏夹），" -ForegroundColor DarkGray
Write-Host "        点「允许」即可。" -ForegroundColor DarkGray
Write-Host ""
