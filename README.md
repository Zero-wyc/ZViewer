# ZViewer

> 多人一起观影、听歌、语音聊天和屏幕分享平台。

**[English](README.en.md)** | 中文

<p align="left">
  <a href="LICENSE">
    <img src="https://img.shields.io/github/license/Zero-wyc/ZViewer?style=flat-square&logo=github&label=LICENSE&labelColor=333&color=blue" alt="MIT">
  </a>
  <img src="https://img.shields.io/github/stars/Zero-wyc/ZViewer?style=flat-square&logo=github&label=Stars&labelColor=333&color=blue" alt="Stars">
  <a href="https://github.com/Zero-wyc/ZViewer/releases">
    <img src="https://img.shields.io/github/v/release/Zero-wyc/ZViewer?style=flat-square&logo=github&label=RELEASE&labelColor=333&color=green" alt="Release">
  </a>
  <img src="https://img.shields.io/github/contributors/Zero-wyc/ZViewer?style=flat-square&logo=github&label=Contributors&labelColor=333&color=brightgreen" alt="Contributors">
  <img src="https://img.shields.io/github/repo-size/Zero-wyc/ZViewer?style=flat-square&logo=github&label=Size&labelColor=333&color=yellow" alt="Repo Size">
  <img src="https://img.shields.io/github/last-commit/Zero-wyc/ZViewer?style=flat-square&logo=github&label=Last%20Commit&labelColor=inactive" alt="Last Commit">
  <img src="https://img.shields.io/github/languages/top/Zero-wyc/ZViewer?style=flat-square&logo=typescript&labelColor=333&color=3178C6" alt="Top Language">
  <a href="https://t.me/Zero_251">
    <img src="https://img.shields.io/badge/Telegram-26A5E4?style=flat-square&logo=telegram&logoColor=white" alt="Telegram">
  </a>
</p>

