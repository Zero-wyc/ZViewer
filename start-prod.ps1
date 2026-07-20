#!/usr/bin/env pwsh
#Requires -Version 5.1

<#
.SYNOPSIS
  ZViewer 生产服务统一管理脚本
.DESCRIPTION
  支持子命令：start | stop | restart | status | logs | help
  适配 npm workspaces（根目录统一安装依赖）。
.EXAMPLE
  .\start-prod.ps1 start
  .\start-prod.ps1 start -SkipBuild -Port 3001
  .\start-prod.ps1 stop
  .\start-prod.ps1 restart
  .\start-prod.ps1 status
  .\start-prod.ps1 logs backend
#>

param(
    [Parameter(Position = 0)]
    [ValidateSet('start', 'stop', 'restart', 'status', 'logs', 'port', 'menu', 'help', '')]
    [string]$Command = 'help',

    [Parameter(Position = 1)]
    [ValidateSet('backend', 'frontend', '')]
    [string]$Target = '',

    [switch]$SkipBuild,
    [switch]$ForceDeps,            # 强制重新安装依赖（默认跳过已安装）
    [switch]$AutoBuild,            # 智能构建：产物新于源代码时自动跳过（默认行为）
    [switch]$NoAutoBuild,          # 禁用智能构建跳过，强制构建
    [int]$Port = 3000,
    [int]$FrontendPort = 4173,
    [string]$Database
)

$ErrorActionPreference = "Stop"

$rootDir = $PSScriptRoot
if (-not $rootDir) { $rootDir = (Get-Location).Path }
$backendDir = Join-Path $rootDir "backend"
$frontendDir = Join-Path $rootDir "frontend"
$pidsFile = Join-Path $rootDir ".prod.pids.json"
$portsFile = Join-Path $rootDir ".prod.ports.json"
$backendLog = Join-Path $rootDir "backend-prod.log"
$backendErrLog = Join-Path $rootDir "backend-prod.err.log"
$frontendLog = Join-Path $rootDir "frontend-prod.log"
$frontendErrLog = Join-Path $rootDir "frontend-prod.err.log"

# ============ 辅助函数 ============

function Write-Title {
    param([string]$Text)
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host "  $Text" -ForegroundColor Cyan
    Write-Host "========================================" -ForegroundColor Cyan
}

function Test-CommandInstalled {
    param([string]$Name)
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $cmd) {
        throw "$Name 未安装或不在 PATH 中"
    }
    return $cmd
}

function Test-DepsInstalled {
    # npm workspaces：根目录 node_modules 存在 + 关键依赖存在即视为已安装
    # 注意：dist 是构建产物，不应作为依赖判断条件
    $rootNodeModules = Join-Path $script:rootDir "node_modules"
    $expressPath = Join-Path $script:rootDir "node_modules\express"
    $vitePath = Join-Path $script:rootDir "node_modules\vite"
    $hasRoot = Test-Path $rootNodeModules
    $hasExpress = Test-Path $expressPath
    $hasVite = Test-Path $vitePath
    return [bool]($hasRoot -and $hasExpress -and $hasVite)
}

function Resolve-ViteJs {
    # vite 在 workspaces 模式下可能 hoist 到根目录，也可能在 frontend/node_modules
    $candidates = @(
        (Join-Path $script:rootDir "node_modules\vite\bin\vite.js"),
        (Join-Path $script:frontendDir "node_modules\vite\bin\vite.js")
    )
    foreach ($p in $candidates) {
        if (Test-Path $p) { return $p }
    }
    return $null
}

function Install-ProjectDependencies {
    # npm workspaces：仅在根目录安装一次，子目录会自动 hoist
    Write-Host "  [$rootDir] 检测到 package-lock.json，执行 npm ci ..."
    Push-Location $rootDir
    try {
        # 用 --no-audit --no-fund 提速；--prefer-offline 减少网络
        npm ci --no-audit --no-fund --prefer-offline
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  npm ci 失败，回退到 npm install ..." -ForegroundColor Yellow
            npm install --no-audit --no-fund
            if ($LASTEXITCODE -ne 0) {
                throw "依赖安装失败"
            }
        }
    } finally {
        Pop-Location
    }
}

function Read-PidsFile {
    if (-not (Test-Path $pidsFile)) { return $null }
    try {
        return Get-Content $pidsFile -Raw | ConvertFrom-Json
    } catch {
        return $null
    }
}

# ============ 端口配置 ============

function Read-PortsFile {
    # 读取持久化的端口配置，返回 @{ backend=<int>; frontend=<int> } 或 $null
    if (-not (Test-Path $portsFile)) { return $null }
    try {
        $obj = Get-Content $portsFile -Raw | ConvertFrom-Json
        $backend = if ($null -ne $obj.backend) { [int]$obj.backend } else { $null }
        $frontend = if ($null -ne $obj.frontend) { [int]$obj.frontend } else { $null }
        if ($backend -gt 0 -and $frontend -gt 0) {
            return @{ backend = $backend; frontend = $frontend }
        }
    } catch {}
    return $null
}

