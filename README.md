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

`ZViewerDesktop.exe` 是 Go + WebView2 原生壳（Wails v2，无 Electron、无需装运行时），业务仍在网页端，负责托管后端与网络入口。

| 能力 | 说明 |
| --- | --- |
| 托盘与单实例 | 关窗驻留托盘；同一用户再次双击只唤回已有窗口 |
| 进程托管 | 一键启停后端 / LiveKit / ZViewerCLI；首次启动缺库自动 `--init-db`（`root` / `root`，登录后改） |
| 端口与 HTTPS | 端口可改并持久化；可为 localhost 签发证书 |
| 外网访问 | IPv6 直连、服务商 FRP、自建 FRP（导出 `frpc.toml`）、EasyTier 组网、Cloudflare Tunnel 一键隧道 |
| 高画质代理 | 内置 ZViewerCLI，默认 `9333`，仅监听 `127.0.0.1`，扫码登录，可随服务启动 |
| 按需组件 | cloudflared / frpc / EasyTier / LiveKit 首次使用对应功能时下载，安装包不带 |
| 自动更新 | 启动 6 秒后检查一次，此后每 6 小时；流式下载 + 结构校验 + 覆盖重启 |
| 日志 | 按 voice / tunnel / cli / update 分类、级别、关键字过滤，界面留最近 500 条 |

隧道与 IPv6 的实现约定见 [IMPLEMENTATION-CLOUDFLARE-TUNNEL.md](desktop/IMPLEMENTATION-CLOUDFLARE-TUNNEL.md)。

### 目录布局

| 位置 | 内容 |
| --- | --- |
| `ZViewerDesktop.exe` | GUI 入口 |
| `assets/ZViewer.ProcessHost.exe` | 进程监管宿主 |
| `runtime/` | 后端、LiveKit、CLI、网页；组件也下载到这里 |
| `runtime/.env`、`runtime/config` | 后端环境与业务数据 |
| `%APPDATA%/ZViewerDesktop` | GUI 设置、证书、FRP 凭据、日志 |
| `%USERPROFILE%/.zviewer/config.json` | ZViewerCLI 登录配置 |

整个文件夹可直接复制移动，无需安装。更新前退出控制台并备份 `.env`、`config` 与用户配置目录。

### 构建

需要 Go 1.26+、Node.js 22+、Python 3.11+（打包）与系统自带 C# 编译器（编进程监管宿主）。

```powershell
node build-all.js --win               # 先生成 Windows 运行包
npm --prefix desktop run shell:build  # build/bin/ZViewerDesktop.exe（--console 看日志）
npm --prefix desktop run shell:dist   # dist-gui/
npm --prefix desktop run package      # ZIP + SHA256
```

界面文件由 `go:embed` 编进 EXE，改 `desktop/ui/` 后需重新编译（调试可用 `npm --prefix desktop run preview`）。检查：`cd desktop && go vet ./... && go test ./...`。

```text
zviewer-windows-x64-GUI/
  ZViewerDesktop.exe                # 唯一启动入口
  assets/ZViewer.ProcessHost.exe    # 进程监管宿主
  runtime/                          # 后端、LiveKit、CLI、网页
  许可证、BUILD-MANIFEST.json
```

别直接 `cd desktop && go build -tags production .`，会覆盖已入库的 `desktop/desktop.exe`。

### 第三方组件

