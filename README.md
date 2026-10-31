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
| ![](https://raw.githubusercontent.com/Zero-wyc/Image/main/All/20260930211758831.webp) | ![](https://raw.githubusercontent.com/Zero-wyc/Image/main/All/20261003201053941.webp) |
| ![](https://raw.githubusercontent.com/Zero-wyc/Image/main/All/20261003200715093.webp) | ![](https://raw.githubusercontent.com/Zero-wyc/Image/main/All/20261003201139524.webp) |

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

## ZViewerCLI

[ZViewerCLI](https://github.com/Zero-wyc/ZViewerCLI)（Go）是跑在用户本地的解析代理：用你自己的 Bilibili Cookie 在本地取流，房间内所有人共享大会员画质，几乎不占服务器带宽。

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
npm install && npm run db:init && npm run build && npm start
```

需要 Go 1.26+ 与 Node.js 22+，开发流程见[开发](#开发)。

## 桌面端（Windows）

`ZViewerDesktop.exe` 是 Go + WebView2 原生壳（无 Electron、无需装运行时），业务仍在网页端，负责托管后端与网络入口。

| 能力 | 说明 |
| --- | --- |
| 进程托管 | 一键启停后端 / LiveKit / CLI，关窗驻留托盘，同用户单实例 |
| 端口与 HTTPS | 端口可改并持久化，可为 localhost 签发证书 |
| 外网访问 | IPv6 直连、服务商 FRP、自建 FRP（导出 `frpc.toml`）、EasyTier 组网、Cloudflare Tunnel 一键隧道 |
| 高画质代理 | 内置 ZViewerCLI，仅监听 `127.0.0.1:9333`，扫码登录 |
| 按需组件 | cloudflared / frpc / EasyTier / LiveKit 首次使用时下载，安装包不带 |
| 自动更新 | 每 6 小时检查正式版，流式下载 + 结构校验 + 覆盖重启 |
| 日志 | 按 voice / tunnel / cli / update 分类过滤 |

`runtime/`（后端、网页、CLI）与 `%APPDATA%/ZViewerDesktop`（设置、证书、凭据、日志）分开存放，整个文件夹可直接搬走。

## 开发

需要 Go 1.26+、Node.js 22+，Windows 下另需 Git Bash（`backend-go/scripts/*.sh`）。

| 路径 | 内容 |
| --- | --- |
| `frontend/` | React 18 + Vite SPA，别名 `@/` → `src/` |
| `backend-go/` | 独立 Go module：`internal/api` HTTP 层、`internal/<域>` 业务、`internal/store` SQL |
| `desktop/` | 独立 Go module：Wails 壳，`controller/` 管进程与证书 |
| `scripts/`、`backend-go/scripts/` | 启动器、构建脚本、13 个冒烟 / 回归 |

```bash
npm install && npm run db:init   # 首次：建库，管理员 root / root
npm run dev                      # Vite 5174 反代到后端 3333
npm run build                    # 产物到 dist/
npm run lint:go && npm run test:go && npm test -w frontend && npm run lint
```

数据库：启动绝不建表或加列，`internal/db/schema.sql` 是唯一事实源，加字段要同步 store 与老库迁移；备份用 `npm run db:backup`（WAL 下 `cp` 会丢数据）。约定与发布流程见 [DEVELOPMENT.md](DEVELOPMENT.md)。

## 文档

| 内容 | 位置 |
| --- | --- |
| 部署配置（端口、Docker、环境变量、推流、语音） | [DEPLOYMENT.md](DEPLOYMENT.md) |
| 完整使用文档 | [docx.zviewer.zero251.xyz](https://docx.zviewer.zero251.xyz) |
| 开发细节（结构、命令、数据库、发布） | [DEVELOPMENT.md](DEVELOPMENT.md) |
| 桌面控制台细节（组件、目录、构建） | [desktop/README.md](desktop/README.md) |
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