function Write-PortsFile {
    param([int]$BackendPort, [int]$FrontendPort)
    $ports = @{
        backend  = $BackendPort
        frontend = $FrontendPort
        updatedAt = (Get-Date).ToString('o')
    }
    $ports | ConvertTo-Json -Depth 2 | Set-Content -Path $portsFile -Encoding UTF8
}

function Test-PortValid {
    # 校验端口：1-65535 整数；可选检查是否已被占用
    param([int]$Port, [switch]$CheckInUse)
    if ($Port -lt 1 -or $Port -gt 65535) {
        Write-Host "  端口 $Port 不合法（需 1-65535）" -ForegroundColor Red
        return $false
    }
    if ($CheckInUse) {
        $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($conn) {
            Write-Host "  端口 $Port 已被占用（PID $($conn.OwningProcess)）" -ForegroundColor Red
            return $false
        }
    }
    return $true
}

function Read-PortInput {
    # 交互式读取端口输入，带默认值与校验
    param([string]$Prompt, [int]$DefaultValue, [switch]$CheckInUse)
    while ($true) {
        $input = Read-Host "$Prompt (默认 $DefaultValue，留空使用默认)"
        if ([string]::IsNullOrWhiteSpace($input)) {
            return $DefaultValue
        }
        if ($input -notmatch '^\d+$') {
            Write-Host "  请输入正整数" -ForegroundColor Red
            continue
        }
        $port = [int]$input
        if (-not (Test-PortValid -Port $port -CheckInUse:$CheckInUse)) {
            continue
        }
        return $port
    }
}

function Write-PidsFile {
    param(
        [int]$BackendPid,
        [int]$FrontendPid,
        [int]$BackendPort,
        [int]$FrontendPortNum
    )
    $pids = @{
        backend  = @{ pid = $BackendPid; port = $BackendPort; url = "http://localhost:$BackendPort" }
        frontend = @{ pid = $FrontendPid; port = $FrontendPortNum; url = "http://localhost:$FrontendPortNum" }
    }
    $pids | ConvertTo-Json -Depth 3 | Set-Content -Path $pidsFile -Encoding UTF8
}

function Test-PortInUse {
    # 仅检查 Listen 状态，避免 TIME_WAIT / CloseWait 等残留连接造成误判
    param([int]$LocalPort)
    $conn = Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    return $null -ne $conn
}

function Get-ProcessByIdSafe {
    param([int]$ProcessId)
    try {
        return Get-Process -Id $ProcessId -ErrorAction Stop
    } catch {
        return $null
    }
}

function Stop-ProcessGraceful {
    # 终止进程及其所有子进程。
    # node / vite 后台进程 detached 于控制台，taskkill 不带 /F 发送的信号对它们无效；
    # Stop-Process -Force 又只杀单个 PID 不杀子进程，会导致 vite fork 的监听子进程残留。
    # 因此统一使用 taskkill /T /F 一次性强制终止整个进程树。
    param([int]$ProcessId, [int]$TimeoutSec = 5)
    $proc = Get-ProcessByIdSafe -ProcessId $ProcessId
    if (-not $proc) {
        Write-Host "  进程 PID $ProcessId 不存在或已结束"
        return $false
    }
    $name = $proc.ProcessName

    # 1. 优雅尝试：taskkill /T（不带 /F），给进程一个清理机会
    try {
        & taskkill /PID $ProcessId /T 2>&1 | Out-Null
    } catch {}
    $deadline = (Get-Date).AddSeconds(2)
    while ((Get-Date) -lt $deadline) {
        if (-not (Get-ProcessByIdSafe -ProcessId $ProcessId)) {
            Write-Host "  已结束进程 PID $ProcessId ($name)"
            return $true
        }
        Start-Sleep -Milliseconds 200
    }

    # 2. 强制终止整个进程树（/T = 含子进程，/F = 强制）
    try {
        & taskkill /PID $ProcessId /T /F 2>&1 | Out-Null
    } catch {}
    # 等待进程真正消失
    $deadline2 = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline2) {
        if (-not (Get-ProcessByIdSafe -ProcessId $ProcessId)) {
            Write-Host "  已强制结束进程 PID $ProcessId ($name)" -ForegroundColor Yellow
            return $true
        }
        Start-Sleep -Milliseconds 200
    }

    # 3. 最后兜底：Stop-Process -Force
    try {
        Stop-Process -Id $ProcessId -Force -ErrorAction Stop
        Write-Host "  已强制结束进程 PID $ProcessId ($name)" -ForegroundColor Yellow
        return $true
    } catch {
        Write-Host "  无法结束进程 PID $ProcessId：$_" -ForegroundColor Red
        return $false
    }
}

function Test-BackendBuilt {
    return Test-Path (Join-Path $backendDir "dist/index.js")
}

