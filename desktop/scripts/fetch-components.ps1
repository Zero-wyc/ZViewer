# 拉取桌面端的可选组件：cloudflared、EasyTier 与 FRP（维护者用）。
#
# 语音组件 livekit **随包分发**（build-all 从 backend-go/dev-bin 复制），不归本脚本管：
# 它的版本钉在 backend-go/internal/livekit/livekit.go 的 BinaryVersion，组件库那份只是
# 「被用户删掉时补回来」用的兜底（官方 zip 里只留 livekit-server.exe + LICENSE）。
#
# 这几个二进制**不进桌面运行包**，也不在源码仓库里：它们放在 Zero-wyc/ZviewerRelease
# 的 components 分支（组件库），GUI 第一次用到时按 GitCode 直链下载
# （desktop/controller/components.go）。2026-10-30 前 cloudflared / EasyTier 在本仓库的
# public/，同日起 FRP 也从「随包带」改为按需下载。
#
# 本脚本只负责把这几个文件按钉死的版本下载到 desktop/.components/（已 gitignore），
# 再顺手算出 SHA-256 供更新 components.json。推分支仍由维护者手动完成：
#
#   powershell -ExecutionPolicy Bypass -File scripts/fetch-components.ps1
#   # 然后把 .components 里的文件推到 ZviewerRelease 的 components 分支：
#   git clone --branch components https://github.com/Zero-wyc/ZviewerRelease.git
#   # 覆盖文件、改 components.json 的 version/size/sha256、提交推送
#
# 已存在且摘要一致的文件会跳过；是别的版本则重新下载覆盖。
$ErrorActionPreference = 'Stop'
$desktopDir = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $desktopDir '.components'
New-Item -ItemType Directory -Path $outDir -Force | Out-Null

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
    (Join-Path $outDir 'cloudflared-windows-amd64.exe') `
    '76b2805253d0d6ffacb092a7acfbee99e7af6917835c0c5410e23f3ef5052da2'

# EasyTier：虚拟组网组件。原样保存官方 zip（GUI 安装时只解出 core/cli 与两个驱动）。
$etVersion = '2.6.4'
Fetch-Verified "https://github.com/EasyTier/EasyTier/releases/download/v$etVersion/easytier-windows-x86_64-v$etVersion.zip" `
    (Join-Path $outDir "easytier-windows-x86_64-v$etVersion.zip") `
    '27af91e270e554709b048bd32327fefd2dfce5062ae1e8701af7550c6f525f84'
# LGPL-3.0 要求随二进制一起分发许可证全文（二进制未做任何修改）。
Fetch-Verified "https://raw.githubusercontent.com/EasyTier/EasyTier/v$etVersion/LICENSE" `
    (Join-Path $outDir 'LICENSE-EasyTier.txt') `
    'e3a994d82e644b03a792a930f574002658412f62407f5fee083f2555c5f23118'

# FRP 客户端：FRP 穿透组件。原样保存官方 zip（GUI 安装时只解出 frpc.exe，服务端不打进包）。
$frpVersion = '0.71.1'
Fetch-Verified "https://github.com/fatedier/frp/releases/download/v$frpVersion/frp_${frpVersion}_windows_amd64.zip" `
    (Join-Path $outDir "frp_${frpVersion}_windows_amd64.zip") `
    'b90074b2b6a1d792a7a40f085ac6d276bcab2d1bc60201f8a86ca53ce65ce821'

Write-Output ''
Write-Output "组件已就绪：$outDir"
Get-ChildItem -LiteralPath $outDir -File | ForEach-Object {
    '{0}  {1,10}  {2}' -f (File-Sha256 $_.FullName), $_.Length, $_.Name
}
Write-Output ''
Write-Output '下一步：'
Write-Output '1. 把上面几个文件覆盖到 Zero-wyc/ZviewerRelease 的 components 分支根目录'
Write-Output '2. 同步该分支的 components.json（version/size/sha256）'
Write-Output '3. 升级了版本号时，同步 desktop/controller/components.go 的 Version 与 Size'
Write-Output '4. 打包用的许可证副本：desktop/assets/LICENSE-EasyTier.txt 与 LICENSE-FRP.txt 也要一起换'
