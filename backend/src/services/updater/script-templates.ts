/**
 * 更新脚本模板（从 updater/index.ts 外置）。
 *
 * 模板以双花括号占位符表达运行时注入的路径与差异段，由 renderTemplate 渲染。
 * 脚本正文逐字取自原实现，运行时输出与原脚本一致。
 *
 * 合并说明：Docker 与 Linux 两版 shell 脚本共用同一骨架，
 * 差异只在「终止进程 / 应用文件 / 收尾重启」三段，由调用方按平台注入。
 */

/** 通用 shell 骨架（Docker 与 Linux 共用） */
export const APPLY_UPDATE_SH_TEMPLATE = `#!/bin/bash
set -e

ROOT="{{ROOT}}"
TEMP_DIR="{{TEMP_DIR}}"
EXTRACTED_DIR="{{EXTRACTED_DIR}}"
CONFIG_DIR="$ROOT/config"
CONFIG_BACKUP="$ROOT/.config-backup-$$"
{{EXTRA_VARS}}
LOG_FILE="$ROOT/update.log"

# 将输出重定向到日志文件，方便诊断更新失败原因
exec >> "$LOG_FILE" 2>&1

echo ""
echo "========================================"
echo "{{TAG}} 开始执行 $(date)"
echo "========================================"

echo "{{TAG}} 等待后端返回响应..."
sleep 3

{{STOP_SECTION}}

# 备份 config 目录（包含数据库、用户上传等持久化数据）
echo "{{TAG}} 备份 config 目录..."
if [ -d "$CONFIG_DIR" ]; then
  cp -r "$CONFIG_DIR" "$CONFIG_BACKUP"
{{AFTER_BACKUP}}
  echo "{{TAG}} 已备份 config 到 $CONFIG_BACKUP"
fi

echo "{{TAG}} 应用新文件..."
if [ ! -d "$EXTRACTED_DIR" ]; then
  echo "[错误] 未找到解压目录：$EXTRACTED_DIR"
  if [ -d "$CONFIG_BACKUP" ]; then
    cp -rf "$CONFIG_BACKUP" "$CONFIG_DIR"
  fi
  exit 1
fi

{{APPLY_SECTION}}

# 验证关键文件是否存在
if [ ! -f "$ROOT/zviewer-backend" ]; then
  echo "[错误] 更新后未找到 zviewer-backend，更新包可能损坏"
  if [ -d "$CONFIG_BACKUP" ]; then
    cp -rf "$CONFIG_BACKUP" "$CONFIG_DIR"
  fi
  exit 1
fi

# 恢复 config 目录
echo "{{TAG}} 恢复 config 目录..."
if [ -d "$CONFIG_BACKUP" ]; then
  mkdir -p "$CONFIG_DIR"
  cp -rf "$CONFIG_BACKUP/"* "$CONFIG_DIR/" 2>/dev/null || true
  rm -rf "$CONFIG_BACKUP"
  echo "{{TAG}} 已恢复 config 目录（用户数据已保留）"
fi

echo "{{TAG}} 清理临时文件..."
rm -rf "$TEMP_DIR"

{{FINISH_SECTION}}
`;