function Test-BuildUpToDate {
    # 智能构建跳过：检测构建产物是否新于所有源代码文件
    # 返回 $true = 可跳过构建，$false = 需要重新构建
    param(
        [string]$ProjectDir,   # backend / frontend 目录
        [string]$Artifact      # 构建产物路径（如 dist/index.js / dist/index.html）
    )

    # 产物不存在，必须构建
    if (-not (Test-Path $Artifact)) { return $false }

    $artifactItem = Get-Item $Artifact -ErrorAction SilentlyContinue
    if (-not $artifactItem) { return $false }
    $artifactTime = $artifactItem.LastWriteTime

    # 检查 src 目录下所有源代码文件，任一新于产物则需重新构建
    $srcDir = Join-Path $ProjectDir "src"
    if (Test-Path $srcDir -PathType Container) {
        $newerFiles = Get-ChildItem -Path $srcDir -Recurse -File -ErrorAction SilentlyContinue |
            Where-Object { $_.LastWriteTime -gt $artifactTime } |
            Select-Object -First 1
        if ($newerFiles) { return $false }
    }

    # 检查关键配置文件
    $configFiles = @('package.json', 'tsconfig.json', 'vite.config.ts', 'vite.config.js')
    foreach ($cfg in $configFiles) {
        $cfgPath = Join-Path $ProjectDir $cfg
        if (Test-Path $cfgPath) {
            $cfgItem = Get-Item $cfgPath -ErrorAction SilentlyContinue
            if ($cfgItem -and $cfgItem.LastWriteTime -gt $artifactTime) {
                return $false
            }
        }
    }

    return $true
}

function Get-PidByPort {
    # 通过端口查找真正监听的进程 PID
    # Start-Process -WindowStyle Hidden 在 Windows 上返回的 PID 可能是 stub 进程
    param([int]$LocalPort, [int]$TimeoutMs = 4000)
    $deadline = (Get-Date).AddMilliseconds($TimeoutMs)
    while ((Get-Date) -lt $deadline) {
        $conn = Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($conn -and $conn.OwningProcess -and $conn.OwningProcess -gt 0) {
            return [int]$conn.OwningProcess
        }
        Start-Sleep -Milliseconds 200
    }
    return $null
}

function Stop-ServiceByPidOrPort {
    # 优先用 PID 停止；PID 失效或停止后端口仍被占用则按端口查找。
    # vite preview / node 会 fork 子进程实际监听端口，杀父 PID 后子进程可能仍占用端口，
    # 因此必须以端口释放为最终判据，而不是仅看 PID 是否消失。
    param([int]$ProcessId, [int]$LocalPort)
    $proc = Get-ProcessByIdSafe -ProcessId $ProcessId
    if ($proc) {
        Stop-ProcessGraceful -ProcessId $ProcessId | Out-Null
    } else {
        Write-Host "  PID $ProcessId 不存在" -ForegroundColor Yellow
    }

    # 验证端口是否真的释放。vite/node 的子进程可能仍在监听。
    if ($LocalPort -gt 0) {
        # 短暂等待端口释放
        $waitDeadline = (Get-Date).AddSeconds(1)
        while ((Get-Date) -lt $waitDeadline) {
            if (-not (Test-PortInUse -LocalPort $LocalPort)) { break }
            Start-Sleep -Milliseconds 200
        }

        if (Test-PortInUse -LocalPort $LocalPort) {
            # 端口仍被占用，按端口查找真实监听进程并强杀整个进程树
            $realPid = Get-PidByPort -LocalPort $LocalPort -TimeoutMs 500
            if ($realPid) {
                if ($realPid -ne $ProcessId) {
                    Write-Host "  端口 $LocalPort 仍被 PID $realPid 占用（PID $ProcessId 的子进程），按端口清理..." -ForegroundColor Yellow
                } else {
                    Write-Host "  PID $ProcessId 仍占用端口 $LocalPort，再次强制清理..." -ForegroundColor Yellow
                }
                Stop-ProcessGraceful -ProcessId $realPid | Out-Null

                # 最终验证
                if (Test-PortInUse -LocalPort $LocalPort) {
                    $stillPid = Get-PidByPort -LocalPort $LocalPort -TimeoutMs 500
                    if ($stillPid) {
                        Write-Host "  端口 $LocalPort 仍被 PID $stillPid 占用，请手动结束" -ForegroundColor Red
                    }
                }
            }
        }
    }
}

# ============ 命令实现 ============

