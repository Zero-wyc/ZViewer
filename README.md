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
  <a href="https://t.me/Zero_251">
    <img src="https://img.shields.io/badge/Telegram-26A5E4?style=flat-square&logo=telegram&logoColor=white" alt="Telegram">
  </a>
</p>

| ![](https://raw.githubusercontent.com/Zero-wyc/Image/main/All/20261003200919255.webp) | ![](https://raw.githubusercontent.com/Zero-wyc/Image/main/All/20261003200942428.webp) |
| ------------------------------------------------------------ | ------------------------------------------------------------ |
| ![](https://raw.githubusercontent.com/Zero-wyc/Image/main/All/20261003200643035.webp) | ![](https://raw.githubusercontent.com/Zero-wyc/Image/main/All/20261003200707122.webp) |

## 功能

- **一起看**：多人同步观影，房主控播，观众可申请暂停 / 快进
- **视频源**：Bilibili（含大会员画质）、MP4 直链、WebDAV / FTP / OpenList、Emby / Jellyfin、服务器本地目录
- **格式兼容**：MKV / AVI / TS / WMV，DTS / AC3 / EAC3 音轨
- **弹幕与字幕**：B 站、DandanPlay、本地文件；多轨字幕、字号独立调节
- **语音与共享**：语音聊天、WebRTC 屏幕共享
- **OBS 推流**：房间内 RTMP 推流与低延迟分发
- **一起听**：网易云 × 哔哩哔哩，歌单自动补位、双收藏夹一键收藏
- **高画质省带宽**：搭配 [ZViewerCLI](https://github.com/Zero-wyc/ZViewerCLI) 本地代理
- **界面**：Material You 主题、自定义背景、玻璃拟态
- **部署**：Docker / 单文件版开箱即用，一键自动更新

> 浏览器建议 Chrome / Edge 130+。Safari、Firefox 对 MSE / MKV 支持不完整，可能出现卡顿或字幕异常。

## 快速开始

首次启动自动创建管理员 `root` / `root`，**请登录后立即修改密码**。

### Windows 桌面版（推荐）

下载 [`zviewer-windows-x64-GUI.zip`](https://github.com/Zero-wyc/ZViewer/releases/download/latest/zviewer-windows-x64-GUI.zip)，解压后双击 `ZViewerDesktop.exe`，按界面提示启动服务。

### 单文件版

| 平台 | 文件 | 解压后 |
| --- | --- | --- |
| Windows | [zviewer-windows-x64.zip](https://github.com/Zero-wyc/ZViewer/releases/download/latest/zviewer-windows-x64.zip) | 运行 `start.bat` |
| Linux | [zviewer-linux-x64.tar.gz](https://github.com/Zero-wyc/ZViewer/releases/download/latest/zviewer-linux-x64.tar.gz) | 运行 `./start.sh` |

启动后访问 `http://localhost:3333`。正式版本请到 [Releases](https://github.com/Zero-wyc/ZViewer/releases) 按版本号选择。

### Docker

```bash
docker run -d --name zviewer --restart unless-stopped \
  -p 3333:3333 -p 3333:3333/udp -p 3334:3334 -p 3337:3337 \
  -v zviewer-data:/app/config \
  zerowyc0721/zviewer:latest
```

### 源码

```bash
npm install
npm run db:init
npm run build
npm start
```

需要 Go 1.26+ 与 Node.js。

## 文档

| 内容 | 位置 |
| --- | --- |
| 部署配置（端口、Docker、环境变量、推流、语音） | [docs/deployment.md](docs/deployment.md) |
| 完整使用文档 | [docx.zviewer.zero251.xyz](https://docx.zviewer.zero251.xyz) |
| 开发指南 | [DEVELOPMENT.md](DEVELOPMENT.md) |
| Windows 桌面控制台 | [desktop/README.md](desktop/README.md) |
| 高画质代理 CLI | [ZViewerCLI](https://github.com/Zero-wyc/ZViewerCLI) |
| 手机端（开发中） | [ZViewerAPP](https://github.com/Zero-wyc/ZViewerAPP) |

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