/** Windows 更新批处理（含大量 %VAR% 与 CRLF 要求，整体外置） */
export const APPLY_UPDATE_BAT_TEMPLATE = `@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

set "ROOT={{ROOT}}"
set "TEMP_DIR={{TEMP_DIR}}"
set "EXTRACTED_DIR={{EXTRACTED_DIR}}"
set "PIDS_FILE=%ROOT%\\.prod.pids.json"
set "CONFIG_DIR=%ROOT%\\config"
set "CONFIG_BACKUP="
set "LOG_FILE=%ROOT%\\update.log"

:: 将主逻辑输出重定向到日志文件，方便诊断更新失败原因
call :do_update >> "%LOG_FILE%" 2>&1
exit /b

:do_update
echo.
echo ========================================
echo [更新脚本] 开始执行 %date% %time%
echo ========================================

echo [更新脚本] 等待后端返回响应...
:: 使用 ping 替代 timeout：timeout 在非交互式/隐藏窗口下会报错
ping 127.0.0.1 -n 4 >nul

echo [更新脚本] 停止现有服务...
:: 停止单文件版本进程
:: 注意：不使用 /T 参数。/T 会杀掉整个进程树，包括执行本脚本的 cmd.exe
:: （cmd.exe 是 node.exe 的子进程），导致脚本在 taskkill 后中断。
:: 去掉 /T 后只杀指定名称的进程本身，cmd.exe 不受影响，脚本继续执行。
taskkill /F /IM zviewer-frontend.exe >nul 2>&1
taskkill /F /IM zviewer-backend.exe >nul 2>&1
taskkill /F /IM zviewer-cert.exe >nul 2>&1

:: 停止 Node.js 开发模式进程
if exist "%PIDS_FILE%" (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "\
    $pids = Get-Content '%PIDS_FILE%' -Raw | ConvertFrom-Json; \
    foreach ($key in $pids.PSObject.Properties.Name) { \
      $info = $pids.$key; \
      if ($info.pid) { \
        Stop-Process -Id $info.pid -Force -ErrorAction SilentlyContinue; \
      } \
    }"
  del "%PIDS_FILE%"
)
taskkill /F /IM node.exe >nul 2>&1

:: 等待端口释放（taskkill 后端口可能处于 TIME_WAIT 状态）
echo [更新脚本] 等待端口释放...
ping 127.0.0.1 -n 4 >nul

:: 备份 config 目录（包含数据库、用户上传文件、头像等全部用户数据）
echo [更新脚本] 备份 config 目录...
if exist "%CONFIG_DIR%" (
  set "BACKUP_NAME=.config-backup-!RANDOM!"
  set "CONFIG_BACKUP=%ROOT%\\!BACKUP_NAME!"
  xcopy /E /Y /I "%CONFIG_DIR%" "!CONFIG_BACKUP!" >nul
  if errorlevel 1 (
    echo [错误] config 目录备份失败
    exit /b 1
  )
  echo [更新脚本] 已备份 config 到 !BACKUP_NAME!
  rmdir /S /Q "%CONFIG_DIR%"
)

echo [更新脚本] 应用新文件...
if not exist "%EXTRACTED_DIR%" (
  echo [错误] 未找到解压目录：%EXTRACTED_DIR%
  if exist "!CONFIG_BACKUP!" (
    xcopy /E /Y /I "!CONFIG_BACKUP!" "%CONFIG_DIR%" >nul
  )
  exit /b 1
)

xcopy /E /Y /I "%EXTRACTED_DIR%\\*" "%ROOT%\\" >nul
if errorlevel 1 (
  echo [错误] 文件复制失败
  if exist "!CONFIG_BACKUP!" (
    xcopy /E /Y /I "!CONFIG_BACKUP!" "%CONFIG_DIR%" >nul
  )
  exit /b 1
)

:: 验证关键文件是否复制成功
if not exist "%ROOT%\\zviewer-backend.exe" (
  echo [错误] 更新后未找到 zviewer-backend.exe，更新包可能损坏
  if exist "!CONFIG_BACKUP!" (
    xcopy /E /Y /I "!CONFIG_BACKUP!" "%CONFIG_DIR%" >nul
  )
  exit /b 1
)

:: 恢复 config 目录（保留用户数据）
echo [更新脚本] 恢复 config 目录...
if exist "!CONFIG_BACKUP!" (
  if not exist "%CONFIG_DIR%" (
    mkdir "%CONFIG_DIR%"
  )
  xcopy /E /Y /I "!CONFIG_BACKUP!\\*" "%CONFIG_DIR%" >nul
  rmdir /S /Q "!CONFIG_BACKUP!"
  echo [更新脚本] 已恢复 config 目录（用户数据已保留）
) else (
  echo [更新脚本] 未检测到 config 备份（可能是首次部署），跳过恢复
)

echo [更新脚本] 清理临时文件...
rmdir /S /Q "%TEMP_DIR%"

echo [更新脚本] 重新启动服务...
:: 直接调用 powershell 执行 start.ps1，绕过 start.bat
:: start.bat 中如果 PowerShell 检查失败会执行 pause，在隐藏窗口下会无限等待
:: 直接调用 powershell -File start.ps1 start 可避免此问题
set "PS1=%ROOT%\\start.ps1"
if not exist "%PS1%" set "PS1=%ROOT%\\start-win.ps1"
if exist "%PS1%" (
  :: 使用 start /b 在后台启动 powershell，不创建可见窗口
  :: powershell 会异步启动后端和前端（Start-Process -WindowStyle Hidden），然后退出
  start "" /b powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" start
) else if exist "%ROOT%\\start.bat" (
  :: 回退到 start.bat start（传递 start 参数避免进入交互菜单）
  start "" /b "%ROOT%\\start.bat" start
) else (
  :: 最终回退：直接启动后端 exe，手动设置环境变量
  :: 统一端口：前后端共用同一端口（默认 3333），由后端托管前端静态文件
  echo [更新脚本] 未找到 start.ps1/start.bat，直接启动 exe
  if exist "%ROOT%\\.env" (
    for /f "usebackq tokens=1,* delims==" %%a in ("%ROOT%\\.env") do (
      if /i "%%a"=="PORT" set "PORT=%%b"
    )
  )
  if not defined PORT set "PORT=3333"
  set "NODE_ENV=production"
  set "HOST=::"
  start "" /D "%ROOT%" "%ROOT%\\zviewer-backend.exe"
)

echo [更新脚本] 更新完成，服务正在启动... %date% %time%
:: 先 exit 再 del：del 自身后脚本立即退出，exit 不会执行
:: 改为：先退出，由 cmd 在退出后自动释放文件句柄（无法自我删除）
:: 实际上 del "%~f0" 在 bat 中是可行的，因为脚本已被读入内存
exit /b 0`;

