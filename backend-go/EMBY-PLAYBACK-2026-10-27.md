# Emby / Jellyfin 播放与影片级模式切换（2026-10-27）

基线：上游 main `9e62237`。仅修改本地服务端源码与网页前端。未更改远端部署、账号、挂载或房间设置；未连接 NAS SSH。真实服务测试使用用户已登录会话进行浏览、解析与有限媒体读取，未将账号、令牌、签名地址或原始日志加入仓库。

## 现场与历史日志

- 用户提供的历史 CSV 共 513 条记录，其中 Emby/Jellyfin 相关记录中，挂载 1 的浏览 21 次、解析 7 次、影片版本解析 25 次均为 200。4 次上游 403 对应挂载 2 的浏览，不能用来解释挂载 1 当前的播放故障。该日志没有对应的 stream/proxy 请求记录，不能单靠它判断播放链路。
- 本次现场片源默认版本为 MKV、H.264 视频与 DTS 音轨。上游用户策略禁止音频转码、视频转码、重封装，PlaybackInfo 明确返回 `SupportsTranscoding=false`。
- 原实现只按 DTS 判断需要音频转码，强制返回 `format=hls`、`main.m3u8`。实际入口将该地址 302 到 MKV 文件，浏览器按 HLS 加载必然失败。
- 浏览器直接 fetch Emby 播放入口失败，而对最终 CDN 地址的相同 Range 请求成功（206）。该跳转入口未通过浏览器跨域检查，不能只凭最终 CDN 允许 CORS 就假定整条跳转链可读。
- 远端 ZViewer 的 stream/proxy 返回 302、Content-Length 0、无 Location。当前基线的统一代理已经实现逐跳跟随重定向，本地相同上游取流与受控回归均正常。未取得远端运行二进制或运行环境证据，不能断言其具体部署版本或确定其为何仍返回空 302；本轮未修改远端部署。

## 修改

1. 保留上游 `SupportsTranscoding` 的缺省/false 区别。明确禁止转码时保留原容器格式；需要转码但被禁用时返回 `audioTranscodeDisabled=true`，供浏览器引擎处理 MKV/DTS。缺省字段继续兼容原有行为。
2. 禁止转码时输出显式 `at=0`。stream 接口仅在未给出 at 时采用旧影片 format=hls 的回退，避免历史 HLS 记录重新触发被禁止的上游转码。
3. Emby/Jellyfin 起播时按 movieId 刷新播放信息和令牌，并保留 ms/MediaSourceId。已存为 HLS 的历史记录可在起播解析时恢复原格式。
4. 仅在直连起播且使用原文件时解析最终跳转地址。优先 HEAD，405/501 时退为单字节 Range GET，只取响应头即关闭；整体超时 10 秒。复用统一代理的逐跳目标策略及跨域凭证移除逻辑。媒体内容仍由浏览器直接读取 CDN。
5. 最终签名地址仅作为临时 `resolvedDirectUrl` 返回。影片记录保留包含条目/版本身份的原始直连地址，不用短期 CDN 地址覆盖 movie.url，以便下次刷新和切回中转时仍保留版本。
6. 影片「播放设置」复用浏览器转码的 SwitchCard，增加 Emby/Jellyfin 的服务器中转开关。沿用地址范围判断：内网挂载隐藏，其余均显示，不增加 HTTPS、CORS、连通性或账号能力等显示条件。Emby/Jellyfin 切换写入 directLink 与对应 URL，不误用数据源的 serverProxy 字段。

## 验证

- `npm run test:media`：17 项通过，覆盖内网隐藏、公网 HTTP/HTTPS 与不可达域名仍显示、两类协议、版本保留、历史 HLS 解析恢复、直连 CDN 地址与中转策略。
- `go test ./internal/api ./internal/emby ./internal/proxy`：通过。包含 Emby/Jellyfin 禁止转码、旧 HLS + at=0、版本参数、302 到原文件的完整 API 链路；HEAD 不可用的单字节 GET 回退、跨源凭证移除。
- `npm run build:frontend` 与 `npm run build:backend`：通过。前端仍有现存 vendor 动态导入、dashjs ESM 与大包提示。
- 本地独立数据库/测试实例对同一真实众筹服片源验证：原文件 Range 0–63 返回 206，64 字节，MKV 魔数 `1a45dfa3`；中转与修复后的直连均实际解码为 1920×1080，video.readyState=4，时间推进，无播放错误。
- 直连连续播放观测到 115 秒、2753 帧；浏览器实际解码画面可见。通过本地临时影片卡验证：内网 Emby 保留浏览器转码卡并隐藏中转切换，公网 HTTP Jellyfin 同时显示两张开关卡。临时影片卡在验证后移除。
- 真实播放验证针对 Emby 上游；Jellyfin 使用共用协议实现及受控 API/前端回归，未声称在独立真实 Jellyfin 服务上完成实机播放。

本轮先本地提交，等待用户验收后再提交 PR。
