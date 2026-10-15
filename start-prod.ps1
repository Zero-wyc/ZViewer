#!/usr/bin/env pwsh
#Requires -Version 5.1

# ZViewer 一键启动脚本
# 命令：start | backend | stop | restart | status | logs | build | help

param(
    [Parameter(Position = 0)]
    [ValidateSet('start', 'backend', 'cert', 'https', 'stop', 'restart', 'status', 'logs', 'build', 'help', 'menu', '')]
    [string]$Command = 'menu',

    [Parameter(Position = 1)]
    [ValidateSet('backend', 'frontend', '')]
    [string]$Target = '',

    [int]$Port = 0,          # 端口覆盖（0 = 使用 .env / 默认 3333）
    [switch]$Build,          # 启动前构建
    [switch]$Https           # 使用自签 HTTPS
)

$ErrorActionPreference = "Stop"

# Force UTF-8 console output so Chinese text renders correctly
# regardless of the system's default OEM codepage (GBK on zh-CN).
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$rootDir = $PSScriptRoot
if (-not $rootDir) { $rootDir = (Get-Location).Path }
$backendDir = Join-Path $rootDir "backend"
$frontendDir = Join-Path $rootDir "frontend"
$logDir = Join-Path $rootDir "log"
$pidsFile = Join-Path $rootDir ".prod.pids.json"
$envFile = Join-Path $rootDir ".env"

# ==================== 工具函数 ====================

function Read-EnvValue {
    param([string]$Key)
    if (-not (Test-Path $envFile)) { return $null }
    $line = Get-Content $envFile | Where-Object { $_ -match "^\s*$([regex]::Escape($Key))\s*=" } | Select-Object -First 1
    if (-not $line) { return $null }
    $val = ($line -split '=', 2)[1].Trim().Trim('"').Trim()
    if ($val -eq '') { return $null }
    return $val
}

function Read-PidsFile {
    if (-not (Test-Path $pidsFile)) { return $null }
    try { return Get-Content $pidsFile -Raw | ConvertFrom-Json } catch { return $null }
}

function Write-PidsFile($backendPid, $frontendPid) {
    @{
        backend = @{ pid = $backendPid }
        frontend = @{ pid = $frontendPid }
    } | ConvertTo-Json -Depth 3 | Set-Content -Path $pidsFile -Encoding UTF8
}

function Test-PortInUse($localPort) {
    $conn = Get-NetTCPConnection -LocalPort $localPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    return $null -ne $conn
}

# 等待端口开始监听（后端初始化需要数秒，避免前端先就绪后页面请求被拒）
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

function Test-DepsInstalled {
    return (Test-Path (Join-Path $rootDir "node_modules")) -and
           (Test-Path (Join-Path $rootDir "node_modules\express")) -and
           (Test-Path (Join-Path $rootDir "node_modules\sql.js")) -and
           (Test-Path (Join-Path $rootDir "node_modules\typeorm"))
}

function Install-Deps {
    if (Test-DepsInstalled) {
        Write-Host "  依赖已安装"
        return
    }
    Write-Host "  安装依赖..."
    Push-Location $rootDir
    try {
        npm ci --no-audit --no-fund --prefer-offline --include=dev
        if ($LASTEXITCODE -ne 0) {
            npm install --no-audit --no-fund --include=dev
        }
    } finally {
        Pop-Location
    }
}

function Build-Projects {
    Write-Host "  构建后端..."
    Push-Location $backendDir
    try {
        npm run build
        if ($LASTEXITCODE -ne 0) { throw "后端构建失败" }
    } finally { Pop-Location }

    Write-Host "  构建前端..."
    Push-Location $frontendDir
    try {
        npm run build
        if ($LASTEXITCODE -ne 0) { throw "前端构建失败" }
    } finally { Pop-Location }

    Write-Host "  构建完成"
}

# ==================== 命令 ====================

function Set-Ports {
    # 端口优先级：命令行参数 > 环境变量 > .env > 默认值
    # 统一端口：前后端共用同一端口（默认 3333），由后端托管前端静态文件
    $envPort = Read-EnvValue -Key 'PORT'
    $script:Port = if ($Port -gt 0) { $Port }
        elseif ($env:PORT -match '^\d+$') { [int]$env:PORT }
        elseif ($envPort -match '^\d+$') { [int]$envPort }
        else { 3333 }
}