/** 按占位符注入变量；缺失变量立即报错，避免生成半成品脚本 */
export function renderTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  // 差异段自身可能含占位符（如 TAG），需多轮替换直到稳定
  let out = template;
  for (let round = 0; round < 4; round++) {
    if (!/\{\{\w+\}\}/.test(out)) break;
    out = out.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => {
      if (!(key in vars)) {
        throw new Error(`[updater] 脚本模板占位符未提供: ${key}`);
      }
      return vars[key];
    });
  }
  return out;
}

// ── Docker 差异段 ──
export const SH_STOP_DOCKER = `# ==================== 第 1 步：创建重启标记 ====================
# 先创建标记，确保后续 kill 后端时 entrypoint 能检测到并等待更新完成
touch "$RESTART_MARKER"
echo "{{TAG}} 已创建重启标记: $RESTART_MARKER"

# ==================== 第 2 步：终止后端进程 ====================
# 必须先终止后端，再复制文件。否则 cp -rf 会截断正在运行的二进制，
# 导致后端进程崩溃（SIGBUS/SIGSEGV），entrypoint 在标记创建前检测到退出，
# 误判为异常退出并停止容器。
echo "{{TAG}} 正在终止后端进程..."
BACKEND_PID=""
if [ -f "$ROOT/.backend.pid" ]; then
  BACKEND_PID=$(cat "$ROOT/.backend.pid" 2>/dev/null)
fi
if [ -z "$BACKEND_PID" ]; then
  BACKEND_PID=$(pgrep -f "zviewer-backend" 2>/dev/null | head -n 1)
fi
if [ -n "$BACKEND_PID" ]; then
  echo "{{TAG}} 终止后端进程 PID=$BACKEND_PID"
  # 先发 SIGTERM 触发 graceful shutdown（刷新数据库脏数据），
  # 等待最多 5 秒，仍未退出则 SIGKILL 强制终止
  kill -TERM "$BACKEND_PID" 2>/dev/null || true
  for i in 1 2 3 4 5; do
    if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
      break
    fi
    sleep 1
  done
  if kill -0 "$BACKEND_PID" 2>/dev/null; then
    echo "{{TAG}} 后端未响应 SIGTERM，强制终止"
    kill -9 "$BACKEND_PID" 2>/dev/null || true
  fi
  # 等待进程完全退出和端口释放
  sleep 2
else
  echo "{{TAG}} 未找到后端进程，可能已退出"
fi`;
export const SH_APPLY_DOCKER = `# 覆盖程序文件（后端已停止，不会截断运行中的二进制）
cp -f "$EXTRACTED_DIR/zviewer-backend" "$ROOT/zviewer-backend" 2>/dev/null || true
cp -f "$EXTRACTED_DIR/zviewer-cert" "$ROOT/zviewer-cert" 2>/dev/null || true
# LiveKit 伴生二进制：旧构建包可能不含（缺失时保留镜像内原文件/原状态）
if [ -f "$EXTRACTED_DIR/livekit-server" ]; then
  cp -f "$EXTRACTED_DIR/livekit-server" "$ROOT/livekit-server" 2>/dev/null || true
  chmod +x "$ROOT/livekit-server" 2>/dev/null || true
  echo "{{TAG}} livekit-server 已更新"
else
  echo "{{TAG}} 警告：更新包中未包含 livekit-server，语音二进制保持原状"
fi
cp -f "$EXTRACTED_DIR/start.sh" "$ROOT/start.sh" 2>/dev/null || true
cp -f "$EXTRACTED_DIR/package.json" "$ROOT/package.json" 2>/dev/null || true
cp -f "$EXTRACTED_DIR/.env" "$ROOT/.env" 2>/dev/null || true
# 前端静态文件
if [ -d "$EXTRACTED_DIR/frontend/dist" ]; then
  rm -rf "$ROOT/frontend/dist"
  mkdir -p "$ROOT/frontend/dist"
  cp -rf "$EXTRACTED_DIR/frontend/dist/"* "$ROOT/frontend/dist/" 2>/dev/null || true
fi
chmod +x "$ROOT/zviewer-backend" "$ROOT/zviewer-cert" 2>/dev/null || true`;
export const SH_FINISH_DOCKER = `echo "{{TAG}} 更新完成，entrypoint 将自动重启后端 $(date)"

# 删除自身
rm -f "$0"

exit 0`;

