/**
 * 通用 HTTP 文本获取客户端
 *
 * 大量动漫网站使用 TLS 指纹检测拦截 Node.js 的请求（ECONNRESET/超时），
 * 而 PowerShell/.NET 的 TLS 实现能通过这些检测。
 *
 * 策略：先尝试 Node.js fetch（快速路径），失败后用 PowerShell 子进程 fallback。
 */

import { execFile } from 'child_process';

export interface FetchTextOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface FetchTextResult {
  status: number;
  body: string;
  ok: boolean;
  /** 关键响应头（server, cf-ray 等），用于 Cloudflare 检测 */
  headers: Record<string, string>;
  /** 错误信息（PowerShell 请求失败时） */
  error?: string;
}

/** 转义 PowerShell 单引号字符串 */
function escapePsString(s: string): string {
  return s.replace(/'/g, "''");
}

/**
 * 通过 PowerShell 子进程获取 URL 内容。
 * .NET 的 HttpClient/WebRequest 使用 Schannel，TLS 指纹与浏览器不同，
 * 能通过 Cloudflare 等基于 TLS 指纹的反爬检测。
 */
function fetchViaPowerShell(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<FetchTextResult> {
  // PowerShell 5.1 不允许在 -Headers 中设置 User-Agent，需用 -UserAgent 参数
  const userAgent = headers['User-Agent'] || headers['user-agent'] || '';
  // 移除 Accept-Encoding，PowerShell 自动处理解压（不支持 br）
  const filteredHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if (
      lower === 'user-agent' ||
      lower === 'accept-encoding' ||
      lower === 'content-length'
    )
      continue;
    filteredHeaders[k] = v;
  }

  const headerLines = Object.entries(filteredHeaders)
    .map(([k, v]) => `  '${escapePsString(k)}' = '${escapePsString(v)}'`)
    .join('\n');

  const psSeconds = Math.ceil(timeoutMs / 1000);
  const uaEscaped = escapePsString(userAgent);

  // PowerShell 脚本：用 Invoke-WebRequest 获取内容，通过标记分隔输出
  const script = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ProgressPreference = 'SilentlyContinue'
$url = '${escapePsString(url)}'
$ua = '${uaEscaped}'
$headers = @{
${headerLines}
}
try {
  $params = @{ Uri = $url; Headers = $headers; UseBasicParsing = $true; TimeoutSec = ${psSeconds} }
  if ($ua) { $params['UserAgent'] = $ua }
  $r = Invoke-WebRequest @params
  Write-Output "__STATUS__:$($r.StatusCode)"
  $srv = $r.Headers['server']
  if ($srv) { Write-Output "__SERVER__:$srv" }
  $ray = $r.Headers['cf-ray']
  if ($ray) { Write-Output "__CFRAY__:$ray" }
  Write-Output "__BODY_START__"
  Write-Output $r.Content
  Write-Output "__BODY_END__"
} catch {
  $code = 0
  if ($_.Exception.Response) {
    $code = [int]$_.Exception.Response.StatusCode
    $srv = $_.Exception.Response.Headers['server']
    if ($srv) { Write-Output "__SERVER__:$srv" }
  }
  Write-Output "__STATUS__:$code"
  $msg = ($_.Exception.Message -replace '\\r?\\n', ' ').Substring(0, [Math]::Min(200, $_.Exception.Message.Length))
  Write-Output "__ERROR__:$msg"
  Write-Output "__BODY_END__"
}
`.trim();

  return new Promise((resolve) => {
    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        maxBuffer: 20 * 1024 * 1024,
        timeout: timeoutMs + 15000,
        encoding: 'utf8',
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        // 即使 err（超时等），stdout 可能已有部分输出
        if (!stdout) {
          resolve({
            status: 0,
            body: '',
            ok: false,
            headers: {},
            error: err?.message || 'PowerShell 执行失败',
          });
          return;
        }

        const statusMatch = stdout.match(/__STATUS__:(\d+)/);
        const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;

        const headers: Record<string, string> = {};
        const serverMatch = stdout.match(/__SERVER__:(.+)/);
        if (serverMatch) headers['server'] = serverMatch[1].trim();
        const cfRayMatch = stdout.match(/__CFRAY__:(.+)/);
        if (cfRayMatch) headers['cf-ray'] = cfRayMatch[1].trim();

        const errorMatch = stdout.match(/__ERROR__:(.+)/);
        const error = errorMatch ? errorMatch[1].trim() : undefined;

        const bodyStartIdx = stdout.indexOf('__BODY_START__');
        const bodyEndIdx = stdout.lastIndexOf('__BODY_END__');
        let body = '';
        if (bodyStartIdx !== -1 && bodyEndIdx !== -1 && bodyEndIdx > bodyStartIdx) {
          body = stdout
            .slice(bodyStartIdx + '__BODY_START__'.length, bodyEndIdx)
            .replace(/^\r?\n/, '')
            .replace(/\r?\n$/, '');
        }

        resolve({
          status,
          body,
          ok: status >= 200 && status < 300,
          headers,
          error,
        });
      },
    );
  });
}

/**
 * 获取 URL 文本内容。
 * 先尝试 Node.js fetch，失败后用 PowerShell 子进程 fallback。
 */
export async function fetchText(
  url: string,
  options: FetchTextOptions = {},
): Promise<FetchTextResult> {
  const { headers = {}, timeoutMs = 20000 } = options;

  // 快速路径：Node.js fetch
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      headers,
      signal: controller.signal,
    });
    clearTimeout(timer);
    const body = await res.text();

    // 提取关键响应头
    const responseHeaders: Record<string, string> = {};
    const server = res.headers.get('server');
    if (server) responseHeaders['server'] = server;
    const cfRay = res.headers.get('cf-ray');
    if (cfRay) responseHeaders['cf-ray'] = cfRay;

    return {
      status: res.status,
      body,
      ok: res.ok,
      headers: responseHeaders,
    };
  } catch {
    // fetch 失败（TLS 指纹拦截/超时/网络错误），使用 PowerShell fallback
    return fetchViaPowerShell(url, headers, timeoutMs);
  }
}
