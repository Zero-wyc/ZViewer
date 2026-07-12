@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

set "ROOT=%~dp0"
set "ROOT=%ROOT:~0,-1%"
set "BACKEND=%ROOT%\backend"
set "FRONTEND=%ROOT%\frontend"
set "BACKEND_PORT=3000"
set "FRONTEND_PORT=4173"
set "PIDS_FILE=%ROOT%\.prod.pids.json"

cd /d "%ROOT%"

echo 检查 Node.js ...
node -v >nul 2>&1
if errorlevel 1 (
  echo [错误] Node.js 未安装或不在 PATH 中
  pause
  exit /b 1
)
echo Node.js: 
node -v
npm -v

echo.
echo [1/5] 安装根目录依赖...
if exist "%ROOT%\package-lock.json" (
  call npm ci
) else (
  call npm install
)
if errorlevel 1 (
  echo [错误] 根目录依赖安装失败
  pause
  exit /b 1
)

echo.
echo [2/5] 安装后端依赖...
cd /d "%BACKEND%"
if exist "%BACKEND%\package-lock.json" (
  call npm ci
) else (
  call npm install
)
if errorlevel 1 (
  echo [错误] 后端依赖安装失败
  pause
  exit /b 1
)

echo.
echo [3/5] 安装前端依赖...
cd /d "%FRONTEND%"
if exist "%FRONTEND%\package-lock.json" (
  call npm ci
) else (
  call npm install
)
if errorlevel 1 (
  echo [错误] 前端依赖安装失败
  pause
  exit /b 1
)

echo.
echo [4/5] 构建后端...
cd /d "%BACKEND%"
call npm run build
if errorlevel 1 (
  echo [错误] 后端构建失败
  pause
  exit /b 1
)

echo.
echo [4/5] 构建前端...
cd /d "%FRONTEND%"
call npm run build
if errorlevel 1 (
  echo [错误] 前端构建失败
  pause
  exit /b 1
)

if not exist "%BACKEND%\dist\index.js" (
  echo [错误] 未找到 backend/dist/index.js，构建未成功
  pause
  exit /b 1
)

echo.
echo [5/5] 启动生产服务...

:: 启动后端（通过 PowerShell 获取 PID）
powershell -NoProfile -ExecutionPolicy Bypass -Command "\
  $env:PORT='%BACKEND_PORT%'; \
  $env:NODE_ENV='production'; \
  $proc = Start-Process -FilePath 'node' -ArgumentList 'dist/index.js' -WorkingDirectory '%BACKEND%' -WindowStyle Hidden -PassThru; \
  $proc.Id | Out-File -FilePath '%ROOT%\.backend.pid' -Encoding utf8; \
  Write-Host ('后端已启动，PID: ' + $proc.Id)"
if errorlevel 1 (
  echo [错误] 后端启动失败
  pause
  exit /b 1
)

timeout /t 1 /nobreak >nul

:: 启动前端预览（通过 PowerShell 获取 PID）
powershell -NoProfile -ExecutionPolicy Bypass -Command "\
  $proc = Start-Process -FilePath 'npx' -ArgumentList 'vite preview --port %FRONTEND_PORT%' -WorkingDirectory '%FRONTEND%' -WindowStyle Hidden -PassThru; \
  $proc.Id | Out-File -FilePath '%ROOT%\.frontend.pid' -Encoding utf8; \
  Write-Host ('前端已启动，PID: ' + $proc.Id)"
if errorlevel 1 (
  echo [错误] 前端启动失败
  pause
  exit /b 1
)

:: 汇总 PID 信息并写入 JSON
powershell -NoProfile -ExecutionPolicy Bypass -Command "\
  $backendPid = Get-Content '%ROOT%\.backend.pid' -Raw; \
  $frontendPid = Get-Content '%ROOT%\.frontend.pid' -Raw; \
  $pids = @{ \
    backend = @{ pid = [int]$backendPid; port = %BACKEND_PORT%; url = 'http://localhost:%BACKEND_PORT%' }; \
    frontend = @{ pid = [int]$frontendPid; port = %FRONTEND_PORT%; url = 'http://localhost:%FRONTEND_PORT%' } \
  }; \
  $pids | ConvertTo-Json -Depth 3 | Out-File -FilePath '%PIDS_FILE%' -Encoding utf8; \
  Remove-Item '%ROOT%\.backend.pid', '%ROOT%\.frontend.pid' -ErrorAction SilentlyContinue"

echo.
echo ========================================
echo  生产服务已启动
echo  后端：http://localhost:%BACKEND_PORT%
echo  前端：http://localhost:%FRONTEND_PORT%
echo  PID 文件：%PIDS_FILE%
echo ========================================
echo.
echo 按任意键关闭本窗口（服务将在后台继续运行）...
pause >nul
