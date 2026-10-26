# 下载并校验构建分发包需要的第三方工具：只剩 FRP。
# Cloudflare / EasyTier 已改为可选组件，不在打包流程里下载，见 scripts/fetch-components.ps1。
# 缓存位于 desktop/.runtime/tools，重复构建命中缓存时仍校验 SHA-256。
$ErrorActionPreference = 'Stop'
$desktopDir = Split-Path -Parent $PSScriptRoot
$cacheDir = Join-Path $desktopDir '.runtime'
$toolsDir = Join-Path $cacheDir 'tools'
New-Item -ItemType Directory -Path $cacheDir,$toolsDir -Force | Out-Null
function File-Sha256([string]$File) {
    $stream = [IO.File]::OpenRead($File)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-','').ToLowerInvariant() }
    finally { $algorithm.Dispose(); $stream.Dispose() }
}
function Fetch-Verified([string]$Url, [string]$File, [string]$Sha256) {
    if (Test-Path -LiteralPath $File) {
        if ((File-Sha256 $File) -ieq $Sha256) { return }
        throw "Existing archive checksum mismatch: $File"
    }
    $temp = "$File.download"
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $client = New-Object Net.WebClient
    $client.Headers['User-Agent'] = 'ZViewer-Desktop-Build'
    try { $client.DownloadFile($Url,$temp) } finally { $client.Dispose() }
    if ((File-Sha256 $temp) -ine $Sha256) { throw "Downloaded archive checksum mismatch: $Url" }
    Move-Item -LiteralPath $temp -Destination $File
}
$frpArchive = Join-Path $toolsDir 'frp_0.71.1_windows_amd64.zip'
Fetch-Verified 'https://github.com/fatedier/frp/releases/download/v0.71.1/frp_0.71.1_windows_amd64.zip' $frpArchive 'b90074b2b6a1d792a7a40f085ac6d276bcab2d1bc60201f8a86ca53ce65ce821'
if (-not (Test-Path -LiteralPath (Join-Path $toolsDir 'frp_0.71.1_windows_amd64\frpc.exe'))) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($frpArchive,$toolsDir)
}
# 分发包只带客户端：缓存里也删掉服务端，避免误把 frps 打进包里。
foreach ($name in 'frps.exe','frps.toml') {
    Remove-Item -LiteralPath (Join-Path $toolsDir "frp_0.71.1_windows_amd64\$name") -Force -ErrorAction SilentlyContinue
}
Write-Output 'Pinned FRP archive verified'