| 组件 | 版本 | 许可证 | 位置 |
| --- | --- | --- | --- |
| [frp](https://github.com/fatedier/frp) 客户端 | 0.71.1 | Apache-2.0 | 按需下载到 `runtime/frpc.exe` |
| [EasyTier](https://github.com/EasyTier/EasyTier) | 2.6.4 | LGPL-3.0 | 按需下载到 `runtime/mesh/` |
| [ZViewerCLI](https://github.com/Zero-wyc/ZViewerCLI) | 0.2.1 | MIT | 随包 `runtime/zviewer-cli-windows-amd64.exe` |
| [LiveKit](https://github.com/livekit/livekit) server | 1.13.7 | Apache-2.0 | 按需下载到 `runtime/livekit-server.exe` |

均为原样分发的未修改二进制，各自保留许可证：frp / EasyTier 在 `assets/LICENSE-*.txt`，LiveKit 与 CLI 随 `runtime/` 分发。

## 开发

面向改这个仓库的人。部署参数见 [DEPLOYMENT.md](DEPLOYMENT.md)。

- **两个独立 Go module，根目录没有 module**：`backend-go/`（`zviewer/backend`）与 `desktop/`（`zviewer/desktop`），各自编译，不共享 internal 包。
- 前端 SPA 生产由 Go 托管；开发时 Vite 跑 5174，把 `/api`、`/socket.io`、`/live` 反代到 3333。
- 语音是内嵌的 LiveKit 伴生进程，推流与一起听都在后端进程内，不依赖外部服务。
- `config/` 不入库（数据库、证书、上传、推流切片），新克隆必须跑 `npm run db:init`。

| 依赖 | 版本 |
| --- | --- |
| Go | 1.26+（桌面壳 1.25+） |
| Node.js | 22+ |
| npm | 10+ |
| Git Bash | 仅 Windows，跑 `backend-go/scripts/*.sh` 用 |

可选：OBS（调推流）、`sqlite3`、WebView2（开发桌面壳）。

| 路径 | 内容 |
| --- | --- |
| `frontend/` | React 18 + Vite SPA，别名 `@/` → `src/` |
| `backend-go/internal/api` | HTTP 层；业务在同级 `<域>` 包；SQL 在 `internal/store` |
| `backend-go/internal/db` | 打开、结构校验、索引、DDL、备份 |
| `backend-go/scripts` | 冒烟 / 回归脚本 |
| `backend-go/testdata/contract` | 端点与事件契约快照（189 端点 / 65 事件） |
| `desktop/` | Wails 桌面壳，`controller/` 管进程与证书 |
| `scripts/` | 热重载、产物编译、启动器 |

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 前后端一起（后端保存即重启） |
| `npm run dev:backend` / `dev:backend:once` / `dev:frontend` | 只起一端 |
| `npm run build` / `build:backend` / `build:frontend` | 产物到 `dist/` |
| `npm run build:all` | 交互式选平台，出 `dist/win` 或 `dist/linux` |
| `npm run db:init` / `db:backup` | 建库 / 热备份（VACUUM INTO） |
| `npm run lint:go` / `test:go` | `gofmt -l` + `go vet` / `go test ./...` |
| `npm run lint` / `npm test -w frontend` | eslint（0 error 0 warning）/ 前端单测 |
| `npm run test:regression` | 全量回归，约 1 分 45 秒 |

后端换端口用 `PORT`，前端指过去用 `VITE_API_TARGET`。端口分工：3333 后端与网页、5174 Vite、3334/3335 RTMP 与 HTTP-FLV、3336/3337/3338 LiveKit。

回归脚本各自覆盖一块（`route-parity`、`events-parity`、`bilibili-smoke`、`frontend-smoke`、`soak` 等），都用库副本，不动 `config/dev.sqlite`。单个跑：`bash backend-go/scripts/profile-smoke.sh`。

### 数据库

1. **启动绝不建表、绝不加列**。`VerifySchema` 缺表或缺关键列直接退出。
2. **`internal/db/schema.sql` 是唯一事实源**，只被 `--init-db` 使用；索引写在 `internal/db/indexes.go`，启动时幂等补建。
3. **加字段要改四处**：`schema.sql` → store 的 `columns` + `scanXxx` + `INSERT/UPDATE` → 老库迁移语句（无迁移框架）→ 跑回归。
4. **备份不能用 `cp`**：WAL 下最近事务在 `-wal` 里，单拷主文件会静默丢数据。

### 约定

- **后端**：`internal/api` → `internal/<域>` → `internal/store` 单向依赖；响应统一走 `httpx.OK / Fail`；表列名是带引号的 camelCase；时间比较用 `datetime('now')`。
- **前端**：一律 `@/` 别名；UI 走 `@/components/ui`，弹窗用 `ui/Modal`，时长用 `formatDuration(Ms)`；`components/` 不依赖 `modules/room`。
- **不做**：ORM / 查询构建器、启动路径自动 DDL。

### 发布

`.github/workflows/build.yml` 不跟 main 自动构建：手动触发填 `vX.Y.Z` 出正式版（建 tag + Release + 推产物仓库 + 同步 GitCode），留空只出 `latest` 预发布。

| Secret | 用途 |
| --- | --- |
| `RELEASE_REPO_TOKEN` | 对 `ZviewerRelease` 有 `contents:write` 的 PAT |
| `GITCODE_TOKEN` | 对 `ZViewer` 与 `ZviewerRelease` 有写权限 |

可选组件（cloudflared、frpc、EasyTier、LiveKit）放在 `ZviewerRelease` 的 **`components` 分支**：`main` 每次发版被孤儿提交整体替换，组件会被清掉。

更新源：网页端与 GUI 都有「使用镜像更新源」开关（默认开）。清单与安装包走 GitCode raw，偏好存 `config/update-source.json` / GUI 的 `settings.json`；运维可用 `ZVIEWER_UPDATE_SOURCE=github|gitcode|mirror` 覆盖。**不做自动回退**——选镜像就只走镜像，失败直接报错提示关开关。

## 文档

| 内容 | 位置 |
| --- | --- |
| 部署配置（端口、Docker、环境变量、推流、语音） | [DEPLOYMENT.md](DEPLOYMENT.md) |
| 完整使用文档 | [docx.zviewer.zero251.xyz](https://docx.zviewer.zero251.xyz) |
| 云隧道实现细节 | [desktop/IMPLEMENTATION-CLOUDFLARE-TUNNEL.md](desktop/IMPLEMENTATION-CLOUDFLARE-TUNNEL.md) |
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
