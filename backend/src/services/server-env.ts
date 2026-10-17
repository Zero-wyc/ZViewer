/**
 * 服务运行环境配置（端口 / 监听地址 / CORS / 进程元信息）。
 *
 * 从根 index.ts 抽出，使入口文件只负责装配；本模块只读 process.env，无副作用。
 */

/** HTTP(S) 监听端口 */
export const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3333;

// 默认不指定 host，让 Node 同时监听 IPv4 与 IPv6（双栈），避免 Windows 上 '::' 无法接收 IPv4 连接的问题。
export const HOST = process.env.HOST || undefined;

// 进程启动时间戳与重启次数（由 supervisor 通过 RESTART_COUNT 环境变量传入）。
// 前端通过 /health 对比 startedAt 判断后端是否已自动重启，并在网页内提示。
export const PROCESS_STARTED_AT = Date.now();
export const RESTART_COUNT = parseInt(process.env.RESTART_COUNT || '0', 10);

function parseCorsOrigin(
  value: string | undefined,
): boolean | string | string[] {
  if (value) {
    if (value === 'false') return false;
    // 注意：CORS 规范要求 credentials: true 时 origin 不能为 '*'，需要返回 true 让 socket.io/express 反射请求 Origin
    if (value === '*') return true;
    return value.split(',').map((s) => s.trim());
  }
  // 默认允许所有来源（反射 Origin），兼容 localhost / 127.0.0.1 / 内网 IP / 公网域名访问。
  // 公网部署时建议显式设置 CORS_ORIGIN 为具体域名，避免开放跨域。
  return true;
}

export const CORS_ORIGIN = parseCorsOrigin(process.env.CORS_ORIGIN);

/** 是否以 HTTPS 模式启动（自签证书，见 scripts/generate-cert.js） */
export const USE_HTTPS = process.env.HTTPS === 'true';
