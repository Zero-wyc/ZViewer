import { execSync, spawn } from 'child_process';
import fs from 'fs';
import https from 'https';
import path from 'path';
import { proxyGitHubUrl } from '../../utils/githubCdn';

const REPO_OWNER = 'Zero-wyc';
const REPO_NAME = 'ZViewer';
const BRANCH = 'main';

export interface UpdateInfo {
  currentVersion: string;
  remoteVersion: string;
  hasUpdate: boolean;
  commitMessage: string;
  commitUrl: string;
  publishedAt: string;
}

function projectRoot(): string {
  // backend/src/services/updater -> project root
  return path.resolve(__dirname, '..', '..', '..', '..');
}

function httpsGetJson<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': 'ZViewer-Updater',
          Accept: 'application/vnd.github+json',
        },
        timeout: 30_000,
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          httpsGetJson<T>(res.headers.location).then(resolve).catch(reject);
          return;
        }
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${url}`));
          return;
        }
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data) as T);
          } catch (err) {
            reject(new Error(`解析响应失败: ${String(err)}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('请求超时'));
    });
  });
}

function getLocalVersion(): string {
  const root = projectRoot();
  try {
    return execSync('git rev-parse HEAD', {
      cwd: root,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
    }).trim();
  } catch {
    try {
      const pkg = JSON.parse(
        fs.readFileSync(path.join(root, 'package.json'), 'utf8'),
      ) as { version?: string };
      return pkg.version || 'unknown';
    } catch {
      return 'unknown';
    }
  }
}

interface GithubCommit {
  sha: string;
  commit?: {
    message?: string;
    committer?: { date?: string };
  };
  html_url?: string;
}

export async function getUpdateInfo(): Promise<UpdateInfo> {
  const apiUrl = proxyGitHubUrl(
    `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/commits/${BRANCH}`,
  );
  const commit = await httpsGetJson<GithubCommit>(apiUrl);
  const remoteVersion = commit.sha || 'unknown';
  const currentVersion = getLocalVersion();

  return {
    currentVersion,
    remoteVersion,
    hasUpdate: remoteVersion !== currentVersion && remoteVersion !== 'unknown',
    commitMessage: commit.commit?.message || '',
    commitUrl: commit.html_url || '',
    publishedAt: commit.commit?.committer?.date || '',
  };
}

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const req = https.get(url, { timeout: 120_000 }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        downloadFile(res.headers.location, dest).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`下载失败 HTTP ${res.statusCode}: ${url}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => {
        file.close(() => resolve());
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('下载超时'));
    });
  });
}

function writeApplyUpdateBat(
  root: string,
  tempDir: string,
  extractedDir: string,
): string {
  const batPath = path.join(root, 'apply-update.bat');
  const content = `@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

set "ROOT=${root.replace(/\\/g, '\\\\')}"
set "TEMP_DIR=${tempDir.replace(/\\/g, '\\\\')}"
set "EXTRACTED_DIR=${extractedDir.replace(/\\/g, '\\\\')}"
set "PIDS_FILE=%ROOT%\\.prod.pids.json"

echo [更新脚本] 等待后端返回响应...
timeout /t 3 /nobreak >nul

echo [更新脚本] 停止现有服务...
if exist "%PIDS_FILE%" (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "\
    $pids = Get-Content '%PIDS_FILE%' -Raw | ConvertFrom-Json; \
    foreach ($key in $pids.PSObject.Properties.Name) { \
      $info = $pids.$key; \
      if ($info.pid) { \
        Stop-Process -Id $info.pid -Force -ErrorAction SilentlyContinue; \
        Write-Host ('已停止进程 PID: ' + $info.pid); \
      } \
    }"
  del "%PIDS_FILE%"
)

:: 额外尝试关闭占用端口的 node 进程
taskkill /F /IM node.exe /T >nul 2>&1

echo [更新脚本] 应用新文件...
if not exist "%EXTRACTED_DIR%" (
  echo [错误] 未找到解压目录：%EXTRACTED_DIR%
  pause
  exit /b 1
)

xcopy /E /Y /I "%EXTRACTED_DIR%\\*" "%ROOT%\\"
if errorlevel 1 (
  echo [错误] 文件复制失败
  pause
  exit /b 1
)

echo [更新脚本] 清理临时文件...
rmdir /S /Q "%TEMP_DIR%"

echo [更新脚本] 安装依赖并构建...
cd /d "%ROOT%"
call npm install
if errorlevel 1 (
  echo [错误] 依赖安装失败
  pause
  exit /b 1
)
call npm run build
if errorlevel 1 (
  echo [错误] 构建失败
  pause
  exit /b 1
)

echo [更新脚本] 重新启动服务...
start "" "%ROOT%\\start-prod.bat"

echo [更新脚本] 更新完成，服务正在启动...
exit
`;
  fs.writeFileSync(batPath, content, 'utf8');
  return batPath;
}

export async function applyUpdate(): Promise<{
  success: boolean;
  message: string;
}> {
  const root = projectRoot();
  const tempDir = path.join(root, '.update-temp');
  const zipPath = path.join(tempDir, 'update.zip');
  const extractedDir = path.join(tempDir, `${REPO_NAME}-${BRANCH}`);

  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const zipUrl = proxyGitHubUrl(
    `https://github.com/${REPO_OWNER}/${REPO_NAME}/archive/refs/heads/${BRANCH}.zip`,
  );

  try {
    await downloadFile(zipUrl, zipPath);

    // 使用 PowerShell 解压
    const psCmd = `Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${tempDir.replace(/'/g, "''")}' -Force`;
    execSync(`powershell -NoProfile -Command "${psCmd}"`, { cwd: root });

    if (!fs.existsSync(extractedDir)) {
      throw new Error(`解压后未找到目录: ${extractedDir}`);
    }

    const batPath = writeApplyUpdateBat(root, tempDir, extractedDir);

    //  detached 启动更新脚本，避免自身被终止
    spawn('cmd', ['/c', batPath], {
      cwd: root,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref();

    return {
      success: true,
      message: '更新已触发，后台将自动替换文件、重新构建并重启服务',
    };
  } catch (err) {
    // 清理临时文件
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {
      // ignore cleanup error
    }
    throw err;
  }
}
