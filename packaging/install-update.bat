@echo off
REM zviewer-installer: 1
REM
REM ZViewer 发行包自带的 Windows 更新安装脚本。
REM
REM 更新时由 ZViewer 更新器复制到 %ZVIEWER_UPDATE_ROOT%\apply-update.bat 后执行。
REM 安装策略（停哪些进程、怎么覆盖、怎么重启）跟着版本包走，旧版更新器
REM 只负责「发现并执行这份脚本」，不再内嵌清单。
REM
REM 契约（更新器注入环境变量，缺失即失败）：
REM   ZVIEWER_UPDATE_ROOT       安装根目录
REM   ZVIEWER_UPDATE_TEMP       临时目录（含已下载的压缩包）
REM   ZVIEWER_UPDATE_EXTRACTED  解压后的新版本目录
REM   ZVIEWER_UPDATE_MODE       native（Windows 恒为 native）
REM   ZVIEWER_UPDATE_TAG        日志前缀
REM   ZVIEWER_UPDATE_FROM       更新前版本
REM
REM 首行 `REM zviewer-installer: N` 是契约版本，更新器只接受自己认识的上限。

chcp 65001 >nul
setlocal enabledelayedexpansion

if not defined ZVIEWER_UPDATE_TAG set "ZVIEWER_UPDATE_TAG=[更新脚本]"

set "ROOT=%ZVIEWER_UPDATE_ROOT%"
set "TEMP_DIR=%ZVIEWER_UPDATE_TEMP%"
set "EXTRACTED_DIR=%ZVIEWER_UPDATE_EXTRACTED%"
set "FROM_VERSION=%ZVIEWER_UPDATE_FROM%"
if not defined FROM_VERSION set "FROM_VERSION=unknown"

if not defined ROOT (
  echo [错误] ZVIEWER_UPDATE_ROOT 未提供
  exit /b 2
)
if not exist "%ROOT%\" (
  echo [错误] 安装根目录不存在: %ROOT%
  exit /b 2
)
if not defined EXTRACTED_DIR (
  echo [错误] ZVIEWER_UPDATE_EXTRACTED 未提供
  exit /b 2
)
if not exist "%EXTRACTED_DIR%\" (
  echo [错误] 解压目录不存在: %EXTRACTED_DIR%
  exit /b 2
)
if not defined TEMP_DIR (
  echo [错误] ZVIEWER_UPDATE_TEMP 未提供
  exit /b 2
)

call :do_update >> "%ROOT%\update.log" 2>&1
exit /b

:do_update
echo.
echo ========================================
echo %ZVIEWER_UPDATE_TAG% 开始执行 %date% %time%
echo %ZVIEWER_UPDATE_TAG% 从 %FROM_VERSION% 更新，包目录=%EXTRACTED_DIR%
echo ========================================

echo %ZVIEWER_UPDATE_TAG% 等待后端返回响应...
REM 用 ping 代替 timeout：timeout 在隐藏窗口/非交互下会直接报错
ping 127.0.0.1 -n 4 >nul

echo %ZVIEWER_UPDATE_TAG% 停止现有服务...
REM 不带 /T：/T 会连执行本脚本的 cmd.exe 一起杀（它是父进程链上的一环）
taskkill /F /IM zviewer-frontend.exe >nul 2>&1
taskkill /F /IM zviewer-backend.exe >nul 2>&1

REM 网页控制台（单文件包会连带它一起换掉）
taskkill /F /IM zviewer-webgui.exe >nul 2>&1

REM 脚本记录的 PID（旧版 start.ps1 / start.sh 的兼容路径）
if exist "%ROOT%\.prod.pids.json" (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$pids = Get-Content '%ROOT%\.prod.pids.json' -Raw | ConvertFrom-Json; foreach ($key in $pids.PSObject.Properties.Name) { $info = $pids.$key; if ($info.pid) { Stop-Process -Id $info.pid -Force -ErrorAction SilentlyContinue } }"
  del "%ROOT%\.prod.pids.json" >nul 2>&1
)
taskkill /F /IM node.exe >nul 2>&1

