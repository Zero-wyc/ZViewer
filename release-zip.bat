@echo off
setlocal

set "ROOT=%~dp0"
set "ROOT=%ROOT:~0,-1%"
set "PS1=%ROOT%\release-zip.ps1"

:: Check PowerShell
where powershell >nul 2>&1
if errorlevel 1 (
  echo [ERROR] PowerShell not found. Please install Windows PowerShell.
  pause
  exit /b 1
)

:: Check release-zip.ps1 exists
if not exist "%PS1%" (
  echo [ERROR] File not found: %PS1%
  pause
  exit /b 1
)

:: All output (including Chinese menu) is handled by PowerShell,
:: because cmd.exe parses .bat bytes with the system ANSI codepage (GBK on zh-CN),
:: which breaks UTF-8 Chinese characters even with `chcp 65001`.
:: This .bat is a pure forwarder - no Chinese here.

if "%~1"=="" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
)

endlocal
exit /b %ERRORLEVEL%
