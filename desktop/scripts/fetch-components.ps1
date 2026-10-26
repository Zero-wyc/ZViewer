# 填充仓库的组件库 public/：cloudflared 与 EasyTier。
#
# 这两个二进制**不进桌面运行包**，而是放在仓库 public/ 里随仓库同步到 GitCode；
# GUI 第一次用到时按 GitCode 直链下载（desktop/controller/components.go）。
# 本脚本只给维护者用：升级组件版本时改下面的版本号跑一次，再同步 Go 里的 Version。
# 桌面端下载时**不做** SHA-256 校验，这里的摘要只用来判断本地缓存是不是要的那个版本。
#
#   powershell -ExecutionPolicy Bypass -File scripts/fetch-components.ps1
#
# 已存在且摘要一致的文件会跳过；是别的版本则重新下载覆盖。
$ErrorActionPreference = 'Stop'
$desktopDir = Split-Path -Parent $PSScriptRoot
$repoDir = Split-Path -Parent $desktopDir
$publicDir = Join-Path $repoDir 'public'
New-Item -ItemType Directory -Path $publicDir -Force | Out-Null

function File-Sha256([string]$File) {
    $stream = [IO.File]::OpenRead($File)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $algorithm.Dispose(); $stream.Dispose() }
}

function Fetch-Verified([string]$Url, [string]$File, [string]$Sha256) {
    if (Test-Path -LiteralPath $File) {
        if ((File-Sha256 $File) -ieq $Sha256) {
            Write-Output "已存在且是同一版本：$(Split-Path -Leaf $File)"
            return
        }
        Write-Output "已有文件是其他版本，重新下载：$(Split-Path -Leaf $File)"
    }
    $temp = "$File.download"
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $client = New-Object Net.WebClient
    $client.Headers['User-Agent'] = 'ZViewer-Components'
    try { $client.DownloadFile($Url, $temp) } finally { $client.Dispose() }
    if ((File-Sha256 $temp) -ine $Sha256) {
        Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
        throw "下载内容与记录的 SHA-256 不一致（上游换了文件？先核对版本）：$Url"
    }
    Move-Item -LiteralPath $temp -Destination $File -Force
    Write-Output "已下载并校验：$(Split-Path -Leaf $File)"
}

# cloudflared：GUI 的 Cloudflare Tunnel 组件（单文件）。
$cloudflaredVersion = '2026.10.3'
Fetch-Verified "https://github.com/cloudflare/cloudflared/releases/download/$cloudflaredVersion/cloudflared-windows-amd64.exe" `
    (Join-Path $publicDir 'cloudflared-windows-amd64.exe') `
    '76b2805253d0d6ffacb092a7acfbee99e7af6917835c0c5410e23f3ef5052da2'

# EasyTier：虚拟组网组件。原样保存官方 zip（GUI 安装时只解出 core/cli 与两个驱动）。
$etVersion = '2.6.4'
Fetch-Verified "https://github.com/EasyTier/EasyTier/releases/download/v$etVersion/easytier-windows-x86_64-v$etVersion.zip" `
    (Join-Path $publicDir "easytier-windows-x86_64-v$etVersion.zip") `
    '27af91e270e554709b048bd32327fefd2dfce5062ae1e8701af7550c6f525f84'
# LGPL-3.0 要求随二进制一起分发许可证全文（二进制未做任何修改）。
Fetch-Verified "https://raw.githubusercontent.com/EasyTier/EasyTier/v$etVersion/LICENSE" `
    (Join-Path $publicDir 'LICENSE-EasyTier.txt') `
    'e3a994d82e644b03a792a930f574002658412f62407f5fee083f2555c5f23118'

Write-Output ''
Write-Output '组件库已就绪：public/cloudflared-windows-amd64.exe、public/easytier-windows-x86_64-v2.6.4.zip'
Write-Output '升级版本后请同步 desktop/controller/components.go 里的 Version（Size 只用于进度显示，可顺手改）。'