function Invoke-Start {
    Write-Title "ZViewer 生产服务启动"

    # 端口已在主入口统一解析（命令行参数 > 配置文件 > 默认值）
    Write-Host "  后端端口：$Port"
    Write-Host "  前端端口：$FrontendPort"

    # 检查是否已在运行
    $existing = Read-PidsFile
    if ($existing) {
        $backendProc = Get-ProcessByIdSafe -ProcessId $existing.backend.pid
        $frontendProc = Get-ProcessByIdSafe -ProcessId $existing.frontend.pid
        if ($backendProc -or $frontendProc) {
            Write-Host "服务已在运行中，如需重启请使用 restart 子命令" -ForegroundColor Yellow
            if ($backendProc) { Write-Host "  后端 PID: $($backendProc.Id)" }
            if ($frontendProc) { Write-Host "  前端 PID: $($frontendProc.Id)" }
            return
        } else {
            Remove-Item $pidsFile -Force -ErrorAction SilentlyContinue
        }
    }

    # 1. 检查环境
    Write-Host "[1/5] 检查环境 ..."
    $nodeCmd = Test-CommandInstalled "node"
    $npmCmd = Test-CommandInstalled "npm"
    Write-Host "  Node.js: $( & $nodeCmd.Source --version )"
    Write-Host "  npm: $( & $npmCmd.Source --version )"

    # 2. 安装依赖（npm workspaces：只在根目录装一次）
    $depsInstalled = Test-DepsInstalled
    if ($depsInstalled -and -not $ForceDeps) {
        Write-Host "[2/5] 依赖已安装，跳过（如需重装加 -ForceDeps）" -ForegroundColor Green
    } else {
        Write-Host "[2/5] 安装依赖 ..."
        Install-ProjectDependencies
    }

    # 3. 构建（智能跳过：产物新于源代码时自动跳过；-NoAutoBuild 强制构建；-SkipBuild 完全跳过）
    $backendArtifact = Join-Path $backendDir "dist/index.js"
    $frontendArtifact = Join-Path $frontendDir "dist/index.html"
    if ($SkipBuild) {
        Write-Host "[3/5] 跳过构建（-SkipBuild）" -ForegroundColor Yellow
    } elseif (-not $NoAutoBuild) {
        # 智能跳过：产物新于所有源代码时跳过
        $backendUpToDate = Test-BuildUpToDate -ProjectDir $backendDir -Artifact $backendArtifact
        $frontendUpToDate = Test-BuildUpToDate -ProjectDir $frontendDir -Artifact $frontendArtifact
        if ($backendUpToDate -and $frontendUpToDate) {
            Write-Host "[3/5] 构建产物已是最新（源代码未修改），跳过构建" -ForegroundColor Green
        } else {
            if (-not $backendUpToDate) {
                Write-Host "[3/5] 构建后端 ..."
                Push-Location $backendDir
                try {
                    npm run build
                    if ($LASTEXITCODE -ne 0) { throw "后端构建失败" }
                } finally { Pop-Location }
            } else {
                Write-Host "[3/5] 后端产物已最新，跳过"
            }
            if (-not $frontendUpToDate) {
                Write-Host "[3/5] 构建前端 ..."
                Push-Location $frontendDir
                try {
                    npm run build
                    if ($LASTEXITCODE -ne 0) { throw "前端构建失败" }
                } finally { Pop-Location }
            } else {
                Write-Host "[3/5] 前端产物已最新，跳过"
            }
        }
    } else {
        Write-Host "[3/5] 构建后端 ..."
        Push-Location $backendDir
        try {
            npm run build
            if ($LASTEXITCODE -ne 0) { throw "后端构建失败" }
        } finally { Pop-Location }

        Write-Host "[3/5] 构建前端 ..."
        Push-Location $frontendDir
        try {
            npm run build
            if ($LASTEXITCODE -ne 0) { throw "前端构建失败" }
        } finally { Pop-Location }
    }

    # 4. 确认产物
    Write-Host "[4/5] 检查构建产物 ..."
    if (-not (Test-BackendBuilt)) {
        throw "未找到 backend/dist/index.js，请先构建（去掉 -SkipBuild）"
    }
    Write-Host "  产物存在: backend/dist/index.js"

    # 5. 启动服务
    Write-Host "[5/5] 启动服务 ..."
    $env:PORT = "$Port"
    $env:NODE_ENV = "production"
    if ($Database) { $env:DATABASE_URL = $Database }

    # 清空旧日志
    foreach ($log in @($backendLog, $backendErrLog, $frontendLog, $frontendErrLog)) {
        if (Test-Path $log) { Remove-Item $log -Force -ErrorAction SilentlyContinue }
    }

    Write-Host "  启动后端 (PORT=$Port) ..."
    # stdout 与 stderr 分别写入不同文件，避免文件占用冲突
    $backendProcStub = Start-Process -FilePath "node" -ArgumentList "dist/index.js" `
        -WorkingDirectory $backendDir -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput $backendLog -RedirectStandardError $backendErrLog
    $stubPid = $backendProcStub.Id
    Write-Host "  后端 stub PID: $stubPid (等待端口监听...)"

    # Start-Process -WindowStyle Hidden 返回的 PID 可能是 stub，通过端口查找真实 PID
    $realBackendPid = Get-PidByPort -LocalPort $Port -TimeoutMs 6000
    if (-not $realBackendPid) {
        Write-Host "  后端启动失败（端口 $Port 未监听），查看日志 $backendErrLog" -ForegroundColor Red
        if (Test-Path $backendErrLog) {
            Write-Host "  --- 错误日志（最后 20 行）---"
            Get-Content $backendErrLog -Tail 20 -ErrorAction SilentlyContinue
        }
        # 清理可能残留的 stub 进程
        Stop-ProcessGraceful -ProcessId $stubPid | Out-Null
        throw "后端启动失败"
    }
    # stub 可能已退出（被真实进程替代），或仍存在（同 PID）
    if ($realBackendPid -ne $stubPid) {
        Write-Host "  真实后端 PID: $realBackendPid" -ForegroundColor Green
        # stub 可能还活着，清理掉
        Stop-ProcessGraceful -ProcessId $stubPid -TimeoutSec 1 | Out-Null
    } else {
        Write-Host "  后端 PID: $realBackendPid"
    }
    $backendPid = $realBackendPid

    Write-Host "  启动前端 (PORT=$FrontendPort) ..."
    # 直接调用 node + vite.js，避免 npm.cmd 在 Start-Process 中的兼容性问题
    # vite 在 workspaces 模式下可能 hoist 到根目录，也可能在 frontend/node_modules
    $viteJs = Resolve-ViteJs
    if (-not $viteJs) {
        Write-Host "  未找到 vite.js，前端启动失败" -ForegroundColor Red
        Write-Host "  回滚：停止已启动的后端 PID $backendPid ..." -ForegroundColor Yellow
        Stop-ProcessGraceful -ProcessId $backendPid | Out-Null
        throw "未找到 vite.js，请确认 frontend 依赖已安装"
    }
    Write-Host "  vite.js: $viteJs"
    $frontendProcStub = Start-Process -FilePath "node" -ArgumentList "`"$viteJs`"", "preview", "--port", "$FrontendPort", "--host" `
        -WorkingDirectory $frontendDir -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput $frontendLog -RedirectStandardError $frontendErrLog
    $frontendStubPid = $frontendProcStub.Id
    Write-Host "  前端 stub PID: $frontendStubPid (等待端口监听...)"

    $realFrontendPid = Get-PidByPort -LocalPort $FrontendPort -TimeoutMs 8000
    if (-not $realFrontendPid) {
        Write-Host "  前端启动失败（端口 $FrontendPort 未监听），查看日志 $frontendErrLog" -ForegroundColor Red
        if (Test-Path $frontendErrLog) {
            Write-Host "  --- 错误日志（最后 20 行）---"
            Get-Content $frontendErrLog -Tail 20 -ErrorAction SilentlyContinue
        }
        Stop-ProcessGraceful -ProcessId $frontendStubPid | Out-Null
        Write-Host "  回滚：停止已启动的后端 PID $backendPid ..." -ForegroundColor Yellow
        Stop-ProcessGraceful -ProcessId $backendPid | Out-Null
        throw "前端启动失败"
    }
    if ($realFrontendPid -ne $frontendStubPid) {
        Write-Host "  真实前端 PID: $realFrontendPid" -ForegroundColor Green
        Stop-ProcessGraceful -ProcessId $frontendStubPid -TimeoutSec 1 | Out-Null
    } else {
        Write-Host "  前端 PID: $realFrontendPid"
    }
    $frontendPid = $realFrontendPid

    Write-PidsFile -BackendPid $backendPid -FrontendPid $frontendPid -BackendPort $Port -FrontendPortNum $FrontendPort

    Write-Title "启动完成"
    Write-Host "  后端：http://localhost:$Port"
    Write-Host "  前端：http://localhost:$FrontendPort"
    Write-Host "  PID 文件：$pidsFile"
    Write-Host "  日志：$backendLog / $backendErrLog"
    Write-Host "        $frontendLog / $frontendErrLog"
    Write-Host ""
}

