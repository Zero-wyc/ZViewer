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

- **同步观影**：多人同步播放，房主控制播放，观众可申请暂停 / 快进；支持多轨弹幕与字幕
- **片源**：Bilibili（支持大会员画质）、MP4 直链、WebDAV / FTP / OpenList、Emby / Jellyfin、ANI、Kazumi、TVBOX、服务器本地目录；支持 MKV / AVI / TS / WMV 与 DTS / AC3 / EAC3 音轨等
- **一起听**：网易云音乐 × 哔哩哔哩，支持哔哩哔哩PV背景和屏蔽词设置等等众多功能
- **语音**：房间语音，成员之间直连（房主为树根），后端只负责信令与权限
- **屏幕共享与推流**：WebRTC 屏幕共享（观众互助转发、按质量自动换路）与内置 RTMP 服务的 OBS 推流
- **高画质代理**：使用 [ZViewerCLI](https://github.com/Zero-wyc/ZViewerCLI) 使用独立本地CLI本地获取哔站视频链接并支持高画质，极大减少服务器媒体流量
- **Windows桌面端**：采用Windows GO启动台，托管后端与网络入口，支持 IPv6 / FRP / EasyTier / Cloudflare Tunnel 外网接入
- **手机端**：Android / HarmonyOS / iOS 与平板客户端，支持一起看、一起听、投屏接收与房间语音并内嵌CLI解决手机浏览器哔哩哔哩无法高画质的问题
- **界面**：Material You风格，自定义背景与玻璃拟态，中英双语

> 浏览器建议使用 Chrome / Edge 130+；Safari 与 Firefox 对 MSE / MKV 支持不完整。

### [文档站（教程与更详细的使用说明）](https://docx.zviewer.zero251.xyz)

## 安装

| 平台 | 下载 | 启动 |
| --- | --- | --- |
| Windows 桌面版（推荐） | [zviewer-windows-x64-GUI.zip](https://github.com/Zero-wyc/ZViewer/releases) | 运行 `ZViewerDesktop.exe` |
| Windows 单文件 | [zviewer-windows-x64.zip](https://github.com/Zero-wyc/ZViewer/releases) | 运行 `start.bat` |
| Linux | [zviewer-linux-x64.tar.gz](https://github.com/Zero-wyc/ZViewer/releases) | 运行 `./start.sh` |

```bash
docker run -d --name zviewer --restart unless-stopped \
  -p 3333:3333 -p 3333:3333/udp -p 3334:3334 -p 3337:3337 \
  -v zviewer-data:/app/config \
  zerowyc0721/zviewer:latest
```

- HTTPS证书配置建议使用 ACME / Cloudflare / ESA / EdgeOne / 宝塔 / 1Panel 配置
- 数据位于 `/app/config`（数据库、证书、上传文件）
- 从4版本升到5版本建议重新安装

## 端口

| 端口 | 用途 |
| --- | --- |
| 3333/tcp | HTTP/HTTPS、WebSocket、页面 |
| 3333/udp | 语音媒体（UDP） |
| 3337/tcp | 语音媒体（TCP，UDP 受限时自动切换） |
| 3334/tcp | OBS RTMP 推流 |

主要的环境变量：

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `PORT` | 后端端口 | `3333` |
| `HOST` | 监听地址 | 双栈监听 |
| `CONFIG_DIR` | 数据根目录 | `<项目根>/config` |
| `CORS_ORIGIN` | 允许来源，逗号分隔 | `*` |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | 登录密钥 | 自动生成 |
| `JWT_ACCESS_EXPIRES_IN` / `JWT_REFRESH_EXPIRES_IN` | 正式用户访问 / 刷新令牌有效期，Cookie 同步跟随 | `24h` / `30d` |
| `SHARE_MEDIA_PORT` | 媒体 UDP 端口 | `3333` |
| `SHARE_MEDIA_TCP_PORT` | 媒体 TCP 端口。**不能与 `PORT` 相同**（会抢走网页端口）；留空用 3337 | `3337` |
| `SHARE_MEDIA_PUBLIC_IP` | NAT 1:1 下的公网地址（云主机 / FRP 场景必填） | 自动 |

其余变量（推流、Emby 等）见 `backend-go/internal/config`。

## 语音（采用Piik的语音链路）

语音在房间成员之间直连，房主是树根，后端只负责信令（`/signal`）与禁言、踢人等权限，音频不经过服务器。浏览器自动在 UDP 与 TCP 之间择优。

## 桌面端

`ZViewerDesktop.exe` 为 Go + WebView2 的启动台（采用Wails v2），启动台负责进程托管与网络接入：

- 一键启停后端 / ZViewerCLI
- 外网接入：IPv6 直连、服务商 FRP、自建 FRP、EasyTier 组网、Cloudflare Tunnel 一键安装
- Cloudflared / frpc / EasyTier 按需下载，安装包不内置

## 手机端

手机端在 [ZViewerAPP](https://github.com/Zero-wyc/ZViewerAPP)

| 平台 | 安装包与要求 |
| --- | --- |
| Android | `ZViewer-Client-2.3.5-android.apk`；Android 7.0 / API 24 及以上，仅支持 64 位设备 |
| HarmonyOS | `ZViewer-Client-2.3.5-harmonyos.hap`；HarmonyOS 6.1 / API 23 起，原生鸿蒙客户端，需自行侧载安装 |
| iOS / iPadOS | 未签名 IPA；需iOS 16.4 起，需用自己的证书签名后侧载 |

下载：[Android / HarmonyOS / iOS  ](https://github.com/Zero-wyc/ZViewerAPP/releases/)

- 首次启动填服务器地址：Android / HarmonyOS 可以只填 `IP:端口`，iOS 要填完整的 HTTP / HTTPS 地址
- 房间能力：一起看、一起听、投屏接收、房间语音、弹幕与字幕；Android / HarmonyOS 还能共享本机屏幕

## 开发

技术栈：前端采用 React 18 + Vite，后端采用 Go 和 SQLite 数据库，启动台为 Wails v2

```bash
npm install && npm run db:init   # 初始化
npm run db:upgrade               # 从 4.x 升级上来的旧库：先备份再补表补列
npm run db:backup                # 热备份（VACUUM INTO），WAL 下不要直接复制 .sqlite
npm run dev                      # 开发
npm run build && npm start       # 构建 + 运行
npm run lint:go && npm run test:go && npm test -w frontend   # 检查
```

环境要求 Go 1.26+、Node.js 22+。发布通过 `.github/workflows/build.yml` Github Action自动构建

## 文档

| 内容 | 位置 |
| --- | --- |
| 完整使用文档（部署、配置、环境变量） | [docx.zviewer.zero251.xyz](https://docx.zviewer.zero251.xyz) |
| 高画质代理 CLI | [ZViewerCLI](https://github.com/Zero-wyc/ZViewerCLI) |
| 手机端 | [ZViewerAPP](https://github.com/Zero-wyc/ZViewerAPP) |
