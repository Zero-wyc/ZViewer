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
  /** HTTP 方法，默认 GET（仅 GET/POST） */
  method?: string;
  /** 请求体（POST 时使用，字符串原样发送） */
  body?: string;
  /** 请求体 Content-Type（POST 时使用） */
  contentType?: string;
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

/** 从 Content-Type 提取 charset 参数（无声明返回 null） */
function charsetFromContentType(contentType: string | undefined): string | null {
  if (!contentType) return null;
  const m = /charset\s*=\s*"?([\w-]+)"?/i.exec(contentType);
  return m ? m[1].toLowerCase() : null;
}

/**
 * 按字符集解码响应字节。
 *
 * 优先使用服务器声明的 charset；未声明时严格 UTF-8 解码嗅探，
 * 失败（含 BOM 外非法序列）回退 GB18030（GB2312/GBK 的超集，国内
 * TVBox 配置/CMS 站点常见编码）——Node fetch 的 res.text() 与 PS 5.1
 * Invoke-WebRequest 在 charset 缺失时分别默认 UTF-8/ISO-8859-1，
 * 都会产生中文乱码，此函数统一纠正。
 */
export function decodeBody(bytes: Uint8Array, contentType?: string): string {
  const declared = charsetFromContentType(contentType);
  if (declared && declared !== 'utf-8' && declared !== 'utf8') {
    try {
      return new TextDecoder(declared).decode(bytes);
    } catch {
      // 未识别的 charset 标签 → 继续嗅探
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder('gb18030').decode(bytes);
    } catch {
      return new TextDecoder('utf-8').decode(bytes);
    }
  }
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
  method?: string,
  body?: string,
  contentType?: string,
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
  const psMethod = (method || 'GET').toUpperCase();
  const bodyEscaped = body != null ? escapePsString(body) : '';
  const ctypeEscaped = escapePsString(contentType || '');

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
  if ('${psMethod}' -ne 'GET') { $params['Method'] = '${psMethod}' }
  $body = '${bodyEscaped}'
  if ($body) { $params['Body'] = $body }
  $ctype = '${ctypeEscaped}'
  if ($ctype) { $params['ContentType'] = $ctype }
  $r = Invoke-WebRequest @params
  Write-Output "__STATUS__:$($r.StatusCode)"
  $srv = $r.Headers['server']
  if ($srv) { Write-Output "__SERVER__:$srv" }
  $ray = $r.Headers['cf-ray']
  if ($ray) { Write-Output "__CFRAY__:$ray" }
  $ctype = $r.Headers['Content-Type']
  if ($ctype) { Write-Output "__CTYPE__:$ctype" }
  Write-Output "__BODY_START__"
  # 输出原始字节（base64）：PS 5.1 Invoke-WebRequest 对无 charset 的文本响应
  # 默认按 ISO-8859-1 解码会产生中文乱码，交由 Node 侧 decodeBody 统一解码
  $raw = $r.RawContentStream
  if ($raw) {
    Write-Output "__B64__"
    Write-Output ([Convert]::ToBase64String($raw.ToArray()))
  } else {
    Write-Output $r.Content
  }
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
        const ctypeMatch = stdout.match(/__CTYPE__:(.+)/);
        if (ctypeMatch) headers['content-type'] = ctypeMatch[1].trim();

        const errorMatch = stdout.match(/__ERROR__:(.+)/);
        const error = errorMatch ? errorMatch[1].trim() : undefined;

        const bodyStartIdx = stdout.indexOf('__BODY_START__');
        const bodyEndIdx = stdout.lastIndexOf('__BODY_END__');
        let body = '';
        if (bodyStartIdx !== -1 && bodyEndIdx !== -1 && bodyEndIdx > bodyStartIdx) {
          const rawBody = stdout
            .slice(bodyStartIdx + '__BODY_START__'.length, bodyEndIdx)
            .replace(/^\r?\n/, '')
            .replace(/\r?\n$/, '');
          if (rawBody.startsWith('__B64__')) {
            // 原始字节 base64 → 按 charset 智能解码
            const b64 = rawBody.slice('__B64__'.length).replace(/\s+/g, '');
            body = decodeBody(Buffer.from(b64, 'base64'), headers['content-type']);
          } else {
            body = rawBody;
          }
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
  const {
    headers = {},
    timeoutMs = 20000,
    method,
    body: reqBody,
    contentType: reqContentType,
  } = options;

  // 快速路径：Node.js fetch
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      method: method || 'GET',
      headers,
      body: method && method.toUpperCase() !== 'GET' ? reqBody : undefined,
      signal: controller.signal,
    });
    clearTimeout(timer);
    // 字节级获取 + 智能解码：res.text() 在 charset 缺失时按 UTF-8 硬解，
    // GBK 编码的 TVBox 配置/CMS 页面会中文乱码
    const buf = await res.arrayBuffer();
    const body = decodeBody(new Uint8Array(buf), res.headers.get('content-type') ?? undefined);

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
    return fetchViaPowerShell(url, headers, timeoutMs, method, reqBody, reqContentType);
  }
}