function Invoke-Stop {
    Write-Title "ZViewer 生产服务停止"
    $existing = Read-PidsFile
    if ($existing) {
        if ($existing.backend -and $existing.backend.pid) {
            $backendPort = if ($existing.backend.port) { [int]$existing.backend.port } else { $Port }
            Stop-ServiceByPidOrPort -ProcessId $existing.backend.pid -LocalPort $backendPort
        }
        if ($existing.frontend -and $existing.frontend.pid) {
            $frontendPortNum = if ($existing.frontend.port) { [int]$existing.frontend.port } else { $FrontendPort }
            Stop-ServiceByPidOrPort -ProcessId $existing.frontend.pid -LocalPort $frontendPortNum
        }
        Remove-Item $pidsFile -Force -ErrorAction SilentlyContinue
        Write-Host "  已清理 PID 文件"
    } else {
        Write-Host "  未找到 PID 文件，尝试按端口清理（仅清理监听进程，dev server 也会被停止）..." -ForegroundColor Yellow
        # 读取持久化端口配置；若无配置则使用参数默认值
        $savedPorts = Read-PortsFile
        $bePort = if ($savedPorts) { $savedPorts.backend } else { $Port }
        $fePort = if ($savedPorts) { $savedPorts.frontend } else { $FrontendPort }
        foreach ($p in @($bePort, $fePort)) {
            if ($p -gt 0 -and (Test-PortInUse -LocalPort $p)) {
                $realPid = Get-PidByPort -LocalPort $p -TimeoutMs 500
                if ($realPid) {
                    Write-Host "  端口 $p 被 PID $realPid 占用，停止该进程..."
                    Stop-ProcessGraceful -ProcessId $realPid | Out-Null
                }
            }
        }
    }
    Write-Host ""
    Write-Host "服务已停止" -ForegroundColor Green
    Write-Host ""
}