// ── Linux 差异段 ──
export const SH_STOP_LINUX = `echo "{{TAG}} 停止现有服务..."
# 使用 pgrep + 排除自身 PID，避免 pkill -f 匹配到执行本脚本的 bash 进程
# （当部署路径包含 "zviewer-backend" 时，bash 命令行会匹配 pkill 模式）
for pid in $(pgrep -f "zviewer-frontend" 2>/dev/null); do
  [ "$pid" != "$SELF_PID" ] && kill -9 "$pid" 2>/dev/null || true
done
for pid in $(pgrep -f "zviewer-backend" 2>/dev/null); do
  [ "$pid" != "$SELF_PID" ] && kill -9 "$pid" 2>/dev/null || true
done
for pid in $(pgrep -f "zviewer-cert" 2>/dev/null); do
  [ "$pid" != "$SELF_PID" ] && kill -9 "$pid" 2>/dev/null || true
done`;
export const SH_APPLY_LINUX = `cp -rf "$EXTRACTED_DIR/"* "$ROOT/" 2>/dev/null || true
chmod +x "$ROOT/zviewer-frontend" "$ROOT/zviewer-backend" "$ROOT/zviewer-cert" 2>/dev/null || true`;
export const SH_FINISH_LINUX = `echo "{{TAG}} 重新启动服务..."
# 关键：必须传递 start 参数！
# start.sh 无参数时默认进入交互菜单（read 等待输入），
# 而更新脚本在后台运行，用户无法看到菜单也无法输入，
# 导致服务永远无法启动，看起来像"文件没有替换"。
cd "$ROOT"
if [ -f "$ROOT/start.sh" ]; then
  nohup ./start.sh start > /dev/null 2>&1 &
else
  # 回退方案：start.sh 不存在时直接启动后端 exe，手动设置环境变量
  # 统一端口：前后端共用同一端口（默认 3333），由后端托管前端静态文件
  echo "{{TAG}} 未找到 start.sh，直接启动 exe"
  # 从 .env 读取端口（若存在），否则使用默认值
  ENV_PORT=""
  if [ -f "$ROOT/.env" ]; then
    ENV_PORT=$(grep -E '^PORT=' "$ROOT/.env" | head -n 1 | cut -d= -f2- | tr -d '"' | xargs)
  fi
  PORT="\${ENV_PORT:-3333}"
  PORT="$PORT" NODE_ENV=production HOST=:: \
    nohup "$ROOT/zviewer-backend" > /dev/null 2>&1 &
fi

echo "{{TAG}} 更新完成，服务正在启动... $(date)"
rm -f "$0"
exit 0`;
