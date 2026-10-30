# ZViewer

> Watch movies, listen to music and talk over voice — together, in one room.

English | **[中文](README.md)**

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

## Features

- **Watch together**: synchronized group viewing; the host controls playback, viewers can request pause / seek
- **Video sources**: Bilibili (premium quality), MP4 direct links, WebDAV / FTP / OpenList, Emby / Jellyfin, server local folders
- **Format compatibility**: MKV / AVI / TS / WMV, DTS / AC3 / EAC3 audio
- **Danmaku & subtitles**: Bilibili, DandanPlay, local files; multiple subtitle tracks with independent font sizes
- **Voice & sharing**: voice chat, WebRTC screen sharing
- **OBS streaming**: RTMP push and low-latency delivery inside the room
- **Listen together**: NetEase Cloud Music × Bilibili; playlists auto-filled, one-click favorites into both folders
- **High quality, low bandwidth**: pair with [ZViewerCLI](https://github.com/Zero-wyc/ZViewerCLI) for a local proxy
- **Interface**: Material You themes, custom backgrounds, glassmorphism
- **Deployment**: Docker / single-file builds work out of the box, one-click auto update

> Chrome / Edge 130+ is recommended. Safari and Firefox have incomplete MSE / MKV support — you may see stuttering or subtitle glitches.

## Quick Start

On first startup a ROOT administrator is created automatically: `root` / `root`. **Change the password immediately.**

### Windows Desktop (recommended)

Download [`zviewer-windows-x64-GUI.zip`](https://github.com/Zero-wyc/ZViewer/releases/download/latest/zviewer-windows-x64-GUI.zip), unzip it and run `ZViewerDesktop.exe`, then follow the prompts.

### Single-file build

| Platform | File | After unzipping |
| --- | --- | --- |
| Windows | [zviewer-windows-x64.zip](https://github.com/Zero-wyc/ZViewer/releases/download/latest/zviewer-windows-x64.zip) | run `start.bat` |
| Linux | [zviewer-linux-x64.tar.gz](https://github.com/Zero-wyc/ZViewer/releases/download/latest/zviewer-linux-x64.tar.gz) | run `./start.sh` |

Then open `http://localhost:3333`. For stable versions, pick one from [Releases](https://github.com/Zero-wyc/ZViewer/releases).

### Docker

```bash
docker run -d --name zviewer --restart unless-stopped \
  -p 3333:3333 -p 3333:3333/udp -p 3334:3334 -p 3337:3337 \
  -v zviewer-data:/app/config \
  zerowyc0721/zviewer:latest
```

### From source

```bash
npm install
npm run db:init
npm run build
npm start
```

Requires Go 1.26+ and Node.js.

## Documentation

| Topic | Where |
| --- | --- |
| Deployment (ports, Docker, environment variables, streaming, voice) | [docs/deployment.md](docs/deployment.md) (Chinese) |
| Full user guide | [docx.zviewer.zero251.xyz](https://docx.zviewer.zero251.xyz) (Chinese) |
| Development guide | [DEVELOPMENT.md](DEVELOPMENT.md) (Chinese) |
| Windows desktop console | [desktop/README.md](desktop/README.md) |
| High-quality proxy CLI | [ZViewerCLI](https://github.com/Zero-wyc/ZViewerCLI) |
| Mobile app (in development) | [ZViewerAPP](https://github.com/Zero-wyc/ZViewerAPP) |

## Community

[Telegram](https://t.me/Zero_251)　|　[QQ group](https://qm.qq.com/q/MuKPRVz8wc)

## Star History

<a href="https://star-history.com/#Zero-wyc/ZViewer&Zero-wyc/ZViewerCLI&Zero-wyc/ZViewerAPP&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=Zero-wyc/ZViewer,Zero-wyc/ZViewerCLI,Zero-wyc/ZViewerAPP&type=Date&theme=dark&v=2" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=Zero-wyc/ZViewer,Zero-wyc/ZViewerCLI,Zero-wyc/ZViewerAPP&type=Date&v=2" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=Zero-wyc/ZViewer,Zero-wyc/ZViewerCLI,Zero-wyc/ZViewerAPP&type=Date&v=2" />
 </picture>
</a>