function Invoke-Restart {
    Write-Title "ZViewer 生产服务重启"
    Invoke-Stop
    Start-Sleep -Seconds 1
    # 重启不重新构建
    $script:SkipBuild = $true
    Invoke-Start
}

function Invoke-Status {
    Write-Title "ZViewer 生产服务状态"

    # 端口已在主入口统一解析（命令行参数 > 配置文件 > 默认值）
    $savedPorts = Read-PortsFile  # 仅用于显示配置文件状态

    $existing = Read-PidsFile
    if (-not $existing) {
        Write-Host "  PID 文件不存在，服务未运行（或未通过本脚本启动）" -ForegroundColor Yellow
    } else {
        $backendProc = Get-ProcessByIdSafe -ProcessId $existing.backend.pid
        $frontendProc = Get-ProcessByIdSafe -ProcessId $existing.frontend.pid

        Write-Host "  后端:"
        Write-Host "    PID:   $($existing.backend.pid)"
        Write-Host "    端口:  $($existing.backend.port)"
        Write-Host "    URL:   $($existing.backend.url)"
        if ($backendProc) {
            Write-Host "    状态:  运行中 ($($backendProc.ProcessName))" -ForegroundColor Green
        } else {
            Write-Host "    状态:  已退出" -ForegroundColor Red
        }

        Write-Host ""
        Write-Host "  前端:"
        Write-Host "    PID:   $($existing.frontend.pid)"
        Write-Host "    端口:  $($existing.frontend.port)"
        Write-Host "    URL:   $($existing.frontend.url)"
        if ($frontendProc) {
            Write-Host "    状态:  运行中 ($($frontendProc.ProcessName))" -ForegroundColor Green
        } else {
            Write-Host "    状态:  已退出" -ForegroundColor Red
        }
    }

    Write-Host ""
    Write-Host "  端口配置:"
    Write-Host "    后端端口: $Port"
    Write-Host "    前端端口: $FrontendPort"
    if ($savedPorts) {
        Write-Host "    配置文件: $portsFile （已持久化）" -ForegroundColor Green
    } else {
        Write-Host "    配置文件: $portsFile （未创建，使用默认值）" -ForegroundColor Yellow
    }

    Write-Host ""
    Write-Host "  端口占用检查:"
    if (Test-PortInUse -LocalPort $Port) {
        Write-Host "    $Port : 占用" -ForegroundColor Yellow
    } else {
        Write-Host "    $Port : 空闲" -ForegroundColor Green
    }
    if (Test-PortInUse -LocalPort $FrontendPort) {
        Write-Host "    $FrontendPort : 占用" -ForegroundColor Yellow
    } else {
        Write-Host "    $FrontendPort : 空闲" -ForegroundColor Green
    }
    Write-Host ""
}

function Invoke-Logs {
    param([string]$LogTarget)
    if (-not $LogTarget) { $LogTarget = 'backend' }
    $logFile = if ($LogTarget -eq 'frontend') { $frontendLog } else { $backendLog }
    $errFile = if ($LogTarget -eq 'frontend') { $frontendErrLog } else { $backendErrLog }
    Write-Title "ZViewer 日志 - $LogTarget"
    if (-not (Test-Path $logFile) -and -not (Test-Path $errFile)) {
        Write-Host "  日志文件不存在：$logFile" -ForegroundColor Yellow
        Write-Host "  提示：服务可能尚未启动"
        return
    }
    if (Test-Path $errFile) {
        Write-Host "  错误日志：$errFile"
        $errTail = Get-Content $errFile -Tail 20 -ErrorAction SilentlyContinue
        if ($errTail) {
            Write-Host "  --- stderr（最后 20 行）---" -ForegroundColor Red
            $errTail | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
        }
    }
    if (Test-Path $logFile) {
        Write-Host "  标准输出：$logFile"
        Write-Host "  --- stdout（最后 50 行）---"
        Get-Content $logFile -Tail 50
    }
    Write-Host "  ----------------------------------------"
    Write-Host ""
    Write-Host "  提示：实时跟踪日志请使用 Get-Content $logFile -Wait"
    Write-Host ""
}

