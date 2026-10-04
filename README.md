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

---

[Telegram](https://t.me/Zero_251) [QQ](https://qm.qq.com/q/MuKPRVz8wc)

---

项目文档：[docx.zviewer.zero251.xyz](https://docx.zviewer.zero251.xyz)

| ![](https://raw.githubusercontent.com/Zero-wyc/Image/main/All/20261003200919255.webp) | ![](https://raw.githubusercontent.com/Zero-wyc/Image/main/All/20261003200942428.webp) |
| ------------------------------------------------------------ | ------------------------------------------------------------ |
| ![](https://raw.githubusercontent.com/Zero-wyc/Image/main/All/20261003200643035.webp) | ![](https://raw.githubusercontent.com/Zero-wyc/Image/main/All/20261003200707122.webp) |
| ![](https://raw.githubusercontent.com/Zero-wyc/Image/main/All/20260930211758831.webp) | ![](https://raw.githubusercontent.com/Zero-wyc/Image/main/All/20261003201053941.webp) |
| ![](https://raw.githubusercontent.com/Zero-wyc/Image/main/All/20261003200715093.webp) | ![](https://raw.githubusercontent.com/Zero-wyc/Image/main/All/20261003201139524.webp) |

## 浏览器要求

> 建议使用 Chrome / Edge 等内核 130+ 的 Chromium 浏览器。Safari 与 Firefox 对 MSE / MKV 解码支持不完整，可能出现卡顿、无法解码、字幕异常。

#### PS：另有正处于开发状态的[Zviewer手机端](https://github.com/Zero-wyc/ZViewerAPP)　|　并由[FredQin](https://github.com/fredqin2006-X)开发

## 目录

**基础教程**

- [功能一览](#功能一览)
- [安装与启动](#安装与启动)
- [Docker 部署](#docker-部署)
- [HTTPS 证书](#https-证书)
- [常见问题](#常见问题)

**拓展教程**

- [架构总览](#架构总览)
- [房间同步逻辑](#房间同步逻辑)
- [视频源与 API 获取逻辑](#视频源与-api-获取逻辑)
- [一起听音乐管线](#一起听音乐管线)
- [语音高级配置](#语音高级配置)
- [ZViewerCLI 本地代理协议](#zviewercli-本地代理协议)
- [主题系统实现](#主题系统实现)
- [鉴权与权限模型](#鉴权与权限模型)
- [环境变量](#环境变量)
- [构建与更新机制](#构建与更新机制)
- [本地开发](#本地开发)

---

## Docker 用户升级提示（v4.3.6 以下必读）

> **v4.3.6 以下版本使用 Docker 部署的用户**：请**不要**通过管理面板「基础设置 → 一键更新」升级——请查看最新docker compose进行部署

# 基础教程

## 功能一览

| 模块 | 功能 |
|---|---|
| 一起看房间 | 多人同步观影；房主控制播放，观众可申请暂停 / 快进 |
| 视频源 | Bilibili（分 P、清晰度切换、大会员画质）、MP4 直链、WebDAV / FTP / OpenList 网盘挂载、Emby / Jellyfin 媒体库、服务器本地影片目录挂载 |
| 播放兼容 | 浏览器支持格式直连播放；MKV / AVI / TS / WMV 浏览器端解析重封装；DTS / AC3 / EAC3 音轨浏览器端实时转 AAC； |
| 播放模式 | 三种按需切换：CLI 本地代理（大会员 4K 高码率，不耗服务器流量）、服务器 DASH 转发（全房高清，消耗带宽）、MP4 直链转发（最高 720P，兼容性兜底） |
| 弹幕 | Bilibili 官方 / DandanPlay / 本地 XML·JSON 弹幕文件多轨道叠加渲染；同一视频可挂多条 B 站弹幕轨道 |
| 字幕 | 稀疏探测字幕引擎，SRT / ASS / SSA / VTT / SMI / SUB 与 MKV 内嵌字幕统一转换渲染 |
| 互动 | 评论、语音聊天（LiveKit WebRTC；一起看 / 一起听 / 屏幕共享全场景，UDP/TCP 传输模式可切换） |
| 推流 | WebRTC 屏幕共享；OBS RTMP 推流 + HTTP-FLV 拉流 |
| 一起听 | 网易云音乐 × 哔哩哔哩 |
| 音乐工具 | 视频标题一键搜索网易云同名歌曲并一键收藏歌单；播放列表自动补位推荐；bilibili / music 双收藏夹一键收藏；B 站 MV / PV 设为歌词页背景；歌词逐句同步滚动 |
| 个性化 | Material You 动态主题、自定义主题色与颜色强度、玻璃拟态、自定义背景、精简动画；弹幕 / 字幕字体字号独立调节 |
| 管理运维 | 一键自动更新；Docker / 单文件版开箱即用 |
| ZViewerCLI | Go 编写的本地代理，用你自己的 Cookie 在本地解析 B 站高画质并代理视频流，全房间共享大会员画质且不耗服务器流量（详见下文） |

---

## ZViewerCLI

使用[ZViewerCLI](https://github.com/Zero-wyc/ZViewerCLI)（Go编写）解决哔哩哔哩高画质问题

ZViewerCLI 是一个运行在用户本地的 Go 程序，用于解决浏览器端无法直接使用用户 Bilibili Cookie 与高画质地址的问题。CLI使用用户自己的 Cookie 在本地解析 Bilibili 视频，并代理视频流请求，从而让 ZViewer 房间中的所有人都能稳定播放大会员等高画质内容。

虽然说有DASH模式（服务器转发视频模式，但是这会极大消耗服务器带宽，很显然，要既要哔哩哔哩的高画质又要小的服务器带宽，于是CLI就应运而生）

三种播放模式按需切换：

---

## 安装与启动

首次启动自动创建ROOT管理员：用户名 `root`，密码 `root`。**生产环境部署后立即修改密码。**

### 单文件版（推荐）

从 [Releases](https://github.com/Zero-wyc/ZViewer/releases) 下载压缩包，解压后运行：

```bash
# Windows
start.bat start         # 启动服务
start.bat               # 交互菜单

# Linux
./start.sh start
./start.sh              # 交互菜单
```

访问 `http://localhost:3333`。

压缩包内含 `livekit-server` 伴生二进制（语音聊天），后端启动时自动拉起，公网 IP 经 STUN 自动发现，无需单独安装或配置；HTTPS 页面下语音自动使用 wss。

### 源码版

```bash
npm install             # 安装依赖
npm run dev             # 开发模式（前端 5174 / 后端 3333）

# 生产构建与启动
npm run build
npm start
```

或使用 `start-prod` 脚本处理依赖、构建、启动：

```powershell
.\start-prod.bat start    # Windows
./start-prod.sh start     # Linux / macOS
```

脚本支持的完整命令：`start` / `backend` / `stop` / `restart` / `status` / `logs` / `build` / `cert` / `https` / `help`。

### 端口

| 端口 | 用途 | 是否对外 |
|---|---|---|
| 3333/tcp | 统一入口：HTTP/HTTPS API、WebSocket、前端页面、`/live` FLV 代理 | 是 |
| 3333/udp | LiveKit WebRTC 媒体传输（语音聊天，与页面同号不同协议） | 是 |
| 3334 | RTMP 推流（OBS，TCP 二进制协议无法与 HTTP 复用） | 是 |
| 3335 | HTTP-FLV 拉流（Node Media Server 内部端口） | 否 |
| 5349 | TURN/TLS 媒体中继（可选启用，UDP 被拦时的 TCP 兜底通道） | 是 |
| 3337/tcp | LiveKit ICE/TCP 媒体直连（管理端切换「语音传输模式 = TCP」时启用；UDP 被墙时的直连兜底） | 按需 |

OBS 推流地址：`rtmp://<host>:3334/live`。语音聊天的信令经 3333 的 `/rtc` 反代，无需额外端口。

## Docker 部署

镜像内嵌语音聊天（LiveKit 伴生二进制随镜像分发，启动时由后端自动拉起），单容器即含全部功能，无需独立 LiveKit 容器。

```bash
docker run -d \
  --name zviewer \
  --restart unless-stopped \
  -p 3333:3333 \
  -p 3333:3333/udp \
  -p 3334:3334 \
  -v zviewer-data:/app/config \
  zerowyc0721/zviewer:latest
```

或 docker compose：

```yaml
services:
  zviewer:
    image: zerowyc0721/zviewer:latest
    ports:
      - "3333:3333"      # 统一入口：API + WebSocket + 前端页面 + /live FLV 代理 + /rtc 语音信令反代
      - "3333:3333/udp"  # LiveKit WebRTC 媒体传输（与页面同号，协议不同）
      - "3334:3334"      # RTMP 推流 (OBS)
      - "3337:3337"    	 # ICE/TCP 媒体直连：管理端「语音传输模式 = TCP」
    volumes:
      - zviewer-data:/app/config
    restart: unless-stopped
```

- 请修改上面的zviewer-data为实际需放数据文件的目录路径
- 镜像以 HTTP 模式启动，HTTPS 需要自行配置（或使用反向代理）
- `/app/config` 挂载 volume，含数据库（`dev.sqlite`）、证书（`ssl/`）、上传文件（`uploads/`）、推流切片（`media/`）。
- **语音聊天**：开箱即用，无需任何配置——公网 IP 经 LiveKit 原生 STUN 自动发现，信令地址按页面域名自动推导（HTTPS 页面自动 wss）；媒体走 3333/udp，防火墙需放行。UDP 被运营商/企业防火墙拦截时，可在管理端「基础设置 → 语音传输模式」切换为 TCP（LiveKit 原生 ICE/TCP 3337 直连兜底，需放行 3337/tcp 并补端口映射）。
- docker模式下，仍然可使用网页更新，为程序文件（含 livekit-server）替换后直接重启后端进程，不重启容器但也不更新容器版本号。
- **进阶**：UDP 被防火墙拦截时的 TURN/TLS 兜底中继、语音传输模式（UDP/TCP）切换、NAT 复杂环境手动指定广播 IP，见拓展教程「语音高级配置」。

---

# 拓展教程

## 架构总览

```
浏览器（React SPA）
   │  HTTP REST + Socket.IO WebSocket
   ▼
后端（Express，端口 3333，统一入口）
   ├── REST 路由        /api/*        鉴权、房间、挂载、解析、音乐…
   ├── Socket.IO        /socket.io    房间实时同步
   ├── 静态托管          frontend/dist + SPA 回退
   ├── /live 反代       → Node Media Server（内部 3335）
   └── 内嵌 NCM 服务     127.0.0.1:36530（一起听音乐）
RTMP 3334 → Node Media Server → FLV 3335（内部）
```

- **单进程单端口**：所有流量走 3333
- **数据库**：TypeORM + sql.js（wasm SQLite），支持 `DATABASE_URL` 切换 PostgreSQL。
- **技术栈**：后端 Express + TypeScript + Socket.IO；前端 React 18 + Vite + Tailwind + Zustand。

## 房间同步逻辑

同步链路 Socket.IO，连接时经 JWT 鉴权中间件（`io.use`）

**角色与状态广播**

- 房主是唯一同步端。房主操作（播放 / 暂停 / 跳转 / 倍速 / 切换影片）→ 后端写入房间状态并 `io.to(roomId).emit` 广播 → 观众端播放器（seek + play/pause）
- 服务器持有房间状态：房主短暂断线时由服务器继续维持状态，观众不中断；房主重连后从服务器取回状态继续当同步端。
- 影片切换后观众端按新的直接地址重新建流；内嵌字幕提取流在切换时被无条件取消，避免服务器中转流量泄漏。

**控制权申请**

- 观众发起申请 → 后端转发给房主（播放器左上角通知）→ 房主同意后该观众获得临时控制权，操作走与房主相同的事件通道。
- 房主可随时收回

**离线与关房**

- 房主离线超过 10 分钟，后端自动关闭房间
- 房主离线期间观众端进入"自主控制模式"（无需申请直接控制本地播放器，不广播）；房主重连后自动恢复申请模式。

## 视频源与 API 获取逻辑

### Bilibili

1. 前端提交 BV 号或链接 → 后端解析。
2. 后端向 B站 API 发起请求，获取分 P / 清晰度列表与 DASH 播放地址。
3. 视频流与封面经后端代理转发（`/api/stream/proxy*`），注入 Referer / Origin / User-Agent，绕过 CDN 防盗链；封面代理同时做 URL 白名单校验。
4. AI 字幕走 `x/player/v2`，该接口不稳定（同视频可能返回错配字幕），后端以视频时长做带内校验并最多重试 4 次。
5. 弹幕：Bilibili 官方 XML 或 DandanPlay 接口，前端解析渲染。

### 挂载源（WebDAV / FTP / OpenList / Emby / Jellyfin）

- 挂载配置保存在后端，目录浏览请求由后端代发，前端拿文件List。
- **直链解析**：AList 等源的签名直链会过期。播放时前端调 `/api/direct-resolve/movie` 按影片记录查挂载源取直链
- **HTTPS 直链活性校验**：前端 https 页面加载 http 直链失败自动重试

### 播放引擎

- MP4 / WebM 等原生可播格式 → 直接 `video.src`（direct 引擎，30s 超时）。
- MKV / AVI / TS / WMV → playsvideo 引擎：浏览器端解析容器并重封装为 fMP4 喂 MSE；DTS / AC3 / EAC3 音轨在浏览器端实时转码 AAC。转码核心随前端资源分发，服务器零依赖。
- 跨域源统一包装为 `/api/stream/proxy?url=` 走后端中转；同源相对路径直接附带鉴权 token。
- 引擎会话按 video 级登记互斥，attach 被新加载取代时静默退出，消除跨实例并发导致的偶发双声。

## 一起听音乐管线

```
前端 <audio>
   │  /api/music/stream?songId=&level=&roomId=
   ▼
主后端 /api/music/*
   │  callNcmApi()（附加 timestamp 绕内部服务 apicache，防不同登录态串味）
   ▼
内部 NCM 服务 127.0.0.1:36530
   │  @neteasecloudmusicapienhanced/api（serveNcmApi，）
   ▼
网易云上游
```

| 角色 | 权限 |
|---|---|
| `root` | 全部房间控制/删除、用户审核、角色管理、管理后台 |
| `admin` | 创建并完全控制自己的房间 |
| `user` | 加入房间、评论弹幕 |
| `guest` | 同 user（注册后默认 guest + pending，root 审核通过转 user） |

## 语音高级配置

默认部署零配置即可用：公网 IP 由 LiveKit 原生 STUN 自动发现（需容器/服务器可出网），UDP 直连建立媒体通道。以下为特殊网络环境下的进阶选项。

### 语音传输模式（UDP / TCP 切换）

管理端「基础设置 → 语音传输模式」可切换语音媒体通道，保存后自动热重启语音服务（进行中的语音短暂中断后自动重连）：

| 模式 | livekit-server 启动参数 | 部署侧要求 |
|---|---|---|
| UDP（默认） | `--udp-port 3333` | 放行 3333/udp |
| TCP | `--udp-port 3333` + `--tcp-port 3337` | 额外放行 3337/tcp（Docker 需补端口映射） |

TCP 模式为 LiveKit 原生 ICE/TCP **直连**：服务器同时广播 UDP 与 TCP 两路候选，由浏览器 ICE 自动选路——UDP 可用时走低延迟直连，被运营商/企业防火墙拦截时自动经 3337/tcp 连接。UDP 通道始终开启（LiveKit 不支持禁用 UDP 候选），TCP 模式是「加开兜底」而非「替换」；端口可用环境变量 `LIVEKIT_RTC_TCP_PORT` 覆盖。

与 TURN/TLS 的区别：ICE/TCP 3337 仍是浏览器与服务器**直连**（无需域名与证书）；TURN/TLS 5349 是**中继**（需域名与正式证书，穿透性更强）。二者可同时部署，客户端按连通性自动选择。

### TURN/TLS 兜底中继

适用场景：服务器或客户端所在网络**拦截 UDP**（企业防火墙、部分校园网），STUN 直连无法建立媒体。

原理：浏览器经 **TCP 5349** 主动连接服务器的 TURN 中继，媒体经中继转发；地址用域名（DNS 解析），不依赖公网 IP。UDP 直连仍并行尝试，TURN 仅作兜底，不影响直连成功时的低延迟。

三个环境变量齐全即自动启用：

```yaml
# docker-compose.linux-single.yml 补充
    ports:
      - "5349:5349"      # TURN/TLS 中继（TCP）
    environment:
      - LIVEKIT_TURN_DOMAIN=zviewer.example.com
      - LIVEKIT_TURN_CERT=/app/cert/live/zviewer.example.com/fullchain.pem
      - LIVEKIT_TURN_KEY=/app/cert/live/zviewer.example.com/privkey.pem
    volumes:
      - /etc/letsencrypt:/app/cert:ro   # 挂载宿主证书目录
```

- 域名必须与证书一致，且解析到本服务器
- **必须正式证书**（Let's Encrypt 等），自签证书不被浏览器 WebRTC 信任
- `LIVEKIT_TURN_EXTERNAL_TLS=true` 可在 TLS 由外部反代终结时使用

### 手动指定广播 IP（`LIVEKIT_NODE_IP`）

STUN 探测失败（纯内网部署且无出网、特殊 NAT）时，ICE 会广播不可达的内网地址。此时可手动指定服务器公网 IP：

```yaml
    environment:
      - LIVEKIT_NODE_IP=203.0.113.10   # 宿主公网 IP，IPv6 直连场景填 v6 地址
```

显式配置优先级最高（设置后不再注入 STUN 自动发现）。

## 环境变量

| 变量 | 说明 | 默认值 |
|---|---|---|
| `PORT` | 后端端口 | `3333` |
| `HOST` | 监听地址 | 空（双栈） |
| `NODE_ENV` | 运行环境 | `production` |
| `DATABASE_URL` | SQLite 路径或 PostgreSQL 连接串 | `<config>/dev.sqlite` |
| `CONFIG_DIR` | 数据根目录 | `<project-root>/config` |
| `CORS_ORIGIN` | CORS 来源，逗号分隔 | `*` |
| `JWT_ACCESS_SECRET` | Access 密钥（生产必须修改） | — |
| `JWT_REFRESH_SECRET` | Refresh 密钥（生产必须修改） | — |
| `JWT_ACCESS_EXPIRES_IN` | Access 有效期 | `15m` |
| `JWT_REFRESH_EXPIRES_IN` | Refresh 有效期 | `7d` |
| `RTMP_PORT` | RTMP 推流端口 | `3334` |
| `HTTP_FLV_PORT` | FLV 拉流端口（内部） | `3335` |
| `LIVEKIT_EXTERNAL` | `1` 时跳过内嵌 LiveKit，使用外置服务 | `0` |
| `LIVEKIT_BIND` | 内嵌 LiveKit 监听地址 | `::`（双栈） |
| `LIVEKIT_NODE_IP` | ICE 广播地址；留空时自动启用 LiveKit 原生 STUN 外部 IP 发现（需可出网），NAT 复杂环境手动指定公网 IP | 空（自动） |
| `LIVEKIT_RTC_TCP_PORT` | ICE/TCP 端口（管理端「语音传输模式 = TCP」时开启的直连兜底通道） | `3337` |
| `LIVEKIT_TURN_DOMAIN` | TURN/TLS 域名（与 CERT/KEY 三者齐全即启用 TCP 5349 兜底中继，域名寻址不依赖公网 IP） | — |
| `LIVEKIT_TURN_CERT` | TURN TLS 证书路径（必须正式证书，自签不被浏览器 WebRTC 信任） | — |
| `LIVEKIT_TURN_KEY` | TURN TLS 私钥路径 | — |

## 构建和更新

- **构建**：`build-all.js` 将前后端编译为单文件版本（`zviewer-backend` / `zviewer-cert`，打包目标 node26），并下载 LiveKit 伴生二进制随包分发（语音聊天下箱即用）；启动脚本模板在 `packaging/`。
- **CI**：push `main` → 构建双平台单文件（node26），Linux 版推 Docker Hub（`0.0.0-dev.<sha>` 预发布）；打 `v*` tag → 正式版 + GitHub Release。CI 下 LiveKit 下载失败会硬失败，保证产物含完整语音能力。
- **更新**：后端从 GitHub Releases 检测新版本（管理后台可关预发布），下载后替换程序文件并重启进程；也支持手动上传压缩包更新。数据库与配置在 `config/`，更新不覆盖。

## 本地开发

npm workspaces，根目录统一装依赖：

```bash
npm install
npm run dev            # 前后端同时启动
npm run dev:backend    # 仅后端（3333，热重载）
npm run dev:frontend   # 仅前端（5174，HMR）
```

前端开发经 Vite 代理转发 `/api`、`/socket.io`、`/live` 到后端，无需配置 `VITE_API_URL`。

```
ZViewer/
├── backend/          # Express 后端（TypeScript + TypeORM + sql.js）
│   └── src/
│       ├── routes/          # REST API 路由
│       ├── services/        # B站解析、代理、证书、更新
│       ├── modules/         # 房间、观众、同步、音乐、CLI
│       ├── entities/        # TypeORM 实体
│       └── middleware/      # 鉴权中间件
├── frontend/         # React 前端（Vite + Tailwind + Zustand）
│   └── src/
│       ├── pages/           # 页面
│       ├── components/      # 通用 UI
│       ├── modules/         # 音乐 / 房间 / 一起看等功能模块
│       └── store/           # Zustand 状态
├── ZViewerCLI/       # Go 本地代理客户端（独立仓库 ZViewerCLI）
├── packaging/        # 启动脚本模板
├── docker/           # Docker 入口脚本
└── build-all.js      # 单文件编译脚本
```