| ![](https://raw.githubusercontent.com/Zero-wyc/Image/main/All/20261003200919255.webp) | ![](https://raw.githubusercontent.com/Zero-wyc/Image/main/All/20261003200942428.webp) |
| ------------------------------------------------------------ | ------------------------------------------------------------ |
| ![](https://raw.githubusercontent.com/Zero-wyc/Image/main/All/20261003200643035.webp) | ![](https://raw.githubusercontent.com/Zero-wyc/Image/main/All/20261003200707122.webp) |
| ![](https://raw.githubusercontent.com/Zero-wyc/Image/main/All/20260930211758831.webp) | ![](https://raw.githubusercontent.com/Zero-wyc/Image/main/All/20261003201053941.webp) |
| ![](https://raw.githubusercontent.com/Zero-wyc/Image/main/All/20261003200715093.webp) | ![](https://raw.githubusercontent.com/Zero-wyc/Image/main/All/20261003201139524.webp) |

## 社区

[Telegram](https://t.me/Zero_251)　|　[QQ 群](https://qm.qq.com/q/MuKPRVz8wc)

## Star History

<a href="https://star-history.com/#Zero-wyc/ZViewer&Zero-wyc/ZViewerCLI&Zero-wyc/ZViewerAPP&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=Zero-wyc/ZViewer,Zero-wyc/ZViewerCLI,Zero-wyc/ZViewerAPP&type=Date&theme=dark&v=2" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=Zero-wyc/ZViewer,Zero-wyc/ZViewerCLI,Zero-wyc/ZViewerAPP&type=Date&v=2" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=Zero-wyc/ZViewer,Zero-wyc/ZViewerCLI,Zero-wyc/ZViewerAPP&type=Date&v=2" />
 </picture>
</a>

## 功能

- **同步观影**：多人同步播放，房主控播，观众可申请暂停 / 快进；支持弹幕与多轨字幕
- **片源**：Bilibili（含大会员画质）、MP4 直链、WebDAV / FTP / OpenList、Emby / Jellyfin、服务器本地目录；支持 MKV / AVI / TS / WMV 与 DTS / AC3 / EAC3 音轨
- **一起听**：网易云音乐 × 哔哩哔哩，歌单自动补位，双收藏夹一键收藏
- **语音**：内嵌 LiveKit，无需额外部署；附带 WebRTC 屏幕共享
- **推流**：房间内 RTMP 接收与低延迟分发
- **高画质代理**：配合 [ZViewerCLI](https://github.com/Zero-wyc/ZViewerCLI) 使用房主 B 站 Cookie 取流，全房间共享大会员画质，服务器几乎不占带宽
- **桌面端**：Windows 原生壳，托管后端与全部网络入口，支持 IPv6 / FRP / EasyTier / Cloudflare Tunnel 外网接入
- **界面**：Material You，自定义背景与玻璃拟态

浏览器要求 Chrome / Edge 130+；Safari 与 Firefox 对 MSE / MKV 支持不完整。

## 部署

| 平台 | 下载 | 启动 |
| --- | --- | --- |
| Windows 桌面版（推荐） | [zviewer-windows-x64-GUI.zip](https://github.com/Zero-wyc/ZViewer/releases/download/latest/zviewer-windows-x64-GUI.zip) | 运行 `ZViewerDesktop.exe` |
| Windows 单文件 | [zviewer-windows-x64.zip](https://github.com/Zero-wyc/ZViewer/releases/download/latest/zviewer-windows-x64.zip) | 运行 `start.bat` |
| Linux | [zviewer-linux-x64.tar.gz](https://github.com/Zero-wyc/ZViewer/releases/download/latest/zviewer-linux-x64.tar.gz) | 运行 `./start.sh` |

```bash
docker run -d --name zviewer --restart unless-stopped \
  -p 3333:3333 -p 3333:3333/udp -p 3334:3334 -p 3337:3337 -p 3338:3338 \
  -v zviewer-data:/app/config \
  zerowyc0721/zviewer:latest
```

镜像标签：`latest` 与 `X.Y` 随 `vX.Y.Z` 更新，`X.Y.Z` 固定，`dev` 跟随 main。默认管理员 `root` / `root`。

- 容器内仅提供 HTTP，HTTPS 由 Cloudflare / ESA / EdgeOne 或宝塔 / 1Panel 反代至 3333
- 数据位于 `/app/config`（数据库、证书、上传文件）
- v4.3.6 之前部署的 Docker 版本不支持面板一键更新，需重新创建容器

## 端口

| 端口 | 用途 | 是否对外开放 |
| --- | --- | --- |
| 3333/tcp | HTTP/HTTPS、WebSocket、页面、语音信令反代 | 是 |
| 3333/udp | LiveKit 语音媒体 | 是 |
| 3337/tcp | 语音 ICE/TCP 直连（UDP 受限时自动回退） | 是 |
| 3334/tcp | OBS RTMP 推流 | 推流时 |
| 3338/tcp | 语音 TURN/TLS 中继 | 配置证书后 |
| 3335/tcp | HTTP-FLV 拉流（内部） | 否 |
| 3336/tcp | LiveKit 信令（内部） | 否 |

主要环境变量：

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `PORT` | 后端端口 | `3333` |
| `HOST` | 监听地址 | 双栈 |
| `CONFIG_DIR` | 数据根目录 | `<项目根>/config` |
| `CORS_ORIGIN` | 允许来源，逗号分隔 | `*` |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | 登录密钥 | 自动生成 |
| `LIVEKIT_EXTERNAL` | `1` 使用外置 LiveKit | `0` |
| `LIVEKIT_NODE_IP` | 语音 ICE 广播的公网 IP | 自动 |
| `LIVEKIT_RTC_TCP_PORT` | 语音 ICE/TCP 端口，`0` 关闭 | `3337` |
| `LIVEKIT_TURN_DOMAIN` / `LIVEKIT_TURN_CERT` / `LIVEKIT_TURN_KEY` | TURN/TLS 三项，配齐启用 3338 | — |

其余变量（推流、Emby 标识等）见 `backend-go/internal/config`。

## 语音与推流

语音由内嵌 LiveKit 提供，浏览器自动选择连接方式：UDP 直连 → TCP 直连 → TURN 中继。进房成功但无声音，通常为 UDP 被代理或防火墙拦截。

推流与一起听无需额外服务：OBS 推流地址为 `rtmp://<地址>:3334/live`，推流码见房间页。

## 桌面端

`ZViewerDesktop.exe` 为 Go + WebView2 原生壳（Wails v2，无 Electron），业务逻辑在网页端，壳负责进程托管与网络接入：

- 一键启停后端 / LiveKit / ZViewerCLI，关窗驻留托盘，单实例运行
- 外网接入：IPv6 直连、服务商 FRP、自建 FRP、EasyTier 组网、Cloudflare Tunnel
- 语音的 LiveKit 随包内置；cloudflared / frpc / EasyTier 按需下载，安装包不内置
- 自动更新：每 6 小时检查，流式下载 + 结构校验 + 覆盖重启

整个目录可直接迁移，无需安装。

## 开发

技术栈：前端 React 18 + Vite，后端 Go（SQLite），桌面壳 Wails v2。`backend-go/` 与 `desktop/` 为两个独立 Go module。

```bash
npm install && npm run db:init   # 初始化
npm run dev                      # 开发
npm run build && npm start       # 构建 + 运行
npm run lint:go && npm run test:go && npm test -w frontend   # 检查
```

要求 Go 1.26+、Node.js 22+。发布通过 `.github/workflows/build.yml` 手动触发，填入 `vX.Y.Z` 产出正式版。

## 文档

| 内容 | 位置 |
| --- | --- |
| 完整使用文档（部署、配置、环境变量） | [docx.zviewer.zero251.xyz](https://docx.zviewer.zero251.xyz) |
| 云隧道实现 | [desktop/IMPLEMENTATION-CLOUDFLARE-TUNNEL.md](desktop/IMPLEMENTATION-CLOUDFLARE-TUNNEL.md) |
| 高画质代理 CLI | [ZViewerCLI](https://github.com/Zero-wyc/ZViewerCLI) |
| 手机端（开发中） | [ZViewerAPP](https://github.com/Zero-wyc/ZViewerAPP) |