function Invoke-Start {
    param([switch]$BackendOnly)
    Set-Ports

    Write-Host "========================================"
    Write-Host "  ZViewer 启动"
    Write-Host "  端口: $Port"
    if ($Https) {
      Write-Host "  模式: HTTPS（自签/可信证书）"
    } elseif ($BackendOnly) {
      Write-Host "  模式: 仅后端（不校验前端产物）"
    } else {
      Write-Host "  模式: HTTP（后端统一提供 API + 前端静态文件）"
    }
    Write-Host "========================================"

    if (Test-PortInUse $Port) {
        Write-Host "  错误：端口 $Port 已被占用" -ForegroundColor Red
        exit 1
    }

    Install-Deps

    if ($Build) {
        Build-Projects
    } else {
        Write-Host "  跳过构建（如需构建请加 -Build）"
    }

    $backendArtifact = Join-Path $backendDir "dist/index.js"
    if (-not (Test-Path $backendArtifact)) {
        throw "后端构建产物缺失: $backendArtifact，请先执行 build 或加 -Build 启动"
    }
    # 后端统一托管前端静态文件，需 frontend/dist 存在；BackendOnly 模式跳过此检查
    if (-not $BackendOnly) {
      $frontendArtifact = Join-Path $frontendDir "dist/index.html"
      if (-not (Test-Path $frontendArtifact)) {
        throw "前端构建产物缺失: $frontendArtifact，请先执行 build 或加 -Build 启动"
      }
    }

    # HTTPS 模式：生成自签证书
    if ($Https) {
      Write-Host "  生成自签 SSL 证书..."
      $certScript = Join-Path $rootDir "scripts\generate-cert.js"
      if (-not (Test-Path $certScript)) {
        throw "证书生成脚本缺失: $certScript"
      }
      & node $certScript
      if ($LASTEXITCODE -ne 0) {
        throw "SSL 证书生成失败"
      }
    }

    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    "" | Set-Content "$logDir/backend.log" -Encoding UTF8
    "" | Set-Content "$logDir/backend.err.log" -Encoding UTF8

    $env:PORT = "$Port"
    $env:NODE_ENV = "production"
    $env:HOST = "::"

    if ($Https) {
      $env:HTTPS = "true"
      # 证书路径使用默认值，由 generate-cert.js 生成
      $sslDir = Join-Path $rootDir "config\ssl"
      $env:SSL_CERT_PATH = Join-Path $sslDir "cert.pem"
      $env:SSL_KEY_PATH = Join-Path $sslDir "key.pem"
    }

    Write-Host "  启动后端..."
    $backend = Start-Process -FilePath "node" -ArgumentList "dist/index.js" `
        -WorkingDirectory $backendDir -WindowStyle Hidden `
        -RedirectStandardOutput "$logDir/backend.log" `
        -RedirectStandardError "$logDir/backend.err.log" -PassThru

    # 等待后端就绪（TypeORM 初始化 + NMS 启动需要数秒）
    Write-Host "  等待后端就绪..."
    if (-not (Wait-PortReady $Port)) {
        Write-Host "  错误：后端在 30 秒内未就绪，请检查日志: $logDir\backend.err.log" -ForegroundColor Red
        Stop-Process -Id $backend.Id -Force -ErrorAction SilentlyContinue
        exit 1
    }

    Write-PidsFile -backendPid $backend.Id -frontendPid $null
    Write-Host "  后端 PID: $($backend.Id)"
    $protocol = if ($Https) { 'https' } else { 'http' }
    Write-Host "  访问  : ${protocol}://localhost:$Port"
    Write-Host "  日志  : $logDir/"
}

function Invoke-Build {
    Install-Deps
    Build-Projects
}

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
    # 兜底：按端口清理
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
        $proc = Get-Process -Id $existing.backend.pid -ErrorAction SilentlyContinue
        $backendRunning = $null -ne $proc
    }

    $backendListen = Test-PortInUse $Port

    Write-Host "  服务:"
    Write-Host "    配置端口: $Port"
    Write-Host "    端口监听: $(if ($backendListen) { '是' } else { '否' })"
    if ($existing -and $existing.backend -and $existing.backend.pid) {
        $backendState = if ($backendRunning) { '运行中' } else { '未运行' }
        Write-Host "    记录 PID: $($existing.backend.pid) ($backendState)"
    }

    $backendArtifact = Join-Path $backendDir "dist/index.js"
    $frontendArtifact = Join-Path $frontendDir "dist/index.html"
    Write-Host "  构建产物:"
    Write-Host "    后端: $(if (Test-Path $backendArtifact) { '存在' } else { '缺失' })"
    Write-Host "    前端: $(if (Test-Path $frontendArtifact) { '存在' } else { '缺失' })"
}

function Invoke-Logs {
    param([string]$LogTarget)
    if (-not $LogTarget) { $LogTarget = 'backend' }
    $logFile = if ($LogTarget -eq 'frontend') { "$logDir/frontend.log" } else { "$logDir/backend.log" }
    if (Test-Path $logFile) {
        Get-Content $logFile -Tail 50
    } else {
        Write-Host "  日志不存在"
    }
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
    Write-Host ""
    Write-Host "  [建议] 正式部署对外服务时，更推荐使用 1Panel、宝塔等面板，" -ForegroundColor Yellow
    Write-Host "         或 Cloudflare、腾讯云 EdgeOne、阿里云 ESA 等更专业的" -ForegroundColor Yellow
    Write-Host "         证书/边缘服务来签发和管理证书，自动续期、运维更省心。" -ForegroundColor Yellow
    Write-Host "         仅本机或内网想用 HTTPS 的话，选 1 签个本地自签证书即可；" -ForegroundColor Yellow
    Write-Host "         一般不建议使用本脚本内置的 ACME 自动签发功能。" -ForegroundColor Yellow
    Write-Host ""
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

# 一键签发证书：交互选择类型后调用 scripts/generate-cert.js
function Invoke-Cert {
    $certScript = Join-Path $rootDir "scripts\generate-cert.js"
    if (-not (Test-Path $certScript)) {
        Write-Host "  [错误] 证书生成脚本缺失: $certScript" -ForegroundColor Red
        return 1
    }
    $certHost = Select-CertHost
    Write-Host "  [证书] 签发类型: $certHost"
    & node $certScript $certHost
    $code = $LASTEXITCODE
    Write-Host ""
    if ($code -ne 0) {
        Write-Host "  [证书] 签发失败（退出码 $code）" -ForegroundColor Red
    } else {
        Write-Host "  [证书] 签发完成，证书位于 config/ssl/" -ForegroundColor Green
    }
    return $code
}

# HTTPS 启动：交互选择证书类型 → 签发 → 以 HTTPS 启动
function Invoke-HttpsStart {
    $certScript = Join-Path $rootDir "scripts\generate-cert.js"
    if (-not (Test-Path $certScript)) {
        Write-Host "  [错误] 证书生成脚本缺失: $certScript" -ForegroundColor Red
        return 1
    }
    $certHost = Select-CertHost
    Write-Host "  [证书] 签发类型: $certHost"
    & node $certScript $certHost
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  [证书] 签发失败，HTTPS 启动中止" -ForegroundColor Red
        return 1
    }
    $script:Https = $true
    Invoke-Start
    return 0
}

function Show-Help {
    Write-Host "用法: .\start-prod.ps1 {start|backend|cert|https|stop|restart|status|logs|build|help} [选项]"
    Write-Host ""
    Write-Host "命令:"
    Write-Host "  start              安装依赖后直接启动（默认不构建）"
    Write-Host "  backend            仅启动后端，不校验前端构建产物（加 -Https 使用 HTTPS）"
    Write-Host "  cert               一键签发 SSL 证书（localhost / 公网域名或公网 IP(Let's Encrypt)）"
    Write-Host "  https              签发证书后以 HTTPS 启动"
    Write-Host "  build              单独构建前后端"
    Write-Host "  stop               停止服务"
    Write-Host "  restart            重启服务"
    Write-Host "  status             查看运行状态"
    Write-Host "  logs               查看后端日志"
    Write-Host "  help               显示此帮助"
    Write-Host ""
    Write-Host "start/restart/backend 选项:"
    Write-Host "  -Build                    启动前执行构建"
    Write-Host "  -Https                    使用 HTTPS"
    Write-Host ""
    Write-Host "端口: 默认取 .env 的 PORT（否则 3333），前后端共用同一端口"
}

# ==================== 交互菜单 ====================

function Show-Menu {
    while ($true) {
        Clear-Host
        Write-Host "========================================"
        Write-Host "  ZViewer 生产服务管理"
        Write-Host "========================================"
        Write-Host ""
        Write-Host "  1) 启动服务"
        Write-Host "  2) 仅启动后端"
        Write-Host "  3) 停止服务"
        Write-Host "  4) 重启服务"
        Write-Host "  5) 查看状态"
        Write-Host "  6) 查看日志"
        Write-Host "  7) 构建前后端"
        Write-Host "  8) 一键签发 SSL 证书"
        Write-Host "  9) HTTPS 启动（自动签发证书）"
        Write-Host "  0) 退出"
        Write-Host ""
        $choice = Read-Host "请输入编号 (0-9)"
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
            '6' { Invoke-Logs -LogTarget $Target; Wait-MenuKey }
            '7' { Invoke-Build; Wait-MenuKey }
            '8' { Invoke-Cert; Wait-MenuKey }
            '9' { Invoke-HttpsStart; Wait-MenuKey }
            '0' { return }
            default { Write-Host "  无效输入，请重新选择"; Start-Sleep -Milliseconds 800 }
        }
    }
}

function Wait-MenuKey {
    Write-Host ""
    Read-Host "按回车返回菜单" | Out-Null
}

# ==================== 入口 ====================

switch ($Command) {
    'start'   { Invoke-Start }
    'backend' { Invoke-Start -BackendOnly }
    'cert'    { $null = Invoke-Cert; exit 0 }
    'https'   { $null = Invoke-HttpsStart; exit 0 }
    'build'   { Invoke-Build }
    'stop'    { Invoke-Stop }
    'restart' { Invoke-Restart }
    'status'  { Invoke-Status }
    'logs'    { Invoke-Logs -LogTarget $Target }
    'menu'    { Show-Menu }
    default   { Show-Help }
}
