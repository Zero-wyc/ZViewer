#!/usr/bin/env pwsh
#Requires -Version 5.1

# ZViewer 一键启动脚本（单文件 exe 版，Windows）
# 命令：start | backend | stop | restart | status | logs | cert | https | help | menu
#
# 统一端口：前后端共用同一端口（默认 3333），由后端 exe 托管 frontend/dist 静态文件，
# 无需独立的前端 exe。

param(
    [Parameter(Position = 0)]
    [ValidateSet('start', 'backend', 'stop', 'restart', 'status', 'logs', 'cert', 'https', 'help', 'menu', '')]
    [string]$Command = 'menu',

    [Parameter(Position = 1)]
    [string]$HostArg = '',            # cert/https 的域名或 IP（缺省则交互选择）

    [switch]$Force,                   # 证书强制重新签发
    [switch]$Https                    # start 时使用 HTTPS
)

$ErrorActionPreference = "Stop"

# Force UTF-8 console output so Chinese text renders correctly
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$rootDir = $PSScriptRoot
if (-not $rootDir) { $rootDir = (Get-Location).Path }
$backendExe = Join-Path $rootDir "zviewer-backend.exe"
$logDir = Join-Path $rootDir "log"
$pidsFile = Join-Path $rootDir ".prod.pids.json"
$envFile = Join-Path $rootDir ".env"

# ==================== 工具函数 ====================

function Read-PidsFile {
    if (-not (Test-Path $pidsFile)) { return $null }
    try { return Get-Content $pidsFile -Raw | ConvertFrom-Json } catch { return $null }
}

function Write-PidsFile($backendPid) {
    @{
        backend  = @{ pid = $backendPid }
        frontend = $null
    } | ConvertTo-Json -Depth 3 | Set-Content -Path $pidsFile -Encoding UTF8
}

function Test-PortInUse($localPort) {
    $conn = Get-NetTCPConnection -LocalPort $localPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    return $null -ne $conn
}

# 等待端口开始监听（后端初始化需要数秒）
function Wait-PortReady {
    param([int]$Port, [int]$TimeoutSeconds = 30)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-PortInUse $Port) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

function Stop-ProcessByPort($localPort) {
    $conn = Get-NetTCPConnection -LocalPort $localPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conn -and $conn.OwningProcess) {
        Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
    }
}

# 从 .env / 环境变量读取端口（与后端 dotenv 行为一致）
# 优先级：环境变量 > .env > 默认值（统一端口 3333）
function Read-PortValue {
    param([string]$Key)
    $envVal = [Environment]::GetEnvironmentVariable($Key)
    if ($envVal -match '^\d+$') { return [int]$envVal }
    if (Test-Path $envFile) {
        $line = Get-Content $envFile | Where-Object { $_ -match "^\s*$([regex]::Escape($Key))\s*=" } | Select-Object -First 1
        if ($line) {
            $val = ($line -split '=', 2)[1].Trim().Trim('"').Trim()
            if ($val -match '^\d+$') { return [int]$val }
        }
    }
    return $null
}

function Set-Ports {
    # 统一端口：前后端共用同一端口（默认 3333），由后端托管前端静态文件
    $portEnv = Read-PortValue -Key 'PORT'
    $script:Port = if ($portEnv) { $portEnv } else { 3333 }
}

function Test-Exe([string]$Exe, [string]$Name) {
    if (-not (Test-Path $Exe)) {
        Write-Host "  [错误] 未找到 $Name : $Exe" -ForegroundColor Red
        Write-Host "         请先运行 build-all 编译（含单文件可执行程序）"
        return $false
    }
    return $true
}

# ==================== 证书 ====================

# 交互选择证书签发类型（localhost / 公网域名）
function Select-CertHost {
    Write-Host ""
    Write-Host "  请选择证书签发类型："
    Write-Host "    [1] localhost（本机访问，默认，自签证书）"
    Write-Host "    [2] 公网域名或公网 IP（自动申请 Let's Encrypt 可信证书）"
    Write-Host "        - 域名：需已解析到本机，且 80 端口可访问（ACME HTTP-01 验证）"
    Write-Host "        - 公网 IP：Let's Encrypt 已支持（2026-01 GA），证书约 6 天有效，到期需重新签发"
    Write-Host "        - 内网 IP 无法通过 ACME 验证，请选 1 使用自签证书"
    $choice = Read-Host "  请输入 1 或 2（直接回车默认 1）"
    if ($choice -eq '2') {
        $hostValue = (Read-Host "  请输入公网域名或公网 IP 地址").Trim()
        if ([string]::IsNullOrWhiteSpace($hostValue)) {
            Write-Host "  [提示] 未输入地址，将使用 localhost（自签）"
            return 'localhost'
        }
        if ($hostValue -ieq 'localhost') {
            Write-Host "  [提示] localhost 请选 1 使用自签证书"
            return 'localhost'
        }
        # 内网 IP 无法通过 ACME 验证，回退自签
        $ip = $null
        if ([System.Net.IPAddress]::TryParse($hostValue, [ref]$ip) -and (Test-PrivateIpAddress $hostValue)) {
            Write-Host "  [提示] '$hostValue' 是内网地址，Let's Encrypt 无法验证，将使用自签证书。"
            Write-Host "         公网域名或公网 IP 才能申请可信证书。"
            return 'localhost'
        }
        Write-Host ""
        Write-Host "  [提示] 正在为 $hostValue 自动申请 Let's Encrypt 可信证书..."
        Write-Host "         公网 IP 证书有效期约 6 天，到期后请重新签发。"
        return $hostValue
    }
    return 'localhost'
}

