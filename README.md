# ZViewer

> 多人同步观影、追番与远程共享平台。

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

| ![](https://github.cdn.zero251.xyz/Zero-wyc/Image/main/All/20260804013054107.webp) | ![](https://github.cdn.zero251.xyz/Zero-wyc/Image/main/All/20260804013133193.webp) |
| ------------------------------------------------------------ | ------------------------------------------------------------ |
| ![](https://github.cdn.zero251.xyz/Zero-wyc/Image/main/All/20260804013107507.webp) | ![](https://github.cdn.zero251.xyz/Zero-wyc/Image/main/All/20260804013127227.webp) |

## 浏览器要求

使用 Chrome / Edge 等内核 130+ 的 Chromium 浏览器。Safari 与 Firefox 对 MSE / MKV 解码支持不完整，可能出现卡顿、无法解码、字幕异常。

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
- [ZViewerCLI 本地代理协议](#zviewercli-本地代理协议)
- [主题系统实现](#主题系统实现)
- [鉴权与权限模型](#鉴权与权限模型)
- [环境变量](#环境变量)
- [构建与更新机制](#构建与更新机制)
- [本地开发](#本地开发)

---

# 基础教程

## 功能一览

| 模块 | 功能 |
|---|---|
| 一起看房间 | 多人同步观影；房主控制播放，观众申请控制；房主离线时观众自主控制，超时 10 分钟自动关房 |
| 视频源 | Bilibili（清晰度切换/大会员）、MP4 直链、WebDAV / FTP / OpenList 挂载、Emby / Jellyfin |
| 播放兼容 | MKV / AVI / TS / WMV 浏览器端重封装播放；DTS / AC3 / EAC3 音轨浏览器端转码；无需服务端 FFmpeg |
| 字幕 | SRT / ASS / SSA / VTT / SMI / SUB 原生渲染；MKV 内嵌字幕浏览器端直接提取 |
| 互动 | 评论、弹幕（Bilibili 官方 / DandanPlay / 自定义轨道）、语音聊天（128kbps） |
| 推流 | WebRTC 屏幕共享；OBS RTMP 推流 + HTTP-FLV 拉流 |
| 一起听 | 网易云音乐同步听歌，扫码登录，VIP 凭证全房间共享，音质降级 |
| 主题 | Material You 动态主题、自定义主题色与颜色强度、玻璃拟态、自定义背景、精简动画 |
| 移动端 | 竖屏 / 横屏自适应布局，触屏手势与滑动条 |

## 安装与启动

首次启动自动创建超级管理员：用户名 `root`，密码 `root`。**生产环境部署后立即修改密码。**

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

### 源码版

```bash
npm install             # 安装依赖
npm run dev             # 开发模式（前端 5174 / 后端 3333）

# 生产构建与启动
npm run build
npm start
```

或使用 `start-prod` 脚本一键处理依赖、构建、启动：

```powershell
.\start-prod.bat start    # Windows
./start-prod.sh start     # Linux / macOS
```

脚本支持的完整命令：`start` / `backend` / `stop` / `restart` / `status` / `logs` / `build` / `cert` / `https` / `help`。

### 端口

| 端口 | 用途 | 是否对外 |
|---|---|---|
| 3333 | 统一入口：HTTP/HTTPS API、WebSocket、前端页面、`/live` FLV 代理 | 是 |
| 3334 | RTMP 推流（OBS，TCP 二进制协议无法与 HTTP 复用） | 是 |
| 3335 | HTTP-FLV 拉流（Node Media Server 内部端口） | 否 |

OBS 推流地址：`rtmp://<host>:3334/live`。

## Docker 部署

```bash
docker run -d \
  --name zviewer \
  --restart unless-stopped \
  -p 3333:3333 \
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
      - "3333:3333"
      - "3334:3334"
    volumes:
      - zviewer-data:/app/config
    restart: unless-stopped

volumes:
  zviewer-data:
```

- 镜像以 HTTP 模式启动，HTTPS 建议在前加 Nginx / Caddy 反代。
- `/app/config` 挂载 volume，含数据库（`dev.sqlite`）、证书（`ssl/`）、上传文件（`uploads/`）、推流切片（`media/`）。
- 容器内更新为程序文件替换后直接重启后端进程，不重启容器。

## HTTPS 证书

证书工具（`zviewer-cert`）按地址类型自动选择签发方式：

| 地址类型 | 证书 |
|---|---|
| `localhost` | 自签（SAN 含 localhost / 127.0.0.1 / ::1，10 年） |
| 域名 | Let's Encrypt（内置 ACME 客户端自动申请） |
| 公网 IP | Let's Encrypt（IP 证书） |
| 内网 IP | 自签（SAN 写入 IP） |

```bash
start.bat cert example.com      # 域名 → Let's Encrypt
start.bat cert 1.2.3.4          # 公网 IP → Let's Encrypt
start.bat cert 192.168.1.1      # 内网 IP → 自签
start.bat https example.com     # 签发证书 + HTTPS 启动
```

Let's Encrypt 前置条件：域名已解析到本机、**80 端口**放行（HTTP-01 验证）。证书输出在 `config/ssl/`。正式环境每域名每周限 5 张，调试加 `--staging`。

## 常见问题

**自签证书提示"不安全"**：导入 `config/ssl/cert.pem` 到系统受信任根证书，或改用域名 + Let's Encrypt。

**WebSocket 连接失败**：反向代理需加升级头：

```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
```

**WebRTC 无法连接**：`getUserMedia` 要求 HTTPS。双方处于严格 NAT 后需部署 TURN（如 coturn）。

**Bilibili 解析失败**：大会员内容需在后台配置 Bilibili 凭证，或使用 ZViewerCLI 本地代理。

**Bilibili AI 字幕错配**：B站 `x/player/v2` 接口不稳定，同视频可能随机返回其他视频字幕，后端已按时长做校验重试，仍失败属上游问题，重试即可。

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

- **单进程单端口**：生产模式所有流量走 3333，无跨域问题。
- **数据库**：TypeORM + sql.js（wasm SQLite），无原生模块，单文件版任意平台直接运行；支持 `DATABASE_URL` 切换 PostgreSQL。
- **技术栈**：后端 Express + TypeScript + Socket.IO；前端 React 18 + Vite + Tailwind + Zustand。

## 房间同步逻辑

同步链路全部走 Socket.IO，连接时经 JWT 鉴权中间件（`io.use`），token 无效拒绝握手。

**角色与状态广播**

- 房主是唯一的同步源。房主操作（播放 / 暂停 / 跳转 / 倍速 / 切换影片）→ 后端写入房间状态并 `io.to(roomId).emit` 广播 → 观众端播放器对齐（seek + play/pause）。
- 服务器持有房间状态的权威副本：房主短暂断线时由服务器继续维持状态，观众不中断；房主重连后从服务器取回状态继续当同步源。
- 影片切换后观众端按新的直接地址重新建流；内嵌字幕提取流在切换时被无条件取消，避免服务器中转流量泄漏。

**控制权申请**

- 观众发起申请 → 后端转发给房主（播放器左上角通知）→ 房主同意后该观众获得临时控制权，操作走与房主相同的事件通道。
- 房主可随时收回。

**离线与关房**

- 房主离线超过 10 分钟，后端自动关闭房间并通知全员。
- 房主离线期间观众端进入"自主控制模式"（无需申请直接控制本地播放器，不广播）；房主重连后自动恢复申请模式。

## 视频源与 API 获取逻辑

### Bilibili

1. 前端提交 BV 号或链接 → 后端解析。
2. 后端向 B站 API 发起请求（注入后台配置的登录凭证），获取分 P / 清晰度列表与 DASH 播放地址。
3. 视频流与封面经后端代理转发（`/api/stream/proxy*`），注入 Referer / Origin / User-Agent，绕过 CDN 防盗链；封面代理同时做 URL 白名单校验。
4. AI 字幕走 `x/player/v2`，该接口不稳定（同视频可能返回错配字幕），后端以视频时长做带内校验（容差 max(10s, 8%)）并最多重试 4 次。
5. 弹幕：Bilibili 官方 XML 或 DandanPlay 接口，前端解析渲染。

### 挂载源（WebDAV / FTP / OpenList / Emby / Jellyfin）

- 挂载配置保存在后端，目录浏览请求由后端代发，前端只拿文件列表。
- **直链实时解析**：AList 等源的签名直链会过期。播放时前端调 `/api/direct-resolve/movie` 按影片记录反查挂载源取新鲜直链（5 分钟 TTL 缓存 + 单飞去重），失败回退固化 URL。
- **HTTPS 直链活性校验**：源站事后撤掉 TLS 会导致缓存的 https 直链不可达。下发前对 https 端点现场活性校验，失败即自愈为 http（openlist / webdav / emby / jellyfin 四路由统一）；前端 https 页面加载 http 直链失败时自动降级重试。
- **协议升级与信任源**：`127.0.0.1` / `localhost` 信任源保持直连；HTTPS 站点 + HTTP 直链受浏览器混合内容限制，自动转服务器代理。

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
   │  @neteasecloudmusicapienhanced/api（serveNcmApi，端口占用 +1 重试）
   ▼
网易云上游
```

- **`/api/music/ncm/*`**：通用转发，自动注入当前用户持久化的网易云 Cookie；剥离 query/body 中的 cookie 参数防客户端伪造登录态；扫码登录路径（`/login/qr/*`）不注入旧凭据，避免 800 循环。
- **`/api/music/stream`** 音频流代理：
  - 音质降级链 `lossless → exhigh → higher → standard`，`freeTrialInfo` 非空视为不可用；
  - `/song/url/v1` 失败（路由 404 / 网络抛错）时回退老接口 `/song/url`（level → br 映射）；
  - 凭证回退链：当前用户 Cookie → 房主 Cookie（请求带 roomId 时），实现"房主登录 VIP 全房间可听"；
  - 直链域名校验 `*.music.126.net`（防 SSRF）；`direct=1` 模式 302 CDN 直链 + 15 分钟缓存，`http:` 直链统一改写 `https:`。
- **登录态**：网易云扫码登录后 Cookie 持久化到数据库，按用户隔离。

## ZViewerCLI 本地代理协议

[ZViewerCLI](https://github.com/Zero-wyc/ZViewerCLI)（Go）解决浏览器无法携带本地 Bilibili Cookie 拿高画质地址的问题。**v0.2.0 起去房间化**：

- 配置只需服务器地址 + Cookie（+ 可选用户名），不需要房间号。
- CLI 启动后向服务器 Socket.IO 发 `cli-register`（payload：proxyUrl / agent / version / user），全局注册到专用房间 `__cli-agents__`（仅为聚合便利），上下线通过 `cli-agent-available` / `cli-agent-unavailable` **全局广播**。
- 前端按登录用户名过滤代理列表（无 user 字段的旧版 CLI 视为公共代理全员可见），任一可用即启用。
- 房间开启 CLI 功能（音乐视频高画质 / cliEnabled）后自动使用，无需逐房间连接。
- 代理链路：前端 → `http://127.0.0.1:9333`（CLI 本地 HTTP 代理）→ B站 CDN，注入本地 Cookie 与 Referer / Origin / User-Agent。
- CLI 重启后配置为内存态，需从网页端配置页重新带入（`?server=&user=`）。

## 主题系统实现

- **Material You（Monet）**：种子色 → `@material/material-color-utilities` 生成浅 / 深两套完整 scheme，以 CSS 变量（`--md-sys-color-*`）注入根节点，种子不变时缓存。
- **颜色强度**：种子色与深浅各自的中性基底按 sRGB 线性插值（`resolveEffectiveSeed`）合成实际种子，0-100 滑块实时生效，100 = 纯色。
- **文字对比度自适应**：壁纸/遮罩会改变文字底色，单一全局判定无法同时满足"玻璃面板"与"直坐壁纸"两类页面。实现为作用域变量：
  - `--lt-raw-*`：按原始背景（底色 → 壁纸 → 遮罩）判定，供音乐壳、顶栏等直坐壁纸的页面；
  - `--lt-glass-*`：按含玻璃层的有效背景判定，供播放页、迷你条等玻璃面组件；
  - 根节点文字变量固定 scheme 原生值，弹窗（portal 到 body）天然配对。
- **主题编辑栏**（主题菜单一级左栏）：Zen 主题编辑器五段式——模式切换 / 自定义颜色 / 预设+收藏色板 / 实时预览；取色页（SV 二维区 + 色相条 + Hex）保存动作显式二选一（存为新色 / 更新收藏），收藏板无隐式改写。
- **玻璃拟态**：`--glass-strength` / `--glass-blur` 全局变量统一驱动，所有玻璃卡片引用同一组工具类；精简动画模式一键锁定玻璃不透明并关闭模糊。

## 鉴权与权限模型

- JWT 双 token：access 15 分钟 / refresh 7 天，httpOnly Cookie 与 Bearer 头双通道（媒体标签与事件流场景各取所需）。鉴权 cookie 判定含 Origin scheme 兜底，兼容内网穿透。
- 页面生命周期内的持久化登录态只作预热（提前建连），鉴权路由只信本次加载的认证终态——避免登出残留态导致重定向异常。
- 四层角色：

| 角色 | 权限 |
|---|---|
| `root` | 全部房间控制/删除、用户审核、角色管理、管理后台 |
| `admin` | 创建并完全控制自己的房间 |
| `user` | 加入房间、评论弹幕 |
| `guest` | 同 user（注册后默认 guest + pending，root 审核通过转 user） |

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

前端构建：`VITE_API_URL`（API / Socket.IO 基址，留空用 `window.location.origin`）、`VITE_FLV_BASE_URL`（OBS 模式 FLV 拉流基址）。

## 构建与更新机制

- **构建**：`build-all.js` 将前后端编译为平台单文件（`zviewer-backend` / `zviewer-cert`），启动脚本模板在 `packaging/`。
- **CI**：push `main` → 构建双平台单文件，Linux 版推 Docker Hub（`0.0.0-dev.<sha>` 预发布）；打 `v*` tag → 正式版 + GitHub Release。
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
