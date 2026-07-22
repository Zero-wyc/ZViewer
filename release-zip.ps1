# release-zip.ps1 —— ZControl 一键打包发布脚本
#
# 功能：
#   1. 自动构建前后端代码（npm run build 通过 workspaces 同时构建）
#   2. 将项目源码 + 构建产物（backend/dist / frontend/dist）打包为可分发的 zip
#   3. 自动排除 node_modules / 数据库 / .env / 日志 / 测试文件 / IDE 临时文件
#   4. 接收者解压后执行 npm install --omit=dev && npm start 即可运行（无需再构建）
#
# 用法：
#   .\release-zip.ps1              # 打包到项目根目录，文件名带时间戳
#   .\release-zip.ps1 -OutputPath C:\releases\zcontrol.zip
#   .\release-zip.ps1 -SkipBuild   # 跳过构建步骤（使用已有 dist 产物）
#   .\release-zip.ps1 -Help        # 显示帮助
#
# 打包内容：所有源码、配置、文档、启动脚本、Docker 文件、构建产物（dist）
# 排除内容：依赖（node_modules）、数据库、环境配置、日志、测试、IDE 文件

param(
  [string]$OutputPath = '',
  [switch]$SkipBuild,
  [switch]$NoClean,
  [switch]$Help
)

$ErrorActionPreference = 'Stop'

# ===== 排除规则 =====

# 排除目录（按目录名匹配，任何层级）
# 注意：不再排除 dist / build —— 构建产物需要打包进去，让接收者无需再构建
$excludeDirs = @(
  'node_modules',
  '.git',
  '.trae',
  '.update-temp',
  '.vscode',
  '.idea',
  '__pycache__',
  '.next',
  'coverage',
  'test-media'
)

# 排除文件（按文件名匹配）
$excludeFiles = @(
  '.env',
  '.env.local',
  '.prod.pids.json',
  '.prod.ports.json',
  'dev.sqlite',
  'test-dev.sqlite',
  # 测试脚本与输出
  'test-browser.py',
  'verify_specs.py',
  'test-resolve.mjs',
  'test-resolve-output.txt',
  'test-refactor-output.txt',
  'verify-bili-vip-failure.png',
  # 打包脚本自身
  'release-zip.ps1',
  'release-zip.bat',
  # 临时检查文件
  '.check-ps1.ps1',
  '.check-sqlite.js',
  '.check-sqlite.ps1',
  '.add-bom.ps1'
)

# 排除扩展名
$excludeExts = @('.sqlite', '.sqlite-journal', '.sqlite-wal', '.sqlite-shm', '.log')

# ===== 辅助函数 =====

function Write-Title {
  param([string]$Text)
  Write-Host ''
  Write-Host ('=' * 60) -ForegroundColor Cyan
  Write-Host "  $Text" -ForegroundColor Cyan
  Write-Host ('=' * 60) -ForegroundColor Cyan
  Write-Host ''
}

function Show-Help {
  Write-Title 'ZControl 一键打包发布脚本'
  Write-Host '用法：' -ForegroundColor Yellow
  Write-Host '  .\release-zip.ps1              打包到项目根目录，文件名带时间戳'
  Write-Host '  .\release-zip.ps1 -OutputPath <路径>  指定输出 zip 路径'
  Write-Host '  .\release-zip.ps1 -SkipBuild   跳过构建步骤（使用已有 dist 产物）'
  Write-Host '  .\release-zip.ps1 -NoClean     保留临时目录（调试用）'
  Write-Host '  .\release-zip.ps1 -Help        显示本帮助'
  Write-Host ''
  Write-Host '打包流程：' -ForegroundColor Yellow
  Write-Host '  1. 构建前后端代码（npm run build）'
  Write-Host '  2. 复制源码 + 构建产物到临时目录（排除敏感文件）'
  Write-Host '  3. 压缩为 zip'
  Write-Host '  4. 验证输出'
  Write-Host ''
  Write-Host '排除内容：' -ForegroundColor Yellow
  Write-Host '  依赖：node_modules'
  Write-Host '  数据库：*.sqlite / *.sqlite-journal / *.sqlite-wal / *.sqlite-shm'
  Write-Host '  环境配置：.env / .env.local'
  Write-Host '  运行时状态：.prod.pids.json / .prod.ports.json'
  Write-Host '  日志：*.log'
  Write-Host '  版本控制：.git'
  Write-Host '  IDE：.vscode / .idea / .trae'
  Write-Host '  测试：test-* / verify-* / test-media/'
  Write-Host ''
  Write-Host '包含内容：' -ForegroundColor Yellow
  Write-Host '  所有源码、配置、文档、启动脚本、Docker 文件'
  Write-Host '  构建产物：backend/dist / frontend/dist（接收者无需再构建）'
  Write-Host ''
  Write-Host '接收者使用方式：' -ForegroundColor Yellow
  Write-Host '  1. 解压 zip'
  Write-Host '  2. 复制 backend/.env.example 为 backend/.env 并配置'
  Write-Host '  3. npm install --omit=dev   # 仅安装运行时依赖'
  Write-Host '  4. npm start（或使用 start-prod.bat）'
  Write-Host ''
}