# 判断是否为内网/保留 IP 地址
function Test-PrivateIpAddress([string]$HostValue) {
    $ip = $null
    if (-not [System.Net.IPAddress]::TryParse($HostValue, [ref]$ip)) { return $false }
    if ($ip.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork) {
        $b = $ip.GetAddressBytes()
        if ($b[0] -eq 10) { return $true }
        if ($b[0] -eq 127) { return $true }
        if ($b[0] -eq 192 -and $b[1] -eq 168) { return $true }
        if ($b[0] -eq 172 -and $b[1] -ge 16 -and $b[1] -le 31) { return $true }
        if ($b[0] -eq 169 -and $b[1] -eq 254) { return $true }
        if ($b[0] -eq 100 -and $b[1] -ge 64 -and $b[1] -le 127) { return $true }
        return $false
    }
    if ($ip.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetworkV6) {
        return [System.Net.IPAddress]::IsLoopback($ip) -or $ip.IsIPv6LinkLocal -or $ip.IsIPv6Multicast
    }
    return $false
}

# 执行签发：zviewer-backend.exe --gen-cert [host] [--force]
# 注意：不 return 退出码（exe 的 stdout 会混入函数返回值），调用方读取 $LASTEXITCODE
function Invoke-CertIssue([string]$CertHost, [switch]$IsForce) {
    if (-not (Test-Exe $backendExe "后端程序 zviewer-backend.exe")) { $script:CertExitCode = 1; return }
    $certArgs = @('--gen-cert')
    if ($CertHost) { $certArgs += $CertHost }
    if ($IsForce) { $certArgs += '--force' }
    Write-Host "  [证书] 签发类型: $CertHost"
    & $backendExe @certArgs
    $script:CertExitCode = $LASTEXITCODE
}

function Invoke-Cert {
    $certHost = if ($HostArg) { $HostArg } else { Select-CertHost }
    Invoke-CertIssue -CertHost $certHost -IsForce:$Force
    $code = $script:CertExitCode
    Write-Host ""
    if ($code -ne 0) {
        Write-Host "  [证书] 签发失败（退出码 $code）" -ForegroundColor Red
    } else {
        Write-Host "  [证书] 签发完成，证书位于 config/ssl/" -ForegroundColor Green
    }
    return $code
}

# ==================== 启动 ====================