echo %ZVIEWER_UPDATE_TAG% 等待端口释放...
ping 127.0.0.1 -n 4 >nul

echo %ZVIEWER_UPDATE_TAG% 备份 config 目录...
set "CONFIG_DIR=%ROOT%\config"
set "CONFIG_BACKUP="
if exist "%CONFIG_DIR%\" (
  set "CONFIG_BACKUP=%ROOT%\.config-backup-!RANDOM!"
  xcopy /E /Y /I "%CONFIG_DIR%" "!CONFIG_BACKUP!" >nul
  if errorlevel 1 (
    echo [错误] config 目录备份失败
    exit /b 1
  )
  echo %ZVIEWER_UPDATE_TAG% 已备份 config 到 !CONFIG_BACKUP!
  rmdir /S /Q "%CONFIG_DIR%"
)

echo %ZVIEWER_UPDATE_TAG% 应用新文件...
REM 策略：整包覆盖。旧版本多出来的顶层文件不会自动清理，
REM 需要白名单时在这里改（BINARIES / FILES / DIRS 三段）。
xcopy /E /Y /I "%EXTRACTED_DIR%\*" "%ROOT%\" >nul
if errorlevel 1 (
  echo [错误] 文件复制失败
  if defined CONFIG_BACKUP if exist "!CONFIG_BACKUP!\" (
    xcopy /E /Y /I "!CONFIG_BACKUP!" "%CONFIG_DIR%" >nul
  )
  exit /b 1
)

REM 引导脚本本身不留存：下次更新必须用新包里的那份
del "%ROOT%\install-update.sh" >nul 2>&1
del "%ROOT%\install-update.bat" >nul 2>&1

if not exist "%ROOT%\zviewer-backend.exe" (
  echo [错误] 更新后未找到 zviewer-backend.exe，更新包可能损坏
  if defined CONFIG_BACKUP if exist "!CONFIG_BACKUP!\" (
    xcopy /E /Y /I "!CONFIG_BACKUP!" "%CONFIG_DIR%" >nul
  )
  exit /b 1
)

echo %ZVIEWER_UPDATE_TAG% 恢复 config 目录...
if defined CONFIG_BACKUP if exist "!CONFIG_BACKUP!\" (
  if not exist "%CONFIG_DIR%\" mkdir "%CONFIG_DIR%"
  xcopy /E /Y /I "!CONFIG_BACKUP!\*" "%CONFIG_DIR%" >nul
  rmdir /S /Q "!CONFIG_BACKUP!"
  echo %ZVIEWER_UPDATE_TAG% 已恢复 config 目录（用户数据已保留）
)

echo %ZVIEWER_UPDATE_TAG% 清理临时文件...
rmdir /S /Q "%TEMP_DIR%" >nul 2>&1

echo %ZVIEWER_UPDATE_TAG% 重新启动服务...
REM 直接走 start.ps1：start.bat 在 PowerShell 检查失败时会 pause，
REM 隐藏窗口下会永久挂起，更新看起来像没执行。
set "PS1=%ROOT%\start.ps1"
if not exist "%PS1%" set "PS1=%ROOT%\start-win.ps1"
if exist "%PS1%" (
  start "" /b powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" start
) else if exist "%ROOT%\start.bat" (
  start "" /b "%ROOT%\start.bat" start
) else (
  echo %ZVIEWER_UPDATE_TAG% 未找到 start.ps1/start.bat，直接启动 exe
  if exist "%ROOT%\.env" (
    for /f "usebackq tokens=1,* delims==" %%a in ("%ROOT%\.env") do (
      if /i "%%a"=="PORT" set "PORT=%%b"
    )
  )
  if not defined PORT set "PORT=3333"
  set "NODE_ENV=production"
  set "HOST=::"
  start "" /D "%ROOT%" "%ROOT%\zviewer-backend.exe"
)

echo %ZVIEWER_UPDATE_TAG% 更新完成，服务正在启动... %date% %time%
REM bat 执行期间被 cmd 持有句柄，自我删除会丢行，交给下次更新覆盖
exit /b 0
