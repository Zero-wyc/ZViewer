/**
 * B站 视频下载到服务器（NDJSON 流式进度）。
 *
 * 仅 MP4 单文件直链模式（最高 720P）。高画质（DASH 分离流需服务器
 * FFmpeg 合并）已随服务器端 FFmpeg 一并移除，请使用 CLI 模式下载高画质。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../../middleware/auth';
import { getCredential } from '../bilibili/credential';
import { VIP_ONLY_QNS } from '../bilibili/permission';
import {
  expandBilibiliShortLink,
  extractBvid,
  normalizeResolveError,
  resolveBilibiliVideo,
  type ResolveProgress,
} from '../bilibili/resolver';
import {
  loadRootRegistry,
  resolveSafePath,
  toPrefixedPath,
} from './pathResolver';
import { downloadToFile } from './download.service';
import { uniqueFilename } from './upload';

/**
 * POST /bilibili-download — 解析 B站 视频并下载到服务器指定目录。
 *
 * 采用 NDJSON 流式响应，实时推送解析、下载进度：
 *   { status: 'parsing', step, message }
 *   { status: 'downloading', phase: 'video', received, total, percent }
 *   { status: 'done', file: { name, path, size } }
 *   { status: 'error', message, code }
 */
export async function handleBilibiliDownload(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  const rawUrl = typeof req.body.url === 'string' ? req.body.url.trim() : '';
  // 短链展开：b23.tv 等分享短链先 302 展开为完整视频地址再校验/解析
  const url = await expandBilibiliShortLink(rawUrl);
  const targetDir =
    typeof req.body.targetDir === 'string' ? req.body.targetDir.trim() : '';
  const filename =
    typeof req.body.filename === 'string' ? req.body.filename.trim() : '';
  const qn =
    typeof req.body.qn === 'number' && Number.isFinite(req.body.qn)
      ? req.body.qn
      : undefined;
  const page =
    typeof req.body.page === 'number' && Number.isFinite(req.body.page)
      ? req.body.page
      : undefined;
  const userId = req.user?.userId;

  if (!url) {
    res.status(400).json({ success: false, message: '缺少视频链接或 BV 号' });
    return;
  }
  if (!extractBvid(url)) {
    res.status(400).json({ success: false, message: '无法解析 B站 BV 号' });
    return;
  }
  if (!targetDir) {
    res.status(400).json({ success: false, message: '缺少目标目录' });
    return;
  }

  // NDJSON 流式响应
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'close');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Transfer-Encoding', 'chunked');

  const send = (payload: Record<string, unknown>): void => {
    res.write(JSON.stringify(payload) + '\n');
    const flushable = res as unknown as { flush?: () => void };
    if (typeof flushable.flush === 'function') flushable.flush();
  };
  const fail = (message: string, code?: string): void => {
    send({ success: false, status: 'error', message, code });
    res.end();
  };

  try {
    // 1. 解析目标目录
    const roots = await loadRootRegistry();
    const { abs: dirAbs, root } = resolveSafePath(targetDir, roots);
    if (root.readonly) {
      fail('该根目录为只读');
      return;
    }
    if (!fs.existsSync(dirAbs)) {
      fs.mkdirSync(dirAbs, { recursive: true });
    }

    // 2. 获取用户 B站 Cookie
    const cookie =
      userId !== undefined
        ? ((await getCredential(String(userId)))?.cookie ?? undefined)
        : undefined;

    // 3. 解析 B站 视频（按模式选择 preferMp4，下载场景跳过 CDN 健康检查）
    send({ status: 'parsing', step: 'resolve', message: '正在解析视频地址...' });
    const result = await resolveBilibiliVideo({
      url,
      userId: userId !== undefined ? String(userId) : undefined,
      cookie,
      qn,
      preferMp4: true,
      page,
      // 下载场景跳过 CDN HEAD 健康检查（3.5s 超时），
      // 下载本身即连接验证，失败时由 backupUrl 重试
      skipCdnCheck: true,
      onProgress: (msg: ResolveProgress) => {
        send({ status: 'parsing', step: msg.step, message: msg.message });
      },
    });

    if (!result.videoUrl) {
      fail('解析失败：未获取到视频直链');
      return;
    }

    // 3.5 VIP 权限校验：非大会员账号不允许下载 VIP 专属清晰度
    // 后端 filterQualitiesByVip 已经过滤，这里作为强校验防止前端绕过
    if (qn && VIP_ONLY_QNS.includes(qn) && result.vipStatus !== 1) {
      fail(
        '该清晰度需要大会员账号，请先在个人中心绑定大会员账号后重试，或选择 1080P 及以下清晰度',
        'VIP_REQUIRED',
      );
      return;
    }

    // 4. 确定文件名
    const title = (
      filename ||
      result.title ||
      `bilibili_${Date.now()}`
    ).replace(/[\\/:*?"<>|]/g, '_');
    const finalName = uniqueFilename(dirAbs, `${title}.mp4`);
    const targetPath = path.join(dirAbs, finalName);

    // 通用下载头（防盗链）
    const downloadHeaders = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Referer: 'https://www.bilibili.com',
      Origin: 'https://www.bilibili.com',
      ...(cookie ? { Cookie: cookie } : {}),
    };

    // MP4 单文件直接下载
    send({
      status: 'downloading',
      phase: 'video',
      message: '开始下载...',
      received: 0,
      total: 0,
      percent: 0,
    });

    try {
      await downloadToFile(
        result.videoUrl,
        targetPath,
        downloadHeaders,
        (received, total, percent) => {
          send({ status: 'downloading', phase: 'video', received, total, percent });
        },
      );
    } catch (err) {
      try {
        fs.unlinkSync(targetPath);
      } catch {
        /* ignore */
      }
      fail(`下载失败：${err instanceof Error ? err.message : '写入文件失败'}`);
      return;
    }

    // 5. 完成
    const size = fs.statSync(targetPath).size;
    send({
      success: true,
      status: 'done',
      file: {
        name: finalName,
        path: toPrefixedPath(root, targetPath),
        size,
      },
    });
    res.end();
  } catch (err) {
    console.error('[server-files] bilibili-download error:', err);
    const normalized = normalizeResolveError(err);
    fail(normalized.message, normalized.code);
  }
}