# 以指定环境变量启动 exe（兼容 Windows PowerShell 5.1，启动后恢复原环境）
function Start-ExeWithEnv([string]$FilePath, [hashtable]$EnvVars, [string]$OutFile, [string]$ErrFile) {
    $saved = @{}
    foreach ($k in $EnvVars.Keys) {
        $saved[$k] = [Environment]::GetEnvironmentVariable($k, 'Process')
        [Environment]::SetEnvironmentVariable($k, [string]$EnvVars[$k], 'Process')
    }
    try {
        return Start-Process -FilePath $FilePath -WorkingDirectory $rootDir -WindowStyle Hidden  `
            -RedirectStandardOutput $OutFile -RedirectStandardError $ErrFile -PassThru
    } finally {
        foreach ($k in $saved.Keys) {
            [Environment]::SetEnvironmentVariable($k, $saved[$k], 'Process')
        }
    }
}

function Invoke-Start([switch]$BackendOnly) {
    Set-Ports

    Write-Host "========================================"
    Write-Host "  ZViewer 启动"
    Write-Host "  端口: $Port"
    if ($Https) {
      Write-Host "  模式: HTTPS（可信/自签证书）"
    } elseif ($BackendOnly) {
      Write-Host "  模式: 仅后端（不校验前端产物）"
    } else {
      Write-Host "  模式: HTTP（后端统一提供 API + 前端静态文件）"
    }
    Write-Host "========================================"

    if (-not (Test-Exe $backendExe "后端程序 zviewer-backend.exe")) { return 1 }

    if (Test-PortInUse $Port) {
        Write-Host "  [错误] 端口 $Port 已被占用" -ForegroundColor Red
        return 1
    }

    # 后端统一托管前端静态文件，需 frontend/dist 存在；BackendOnly 模式跳过此检查
    if (-not $BackendOnly) {
      $frontendArtifact = Join-Path $rootDir "frontend\dist\index.html"
      if (-not (Test-Path $frontendArtifact)) {
        Write-Host "  [错误] 前端构建产物缺失: $frontendArtifact" -ForegroundColor Red
        return 1
      }
    }

    # HTTPS 模式：先签发证书（后端启动时也会在证书缺失时自动补签，
    # 此处提前签发以支持 -HostArg / -Force 参数）
    if ($Https) {
        $certHost = if ($HostArg) { $HostArg } else { Select-CertHost }
        Invoke-CertIssue -CertHost $certHost -IsForce:$Force
        $code = $script:CertExitCode
        if ($code -ne 0) {
            Write-Host "  [证书] 签发失败，HTTPS 启动中止" -ForegroundColor Red
            return 1
        }
    }

    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    "" | Set-Content "$logDir/backend.log" -Encoding UTF8
    "" | Set-Content "$logDir/backend.err.log" -Encoding UTF8

    Write-Host "  启动后端..."
    $rtmpEnv = Read-PortValue -Key 'RTMP_PORT'
    $flvEnv = Read-PortValue -Key 'HTTP_FLV_PORT'
    $backendEnv = @{
        PORT = "$Port"
        HOST = "::"
        RTMP_PORT = if ($rtmpEnv) { "$rtmpEnv" } else { "3334" }
        HTTP_FLV_PORT = if ($flvEnv) { "$flvEnv" } else { "3335" }
    }
    if ($Https) { $backendEnv.HTTPS = "true" }
    $backend = Start-ExeWithEnv -FilePath $backendExe -EnvVars $backendEnv  `
        -OutFile "$logDir/backend.log" -ErrFile "$logDir/backend.err.log"

    # 等待后端就绪（数据库结构校验 + 各服务启动需要数秒）
    Write-Host "  等待后端就绪..."
    if (-not (Wait-PortReady $Port)) {
        Write-Host "  错误：后端在 30 秒内未就绪，请检查日志: $logDir\backend.err.log" -ForegroundColor Red
        Stop-Process -Id $backend.Id -Force -ErrorAction SilentlyContinue
        exit 1
    }

    Write-PidsFile -backendPid $backend.Id
    Write-Host "  后端 PID: $($backend.Id)"
    $protocol = if ($Https) { 'https' } else { 'http' }
    Write-Host "  访问  : ${protocol}://localhost:$Port"
    Write-Host "  日志  : $logDir/"
    return 0
}

# ==================== 停止 / 重启 / 状态 / 日志 ====================

function Invoke-Stop {
    $existing = Read-PidsFile
    if ($existing) {
        if ($existing.backend -and $existing.backend.pid) {
            Stop-Process -Id $existing.backend.pid -Force -ErrorAction SilentlyContinue
        }
        # 兼容旧版 pids 文件中可能记录的前端进程
        if ($existing.frontend -and $existing.frontend.pid) {
            Stop-Process -Id $existing.frontend.pid -Force -ErrorAction SilentlyContinue
        }
        Remove-Item $pidsFile -Force -ErrorAction SilentlyContinue
    }
    # 兜底：按统一端口清理
    Set-Ports
    Stop-ProcessByPort $Port
    Write-Host "  已停止"
}

function Invoke-Restart {
    Invoke-Stop
    Start-Sleep -Seconds 1
    Invoke-Start
}

function Invoke-Status {
    Write-Host "========================================"
    Write-Host "  ZViewer 运行状态"
    Write-Host "========================================"

    Set-Ports
    $existing = Read-PidsFile
    $backendRunning = $false
    if ($existing -and $existing.backend -and $existing.backend.pid) {
        $backendRunning = $null -ne (Get-Process -Id $existing.backend.pid -ErrorAction SilentlyContinue)
    }

    $backendListen = Test-PortInUse $Port

    Write-Host "  服务:"
    Write-Host "    配置端口: $Port"
    Write-Host "    端口监听: $(if ($backendListen) { '是' } else { '否' })"
    if ($existing -and $existing.backend -and $existing.backend.pid) {
        Write-Host "    记录 PID: $($existing.backend.pid) ($(if ($backendRunning) { '运行中' } else { '未运行' }))"
    }

    $frontendArtifact = Join-Path $rootDir "frontend\dist\index.html"
    Write-Host "  程序:"
    Write-Host "    后端: $(if (Test-Path $backendExe) { '存在' } else { '缺失' })"
    Write-Host "    前端: $(if (Test-Path $frontendArtifact) { '存在' } else { '缺失' })"
    Write-Host "    证书: $(if (Test-Path (Join-Path $rootDir 'config\ssl\cert.pem')) { '存在' } else { '缺失' })"
}

function Invoke-Logs {
    # 统一端口后仅保留后端日志（前端静态文件由后端托管，无独立日志）
    $logFile = "$logDir/backend.log"
    if (Test-Path $logFile) {
        Get-Content $logFile -Tail 50
    } else {
        Write-Host "  日志不存在: $logFile"
    }
}

# ==================== 帮助 / 菜单 ====================

function Show-Help {
    Write-Host "用法: .\start.bat {start|backend|stop|restart|status|logs|cert|https|help|menu} [选项]"
    Write-Host ""
    Write-Host "命令:"
    Write-Host "  start              启动服务（加 -Https 使用 HTTPS）"
    Write-Host "  backend            仅启动后端（加 -Https 使用 HTTPS）"
    Write-Host "  stop               停止服务"
    Write-Host "  restart            重启服务"
    Write-Host "  status             查看运行状态"
    Write-Host "  logs               查看后端日志"
    Write-Host "  cert [host]        一键签发 SSL 证书（localhost / 公网域名或公网 IP(Let's Encrypt)）"
    Write-Host "  https [host]       签发证书后以 HTTPS 启动"
    Write-Host "  help               显示此帮助"
    Write-Host "  menu               交互菜单（无参数时自动进入）"
    Write-Host ""
    Write-Host "start/restart/cert/https 选项:"
    Write-Host "  -Https                    start 时使用 HTTPS"
    Write-Host "  -Force                    证书强制重新签发"
    Write-Host ""
    Write-Host "端口: 默认取 .env 的 PORT（否则 3333），前后端共用同一端口"
    Write-Host ""
    Write-Host "示例:"
    Write-Host "  start.bat                  # 交互菜单"
    Write-Host "  start.bat start            # HTTP 启动"
    Write-Host "  start.bat backend          # 仅启动后端"
    Write-Host "  start.bat https example.com  # 申请 Let's Encrypt 证书后 HTTPS 启动"
    Write-Host "  start.bat cert example.com -Force  # 为公网域名强制重新签发 Let's Encrypt 证书"
}

function Show-Menu {
    while ($true) {
        Clear-Host
        Write-Host "========================================"
        Write-Host "  ZViewer 服务管理（单文件版）"
        Write-Host "========================================"
        Write-Host ""
        Write-Host "  1) 启动服务"
        Write-Host "  2) 仅启动后端"
        Write-Host "  3) 停止服务"
        Write-Host "  4) 重启服务"
        Write-Host "  5) 查看状态"
        Write-Host "  6) 查看日志"
        Write-Host "  7) 一键签发 SSL 证书"
        Write-Host "  8) HTTPS 启动（自动签发证书）"
        Write-Host "  0) 退出"
        Write-Host ""
        $choice = Read-Host "  请输入编号 (0-8)"
        switch ($choice) {
            '1' { $script:Https = $false; Invoke-Start; Wait-MenuKey }
            '2' {
                $boChoice = Read-Host "  请选择类型 (1=HTTP 2=HTTPS，直接回车默认 HTTP)"
                if ($boChoice -eq '2') { $script:Https = $true } else { $script:Https = $false }
                Invoke-Start -BackendOnly
                Wait-MenuKey
            }
            '3' { Invoke-Stop; Wait-MenuKey }
            '4' { Invoke-Restart; Wait-MenuKey }
            '5' { Invoke-Status; Wait-MenuKey }
            '6' { Invoke-Logs; Wait-MenuKey }
            '7' { Invoke-Cert; Wait-MenuKey }
            '8' { $script:Https = $true; Invoke-Start; Wait-MenuKey }
            '0' { return }
            default { Write-Host "  无效输入，请重新选择"; Start-Sleep -Milliseconds 800 }
        }
    }
}

function Wait-MenuKey {
    Write-Host ""
    Read-Host "  按回车返回菜单" | Out-Null
}

# ==================== 入口 ====================

switch ($Command) {
    'start'   { exit (Invoke-Start) }
    'backend' { exit (Invoke-Start -BackendOnly) }
    'stop'    { Invoke-Stop; exit 0 }
    'restart' { Invoke-Restart; exit 0 }
    'status'  { Invoke-Status; exit 0 }
    'logs'    { Invoke-Logs; exit 0 }
    'cert'    { exit (Invoke-Cert) }
    'https'   { $script:Https = $true; exit (Invoke-Start) }
    'menu'    { Show-Menu }
    default   { Show-Help }
}