function Invoke-Build {
  Write-Title '步骤 1/4：构建前后端代码'

  $root = $PSScriptRoot
  if (-not $root) { $root = Get-Location }

  Write-Host '  执行 npm run build（通过 workspaces 同时构建前后端）...' -ForegroundColor Yellow
  Write-Host ''
  Push-Location $root
  try {
    & npm run build
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
      throw "构建失败，npm run build 退出码：$exitCode"
    }
  } finally {
    Pop-Location
  }

  Write-Host ''
  # 验证产物
  $backendArtifact = Join-Path $root 'backend\dist\index.js'
  $frontendArtifact = Join-Path $root 'frontend\dist\index.html'

  if (-not (Test-Path $backendArtifact)) {
    throw "后端构建产物不存在：$backendArtifact"
  }
  if (-not (Test-Path $frontendArtifact)) {
    throw "前端构建产物不存在：$frontendArtifact"
  }

  Write-Host '  构建成功：' -ForegroundColor Green
  Write-Host "    backend/dist/index.js"
  Write-Host "    frontend/dist/index.html"
  Write-Host ''
}

function Invoke-Release {
  $root = $PSScriptRoot
  if (-not $root) { $root = Get-Location }

  Write-Title 'ZControl 一键打包发布'

  # 1. 确定输出路径
  if ($OutputPath) {
    $dest = $OutputPath
    if (-not $dest.EndsWith('.zip')) { $dest += '.zip' }
    # 转为绝对路径
    if (-not [System.IO.Path]::IsPathRooted($dest)) {
      $dest = Join-Path $root $dest
    }
  } else {
    $timestamp = Get-Date -Format 'yyyyMMdd-HHmm'
    $dest = Join-Path $root "ZControl-release-$timestamp.zip"
  }

  Write-Host '打包配置：' -ForegroundColor Yellow
  Write-Host "  源目录：$root"
  Write-Host "  输出：$dest"
  Write-Host "  构建步骤：$(if ($SkipBuild) { '跳过（使用已有产物）' } else { '执行构建' })"
  Write-Host ''

  # 2. 构建前后端代码
  if (-not $SkipBuild) {
    Invoke-Build
  } else {
    Write-Host '步骤 1/4：跳过构建（-SkipBuild）' -ForegroundColor Yellow
    # 验证已有产物
    $backendArtifact = Join-Path $root 'backend\dist\index.js'
    $frontendArtifact = Join-Path $root 'frontend\dist\index.html'
    if (-not (Test-Path $backendArtifact)) {
      throw "未找到后端构建产物：$backendArtifact（请去掉 -SkipBuild 重新打包）"
    }
    if (-not (Test-Path $frontendArtifact)) {
      throw "未找到前端构建产物：$frontendArtifact（请去掉 -SkipBuild 重新打包）"
    }
    Write-Host '  使用已有构建产物' -ForegroundColor Green
    Write-Host ''
  }

  # 3. 创建临时目录并复制文件
  $tempBase = Join-Path $env:TEMP "zcontrol-release-$(Get-Date -Format 'yyyyMMddHHmmss')"
  $tempDir = Join-Path $tempBase 'ZControl'
  Write-Host '步骤 2/4：复制文件（含构建产物，过滤敏感内容）...' -ForegroundColor Yellow
  Write-Host "  临时目录：$tempDir"
  New-Item -ItemType Directory -Path $tempDir -Force | Out-Null

  try {
    # 使用 robocopy 复制（高效 + 原生排除规则）
    # robocopy 退出码 < 8 均视为成功
    $robocopyArgs = @(
      $root,
      $tempDir,
      '/E',           # 包含子目录（含空目录）
      '/NFL',         # 不列出文件
      '/NDL',         # 不列出目录
      '/NJH',         # 不显示作业头
      '/NJS',         # 不显示作业摘要
      '/NP',          # 不显示进度
      '/R:1',         # 失败重试 1 次
      '/W:1'          # 重试间隔 1 秒
    )

    # 添加排除目录（/XD 接受目录名，会匹配任何层级同名目录）
    foreach ($dir in $excludeDirs) {
      $robocopyArgs += '/XD'
      $robocopyArgs += $dir
    }

    # 添加排除文件（/XF 接受文件名或通配符）
    foreach ($file in $excludeFiles) {
      $robocopyArgs += '/XF'
      $robocopyArgs += $file
    }

    # 添加排除扩展名
    foreach ($ext in $excludeExts) {
      $robocopyArgs += '/XF'
      $robocopyArgs += "*$ext"
    }

    # 执行 robocopy
    & robocopy @robocopyArgs | Out-Null
    $robocopyExit = $LASTEXITCODE

    # robocopy 退出码 < 8 均为成功
    if ($robocopyExit -ge 8) {
      throw "robocopy 失败，退出码：$robocopyExit"
    }

    # 统计复制的文件数
    $fileCount = (Get-ChildItem -Path $tempDir -Recurse -File).Count
    $dirCount = (Get-ChildItem -Path $tempDir -Recurse -Directory).Count
    Write-Host "  已复制 $fileCount 个文件，$dirCount 个目录" -ForegroundColor Green

    # 验证构建产物已包含
    $tempBackendArtifact = Join-Path $tempDir 'backend\dist\index.js'
    $tempFrontendArtifact = Join-Path $tempDir 'frontend\dist\index.html'
    if (-not (Test-Path $tempBackendArtifact)) {
      throw "构建产物未正确复制到临时目录：$tempBackendArtifact"
    }
    if (-not (Test-Path $tempFrontendArtifact)) {
      throw "构建产物未正确复制到临时目录：$tempFrontendArtifact"
    }
    Write-Host '  构建产物已包含：backend/dist / frontend/dist' -ForegroundColor Green

    # 4. 压缩
    Write-Host ''
    Write-Host '步骤 3/4：压缩为 zip...' -ForegroundColor Yellow
    if (Test-Path $dest) {
      Remove-Item $dest -Force
      Write-Host "  已覆盖旧文件：$dest"
    }
    Compress-Archive -Path (Join-Path $tempDir '*') -DestinationPath $dest -CompressionLevel Optimal
    Write-Host "  压缩完成" -ForegroundColor Green

    # 5. 输出统计
    Write-Host ''
    Write-Host '步骤 4/4：验证输出...' -ForegroundColor Yellow
    if (-not (Test-Path $dest)) {
      throw "输出文件未生成：$dest"
    }
    $destItem = Get-Item $dest
    $sizeMB = $destItem.Length / 1MB

    Write-Title '打包完成'
    Write-Host '输出文件：' -ForegroundColor Yellow
    Write-Host "  路径：$($destItem.FullName)" -ForegroundColor Green
    Write-Host ("  大小：{0:N2} MB" -f $sizeMB) -ForegroundColor Green
    Write-Host "  文件数：$fileCount" -ForegroundColor Green
    Write-Host ''
    Write-Host '接收者使用方式：' -ForegroundColor Yellow
    Write-Host '  1. 解压 zip'
    Write-Host '  2. 复制 backend/.env.example 为 backend/.env 并配置'
    Write-Host '  3. npm install --omit=dev   # 仅安装运行时依赖'
    Write-Host '  4. npm start（或使用 start-prod.bat）'
    Write-Host ''
  } finally {
    # 清理临时目录
    if (-not $NoClean -and (Test-Path $tempBase)) {
      Write-Host '清理临时目录...' -ForegroundColor Yellow
      Remove-Item $tempBase -Recurse -Force -ErrorAction SilentlyContinue
    } elseif ($NoClean) {
      Write-Host "保留临时目录（-NoClean）：$tempBase" -ForegroundColor Yellow
    }
  }
}

# ===== 入口 =====

if ($Help) {
  Show-Help
  exit 0
}

try {
  Invoke-Release
} catch {
  Write-Host ''
  Write-Host "打包失败：$_" -ForegroundColor Red
  Write-Host ''
  exit 1
}