function Show-Help {
    Write-Title "ZViewer 生产服务管理脚本"
    Write-Host "用法："
    Write-Host "  .\start-prod.ps1 <command> [options]"
    Write-Host ""
    Write-Host "命令："
    Write-Host "  start     构建并启动服务"
    Write-Host "  stop      停止服务"
    Write-Host "  restart   重启服务（不重新构建）"
    Write-Host "  status    查看服务状态"
    Write-Host "  logs      查看日志（默认 backend，可选 frontend）"
    Write-Host "  port      交互式修改端口配置（持久化到 .prod.ports.json）"
    Write-Host "  menu      交互式菜单（双击 .bat 默认进入）"
    Write-Host "  help      显示此帮助"
    Write-Host ""
    Write-Host "选项："
    Write-Host "  -SkipBuild          跳过构建步骤"
    Write-Host "  -AutoBuild          智能构建：产物新于源代码时自动跳过（默认行为）"
    Write-Host "  -NoAutoBuild        禁用智能构建跳过，强制构建"
    Write-Host "  -ForceDeps          强制重新安装依赖（默认跳过已安装）"
    Write-Host "  -Port <int>         后端端口（默认 3000，优先级高于配置文件）"
    Write-Host "  -FrontendPort <int> 前端端口（默认 4173，优先级高于配置文件）"
    Write-Host "  -Database <url>     数据库 URL"
    Write-Host ""
    Write-Host "端口优先级："
    Write-Host "  命令行参数 > .prod.ports.json 配置文件 > 默认值"
    Write-Host "  使用 port 子命令或菜单第 7 项可交互式修改并持久化端口"
    Write-Host ""
    Write-Host "构建优先级："
    Write-Host "  -SkipBuild > -NoAutoBuild > 智能跳过（默认）"
    Write-Host "  智能跳过：检测 dist/ 产物时间戳新于 src/ 所有源代码时自动跳过"
    Write-Host ""
    Write-Host "示例："
    Write-Host "  .\start-prod.ps1 start"
    Write-Host "  .\start-prod.ps1 start -SkipBuild -Port 3001"
    Write-Host "  .\start-prod.ps1 start -NoAutoBuild    # 强制重新构建"
    Write-Host "  .\start-prod.ps1 port"
    Write-Host "  .\start-prod.ps1 logs frontend"
    Write-Host ""
}

function Invoke-Menu {
    # 交互式中文菜单循环。.bat 无参数调用时进入此分支。
    # 所有中文输出在 PowerShell 中处理，规避 cmd.exe 对 .bat 的 GBK 解析问题。
    $ErrorActionPreference = "Continue"  # 菜单循环中不能因单条命令失败就退出
    # 非交互式环境（stdin 被重定向，如管道）下 Read-Host 会立即返回 $null/空，导致死循环。
    # 检测到非交互式环境时直接退出，提示用户通过命令行调用子命令。
    if ([Console]::IsInputRedirected) {
        Write-Host "检测到非交互式输入，菜单模式需要在交互式终端中运行。" -ForegroundColor Yellow
        Write-Host "请直接双击 start-prod.bat，或使用子命令：start / stop / restart / status / logs / port / help" -ForegroundColor Yellow
        Write-Host "示例：.\start-prod.ps1 start" -ForegroundColor Cyan
        return
    }
    while ($true) {
        Write-Host ""
        Write-Host "========================================" -ForegroundColor Cyan
        Write-Host "  ZViewer 生产服务管理" -ForegroundColor Cyan
        Write-Host "========================================" -ForegroundColor Cyan
        Write-Host "  1. 启动服务"
        Write-Host "  2. 停止服务"
        Write-Host "  3. 重启服务"
        Write-Host "  4. 查看状态"
        Write-Host "  5. 查看后端日志"
        Write-Host "  6. 查看前端日志"
        Write-Host "  7. 修改端口配置"
        Write-Host "  0. 退出"
        Write-Host "========================================"
        $choice = Read-Host "请选择 [0-7]"
        # 防御性：Read-Host 返回空（用户直接按 Enter 或异常）时退出，避免死循环
        if ([string]::IsNullOrWhiteSpace($choice)) {
            Write-Host "未收到输入，退出菜单。" -ForegroundColor Yellow
            return
        }
        switch ($choice) {
            '1' { Invoke-Start }
            '2' { Invoke-Stop }
            '3' { Invoke-Restart }
            '4' { Invoke-Status }
            '5' { Invoke-Logs -LogTarget 'backend' }
            '6' { Invoke-Logs -LogTarget 'frontend' }
            '7' { Invoke-Port }
            '0' { return }
            default { Write-Host "无效选项，请重新选择" -ForegroundColor Yellow; Start-Sleep -Seconds 1 }
        }
        if ($choice -in @('1','2','3','4','5','6','7')) {
            Write-Host ""
            Write-Host "按 Enter 返回菜单..." -NoNewline
            [void](Read-Host)
        }
    }
}

