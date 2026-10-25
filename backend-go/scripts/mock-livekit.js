#!/usr/bin/env node
/**
 * 假 LiveKit 服务（只实现语音用到的 4 个 Twirp 方法）。
 *
 * 为什么需要它：语音端点本身不发音频，只做「签 token」与「调 LiveKit 管理接口」。
 * 真 LiveKit 需要容器 + API Key，且参与者列表随真实连接变化——对拍无法稳定。
 * 这个假站把 Twirp 响应固定下来，并记录收到的调用序列，供两侧比较。
 *
 * 路径与请求体形状与 livekit-server-sdk 的 TwirpRPC 一致：
 *   POST /twirp/livekit.RoomService/<Method>，JSON 体，camelCase 字段。
 *
 * 额外控制面：
 *   GET  /__calls  取已记录的调用（并在返回后清空，天然按步骤隔离）
 *   POST /__reset  清空调用记录
 *
 * 用法：node mock-livekit.js <port>
 */
'use strict';

const http = require('node:http');

const PORT = Number(process.argv[2] || 13336);

/** 固定参与者：user:1（房主）、user:2（观众），各带一条音频轨与一条视频轨。 */
const PARTICIPANTS = [
  {
    identity: 'user:1',
    tracks: [
      { sid: 'TR_AUDIO_1', type: 'AUDIO' },
      { sid: 'TR_VIDEO_1', type: 'VIDEO' },
    ],
  },
  {
    identity: 'user:2',
    tracks: [{ sid: 'TR_AUDIO_2', type: 'AUDIO' }],
  },
];

/** @type {Array<Record<string, unknown>>} */
let calls = [];

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (url.pathname === '/__calls') {
    const snapshot = calls;
    calls = [];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ calls: snapshot }));
    return;
  }
  if (url.pathname === '/__reset') {
    calls = [];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }

  const prefix = '/twirp/livekit.RoomService/';
  if (!url.pathname.startsWith(prefix)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 'bad_route', msg: `unknown path ${url.pathname}` }));
    return;
  }

  const method = url.pathname.slice(prefix.length);
  const body = await readBody(req);

  // 鉴权头也记下来：两侧都必须带 Bearer JWT（admin token）
  const auth = req.headers.authorization || '';
  calls.push({
    method,
    room: body.room,
    identity: body.identity,
    trackSid: body.trackSid,
    muted: body.muted,
    metadata: body.metadata,
    hasBearer: /^Bearer\s+\S+/.test(auth),
  });

  res.writeHead(200, { 'Content-Type': 'application/json' });
  switch (method) {
    case 'ListParticipants':
      res.end(JSON.stringify({ participants: PARTICIPANTS }));
      return;
    case 'MutePublishedTrack':
    case 'RemoveParticipant':
      res.end('{}');
      return;
    case 'UpdateParticipant':
      res.end(JSON.stringify({ participant: PARTICIPANTS[0] }));
      return;
    default:
      res.end('{}');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock-livekit] listening on 127.0.0.1:${PORT}`);
});
