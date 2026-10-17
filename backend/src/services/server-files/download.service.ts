/**
 * 通用流式下载器（服务器文件域）。
 *
 * 用于「下载远端直链到服务器磁盘」的场景（如 B站 视频下载）：
 * - 下载失败时自动清理不完整的文件
 * - 进度回调节流：每 2% 或 512KB 触发一次，避免过度回调
 */
import fs, { createWriteStream } from 'node:fs';

/**
 * 流式下载文件到本地路径。
 *
 * @returns 文件大小（字节）
 */
export async function downloadToFile(
  url: string,
  filePath: string,
  headers?: Record<string, string>,
  onProgress?: (received: number, total: number, percent: number) => void,
): Promise<number> {
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error(`下载失败：HTTP ${res.status} ${res.statusText}`);
  }

  const total = Number(res.headers.get('content-length') || '0');
  let received = 0;
  let lastPercent = 0;

  const fileStream = createWriteStream(filePath);
  const reader = res.body.getReader();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        fileStream.write(Buffer.from(value));
        received += value.length;
        const percent = total > 0 ? Math.floor((received / total) * 100) : 0;
        if (
          percent >= lastPercent + 2 ||
          (total === 0 && received % (512 * 1024) === 0)
        ) {
          lastPercent = percent;
          onProgress?.(received, total, percent);
        }
      }
    }

    await new Promise<void>((resolve, reject) => {
      fileStream.end((err?: Error) => (err ? reject(err) : resolve()));
    });
  } catch (err) {
    // 下载失败时清理不完整的文件
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* ignore */
    }
    throw err;
  }

  return received;
}