function Invoke-Port {
    # 交互式端口配置：读取/修改后端、前端端口，持久化到 .prod.ports.json
    # 下次 start 时自动读取（命令行 -Port / -FrontendPort 参数优先级更高）
    Write-Title "ZViewer 端口配置"

    # 非交互式环境检测
    if ([Console]::IsInputRedirected) {
        Write-Host "检测到非交互式输入，端口配置需要在交互式终端中运行。" -ForegroundColor Yellow
        Write-Host "也可通过命令行参数指定：.\start-prod.ps1 start -Port 3001 -FrontendPort 4180" -ForegroundColor Cyan
        return
    }

    # 读取当前生效的端口（优先级：配置文件 > 默认值）
    $saved = Read-PortsFile
    $currentBackend = if ($saved) { $saved.backend } else { $Port }
    $currentFrontend = if ($saved) { $saved.frontend } else { $FrontendPort }

    while ($true) {
        Write-Host ""
        Write-Host "  当前端口配置：" -ForegroundColor Cyan
        Write-Host "    后端端口：$currentBackend"
        Write-Host "    前端端口：$currentFrontend"
        if (Test-Path $portsFile) {
            Write-Host "    配置文件：$portsFile （已持久化）" -ForegroundColor Green
        } else {
            Write-Host "    配置文件：$portsFile （未创建，使用默认值）" -ForegroundColor Yellow
        }
        Write-Host ""
        Write-Host "  1. 修改后端端口"
        Write-Host "  2. 修改前端端口"
        Write-Host "  3. 同时修改两个端口"
        Write-Host "  4. 重置为默认值（后端 $Port，前端 $FrontendPort）"
        Write-Host "  0. 返回"
        $choice = Read-Host "请选择 [0-4]"
        if ([string]::IsNullOrWhiteSpace($choice)) { return }

        switch ($choice) {
            '1' {
                $newPort = Read-PortInput -Prompt "  输入新的后端端口" -DefaultValue $currentBackend
                if ($newPort -eq $currentFrontend) {
                    Write-Host "  后端端口不能与前端端口 ($currentFrontend) 相同" -ForegroundColor Red
                    break
                }
                $currentBackend = $newPort
                Write-PortsFile -BackendPort $currentBackend -FrontendPort $currentFrontend
                Write-Host "  已保存：后端端口 = $currentBackend" -ForegroundColor Green
            }
            '2' {
                $newPort = Read-PortInput -Prompt "  输入新的前端端口" -DefaultValue $currentFrontend
                if ($newPort -eq $currentBackend) {
                    Write-Host "  前端端口不能与后端端口 ($currentBackend) 相同" -ForegroundColor Red
                    break
                }
                $currentFrontend = $newPort
                Write-PortsFile -BackendPort $currentBackend -FrontendPort $currentFrontend
                Write-Host "  已保存：前端端口 = $currentFrontend" -ForegroundColor Green
            }
            '3' {
                $newBackend = Read-PortInput -Prompt "  输入新的后端端口" -DefaultValue $currentBackend
                $newFrontend = Read-PortInput -Prompt "  输入新的前端端口" -DefaultValue $currentFrontend
                if ($newBackend -eq $newFrontend) {
                    Write-Host "  后端端口与前端端口不能相同" -ForegroundColor Red
                    break
                }
                $currentBackend = $newBackend
                $currentFrontend = $newFrontend
                Write-PortsFile -BackendPort $currentBackend -FrontendPort $currentFrontend
                Write-Host "  已保存：后端 = $currentBackend，前端 = $currentFrontend" -ForegroundColor Green
            }
            '4' {
                Remove-Item $portsFile -Force -ErrorAction SilentlyContinue
                $currentBackend = $Port
                $currentFrontend = $FrontendPort
                Write-Host "  已重置为默认值：后端 = $currentBackend，前端 = $currentFrontend" -ForegroundColor Green
            }
            '0' { return }
            default { Write-Host "  无效选项" -ForegroundColor Yellow }
        }
    }
}

# ============ 主入口 ============

try {
    # 端口优先级：命令行参数 > .prod.ports.json 配置文件 > 默认值
    # 在进入子命令前统一解析（port 子命令除外，它自己管理配置文件）
    if ($Command -in @('start', 'restart', 'status')) {
        $savedPorts = Read-PortsFile
        if ($savedPorts) {
            if (-not $PSBoundParameters.ContainsKey('Port')) {
                $Port = $savedPorts.backend
            }
            if (-not $PSBoundParameters.ContainsKey('FrontendPort')) {
                $FrontendPort = $savedPorts.frontend
            }
        }
    }

    switch ($Command) {
        'start'   { Invoke-Start }
        'stop'    { Invoke-Stop }
        'restart' { Invoke-Restart }
        'status'  { Invoke-Status }
        'logs'    { Invoke-Logs -LogTarget $Target }
        'port'    { Invoke-Port }
        'menu'    { Invoke-Menu }
        default   { Show-Help }
    }
} catch {
    Write-Host ""
    Write-Host "[错误] $_" -ForegroundColor Red
    Write-Host ""
    exit 1
}
