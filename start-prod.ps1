#!/usr/bin/env pwsh
#Requires -Version 5.1

param(
    [switch]$SkipBuild,
    [int]$Port = 3000,
    [string]$Database
)

$ErrorActionPreference = "Stop"

$rootDir = $PSScriptRoot
if (-not $rootDir) { $rootDir = (Get-Location).Path }
$backendDir = Join-Path $rootDir "backend"
$frontendDir = Join-Path $rootDir "frontend"
$pidsFile = Join-Path $rootDir ".prod.pids.json"
$frontendPort = 4173

function Test-CommandInstalled {
    param([string]$Name)
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $cmd) {
        throw "$Name 未安装或不在 PATH 中"
    }
    return $cmd
}

function Install-ProjectDependencies {
    param([string]$Dir)
    Push-Location $Dir
    try {
        if (Test-Path (Join-Path $Dir "package-lock.json")) {
            Write-Host "[$Dir] 检测到 package-lock.json，执行 npm ci ..."
            npm ci
        } else {
            Write-Host "[$Dir] 未检测到 package-lock.json，执行 npm install ..."
            npm install
        }
        if ($LASTEXITCODE -ne 0) {
            throw "依赖安装失败：$Dir"
        }
    } finally {
        Pop-Location
    }
}

function Start-BackendService {
    param([int]$BackendPort, [string]$DatabaseUrl)
    $env:PORT = "$BackendPort"
    $env:NODE_ENV = "production"
    if ($DatabaseUrl) { $env:DATABASE_URL = $DatabaseUrl }
    $msg = "启动后端服务：PORT=$BackendPort"
    if ($DatabaseUrl) { $msg += ", DATABASE_URL=$DatabaseUrl" }
    Write-Host $msg
    return Start-Process -FilePath "node" -ArgumentList "dist/index.js" -WorkingDirectory $backendDir -NoNewWindow -PassThru
}

function Start-FrontendService {
    Write-Host "启动前端静态服务：PORT=$frontendPort"
    return Start-Process -FilePath "node" -ArgumentList "./node_modules/vite/bin/vite.js", "preview", "--port", "$frontendPort" -WorkingDirectory $frontendDir -NoNewWindow -PassThru
}

# 1. 检查 node 与 npm
$nodeCmd = Test-CommandInstalled "node"
$npmCmd = Test-CommandInstalled "npm"
Write-Host "Node.js: $( & $nodeCmd.Source --version )"
Write-Host "npm: $( & $npmCmd.Source --version )"

# 2. 安装依赖（优先 npm ci）
Install-ProjectDependencies $rootDir
Install-ProjectDependencies $backendDir
Install-ProjectDependencies $frontendDir

# 3. 构建（可跳过）
if (-not $SkipBuild) {
    Write-Host "构建后端 ..."
    Push-Location $backendDir
    try {
        npm run build
        if ($LASTEXITCODE -ne 0) { throw "后端构建失败" }
    } finally {
        Pop-Location
    }

    Write-Host "构建前端 ..."
    Push-Location $frontendDir
    try {
        npm run build
        if ($LASTEXITCODE -ne 0) { throw "前端构建失败" }
    } finally {
        Pop-Location
    }
} else {
    Write-Host "跳过构建"
}

# 4. 确认产物存在
if (-not (Test-Path (Join-Path $backendDir "dist/index.js"))) {
    throw "未找到 backend/dist/index.js，请先构建"
}

# 5. 启动服务
$backendProc = Start-BackendService -BackendPort $Port -DatabaseUrl $Database
Write-Host "后端进程已启动，PID: $($backendProc.Id)"
Start-Sleep -Milliseconds 500

$frontendProc = Start-FrontendService
Write-Host "前端进程已启动，PID: $($frontendProc.Id)"

# 6. 写入 PID 文件
$pids = @{
    backend  = @{ pid = $backendProc.Id; port = $Port; url = "http://localhost:$Port" }
    frontend = @{ pid = $frontendProc.Id; port = $frontendPort; url = "http://localhost:$frontendPort" }
}
$pids | ConvertTo-Json -Depth 3 | Set-Content -Path $pidsFile -Encoding UTF8

Write-Host ""
Write-Host "生产服务已启动："
Write-Host "  后端：http://localhost:$Port"
Write-Host "  前端：http://localhost:$frontendPort"
Write-Host "PID 文件：$pidsFile"
