

# ZViewer

> 多人同步观影、追番与远程共享平台。

ZViewer 让一群人在不同地点也能像坐在一起一样看番、看电影。房主控制播放进度，观众实时跟随；支持 Bilibili、WebDAV、FTP、OpenList、MP4 直链等多种视频源，并内置屏幕共享、弹幕、评论、语音聊天等互动能力。

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
  <img src="https://img.shields.io/github/last-commit/Zero-wyc/ZViewer?style=flat-square&logo=github&label=Last%20Commit&labelColor=333&color=inactive" alt="Last Commit">
  <img src="https://img.shields.io/github/languages/top/Zero-wyc/ZViewer?style=flat-square&logo=typescript&labelColor=333&color=3178C6" alt="Top Language">
  <a href="https://t.me/Zero_251">
    <img src="https://img.shields.io/badge/Telegram-26A5E4?style=flat-square&logo=telegram&logoColor=white" alt="Telegram">
  </a>
</p>

---

## 目录

- [功能特性](#功能特性)
- [快速开始](#快速开始)
- [部署方式](#部署方式)
- [端口说明](#端口说明)
- [HTTPS 与证书](#https-与证书)
- [Docker 部署](#docker-部署)
- [GitHub Actions 自动构建](#github-actions-自动构建)
- [本地开发](#本地开发)
- [环境变量](#环境变量)
- [权限模型](#权限模型)
- [视频源](#视频源)
- [ZViewerCLI 本地代理](#zviewercli-本地代理)
- [常见问题](#常见问题)

---

| ![](https://github.cdn.zero251.xyz/Zero-wyc/Image/main/All/20260804013054107.webp) | ![](https://github.cdn.zero251.xyz/Zero-wyc/Image/main/All/20260804013133193.webp) |
| ------------------------------------------------------------ | ------------------------------------------------------------ |
| ![](https://github.cdn.zero251.xyz/Zero-wyc/Image/main/All/20260804013107507.webp) | ![](https://github.cdn.zero251.xyz/Zero-wyc/Image/main/All/20260804013127227.webp) |

## 功能特性

### 一起看房间

- 创建或加入房间，与好友同步观看。
- 房主拥有播放控制权：播放、暂停、跳转、倍速。观众可申请控制，房主确认后执行。
- 播放记忆：房主短暂断线后，由服务器继续广播当前状态，观众无需中断观看。
- 房主离线超时自动关房（10 分钟），期间观众可自由控制。

### 多源视频解析

| 来源 | 说明 |
|---|---|
| **Bilibili** | 解析 BV 号或视频链接，支持 DASH 音视频合并、清晰度切换、大会员凭证 |
| **MP4 直链** | 直接播放可访问的 MP4 视频地址 |
| **WebDAV** | 挂载 WebDAV 服务器，浏览并播放其中的视频文件 |
| **FTP** | 挂载 FTP 服务器，浏览并播放其中的视频文件 |
| **OpenList** | 挂载 OpenList 服务，浏览并播放其中的视频文件 |

### 实时互动

- 评论面板与弹幕系统：支持 Bilibili 官方弹幕、DandanPlay 弹幕、自定义弹幕轨道。
- 播放状态同步：房主操作实时同步给所有观众。
- 观众申请：观众可申请跳转进度或暂停，房主在播放器左上角查看通知。
- 语音聊天：房主可配置语音比特率（32/96/128/192 kbps），观众实时收听。

### 屏幕共享与推流

- 基于 WebRTC 的屏幕共享，分享端可共享屏幕或视频画面。
- OBS RTMP 推流支持，配合 Node Media Server 提供 HTTP-FLV 拉流。

### 主题系统

- Material You (Monet) 动态主题，从壁纸提取色彩生成完整色板。
- 明暗主题切换、自定义背景、玻璃拟态 UI、精简动画模式。

---

## 快速开始

系统首次启动时自动创建超级管理员账号：用户名 `root`，密码 `root`。生产环境部署后请立即修改默认密码。

### 单文件版（推荐）

无需安装 Node.js / npm，直接下载 [Releases](https://github.com/Zero-wyc/ZViewer/releases) 中的压缩包，解压后运行：

```bash
# Windows
start.bat              # 交互菜单
start.bat start        # 启动服务

# Linux
./start.sh             # 交互菜单
./start.sh start       # 启动服务
```

### 源码版一键启动

项目根目录的 `start-prod` 脚本会自动检测并安装依赖、按需构建、启动服务。

**Windows**：

```powershell
.\start-prod.bat              # 交互菜单
.\start-prod.bat start        # 启动（HTTP 前后端）
.\start-prod.bat stop         # 停止服务
.\start-prod.bat status       # 查看状态
.\start-prod.bat cert         # 签发 SSL 证书
.\start-prod.bat https        # 签发证书 + HTTPS 启动
```

**Linux / macOS**：

```bash
./start-prod.sh               # 交互菜单
./start-prod.sh start
./start-prod.sh stop
./start-prod.sh status
```

启动后访问 `http://localhost:4173`（HTTP 模式）或 `https://localhost:3333`（HTTPS 模式）。

### 一键启动脚本详解

源码版（`start-prod.*`）与单文件版（`start.bat` / `start.sh`）功能一致，均提供交互菜单与命令行两种模式。

交互菜单：

```
========================================
  ZViewer 服务管理
========================================
  1) 启动服务 (HTTP)
  2) 仅启动后端（可选 HTTP / HTTPS）
  3) 停止服务
  4) 重启服务
  5) 查看状态
  6) 查看日志
  7) 一键签发 SSL 证书
  8) HTTPS 启动（自动签发证书）
  9) 构建前后端（源码版）
  0) 退出
```

命令行用法：

| 命令 | 说明 |
|---|---|
| `start` | 启动服务（HTTP 前后端；加 `-Https` 使用 HTTPS 单进程模式） |
| `backend` | 仅启动后端（可选 HTTP/HTTPS） |
| `cert [host]` | 签发 SSL 证书，host 缺省时交互选择类型 |
| `https [host]` | 签发证书后以 HTTPS 启动（仅后端，后端统一提供前端页面） |
| `stop` / `restart` | 停止 / 重启服务 |
| `status` | 查看运行状态（PID、端口监听、证书状态） |
| `logs [backend\|frontend]` | 查看日志（默认 backend） |
| `build` | 构建前后端（源码版） |
| `help` / `menu` | 帮助 / 交互菜单 |

---

## 端口说明

| 服务 | 端口 | 说明 |
|---|---|---|
| 后端 REST API + WebSocket | 3333 | HTTP / HTTPS API 及 Socket.IO 实时通信 |
| 前端静态文件服务 | 4173 | HTTP 模式下的前端页面，含 API 反向代理 |
| RTMP 推流 | 3334 | OBS 推流端口 |
| HTTP-FLV 拉流 | 3335 | 直播流播放（Node Media Server） |

HTTP 模式下，用户通过 `http://localhost:4173` 访问前端页面，前端通过反向代理将 `/api`、`/socket.io`、`/live` 请求转发到后端，无需单独配置跨域。

---

## HTTPS 与证书

### 签发类型

证书工具（`zviewer-cert`，源码为 `scripts/generate-cert.js`）按地址类型自动选择签发方式：

| 地址类型 | 证书 | 说明 |
|---|---|---|
| `localhost` | 自签证书 | SAN 含 `localhost`、`127.0.0.1`、`::1`，10 年有效 |
| 域名（如 `example.com`） | **Let's Encrypt 可信 CA 证书** | 通过内置 ACME 客户端自动申请，浏览器不报警告 |
| 公网 IP（如 `1.2.3.4`） | **Let's Encrypt 可信 CA 证书** | 2025 年起 Let's Encrypt 支持 IP 证书，通过 ACME 自动申请 |
| 内网 IP（如 `192.168.1.1`） | 自签证书 | SAN 写入 IP 条目 |

### 命令行签发

```bash
# 域名 → 自动申请 Let's Encrypt 可信证书
start.bat cert example.com
./start.sh cert example.com

# 公网 IP → 自动申请 Let's Encrypt 可信证书
start.bat cert 1.2.3.4

# 内网 IP → 自签证书
start.bat cert 192.168.1.1

# 强制重新签发
start.bat cert example.com --force
```

HTTPS 模式下后端运行在 `https://localhost:3333`，前端单独运行在 `http://localhost:4173`，前端代理请求到 HTTPS 后端。

### 申请 Let's Encrypt 证书的前置条件

1. 域名已解析到本机公网 IP，或公网 IP 直接指向本机。
2. 本机 **80 端口**空闲且防火墙/安全组放行（ACME HTTP-01 验证）。
3. 正式环境有速率限制（每域名每周 5 张），调试可用 `--staging` 测试环境。

证书文件位于 `config/ssl/`（`cert.pem` 证书链、`key.pem` 私钥、`acme-account.key` ACME 账号）。

---

## Docker 部署

Docker 镜像使用 HTTP 模式启动，分别运行后端和前端两个进程，不自动签发证书。如需 HTTPS，建议在 Docker 前加一层反向代理（Nginx / Caddy）。

### docker run

```bash
docker run -d \
  --name zviewer \
  -p 4173:4173 \
  -p 3333:3333 \
  -p 3334:3334 \
  -p 3335:3335 \
  -v zviewer-data:/app/config \
  zerowyc0721/zviewer:latest
```

### Docker Compose

创建 `docker-compose.yml`：

```yaml
services:
  zviewer:
    image: zerowyc0721/zviewer:latest
    ports:
      - "3333:3333"   # 后端 API + WebSocket
      - "4173:4173"   # 前端页面
      - "3334:3334"   # RTMP 推流 (OBS)
      - "3335:3335"   # HTTP-FLV 拉流
    volumes:
      - zviewer-data:/app/config
    restart: unless-stopped

volumes:
  zviewer-data:
```

然后启动：

```bash
docker compose up -d
```

### 自行构建

如需自行构建镜像，项目已包含 `Dockerfile.linux-single` 和 `docker-compose.linux-single.yml`（使用 `build` 而非 `image`），构建方法：

```bash
docker build -t zviewer -f Dockerfile.linux-single .
docker compose -f docker-compose.linux-single.yml up -d
```

### 访问

用户通过浏览器访问 `http://localhost:4173` 即可使用全部功能。OBS 推流直连 `rtmp://localhost:3334/live`。

### 数据持久化

`/app/config` 目录挂载 volume，包含：

| 路径 | 内容 |
|---|---|
| `/app/config/dev.sqlite` | 数据库 |
| `/app/config/ssl/` | SSL 证书 |
| `/app/config/uploads/` | 用户上传文件 |
| `/app/config/media/` | NMS 推流媒体切片 |

---

## GitHub Actions 自动构建

每次 push 到 `main` 分支或打 tag（`v*`）时，自动完成：

1. **构建 Linux 单文件版** → 上传 artifact + 推送到 Docker Hub（`zerowyc0721/zviewer`）。
2. **构建 Windows 单文件版** → 上传 artifact。
3. 打 tag 时自动创建 GitHub Release，包含两个平台的压缩包。

### 版本管理

| 触发方式 | 版本号 | 示例 |
|---|---|---|
| 推送 tag `v1.0.0` | 正式版 | `1.0.0` |
| 推送 `main` 分支 | 开发版（预发布） | `0.0.0-dev.a1b2c3d` |
| 手动触发 | 手动构建 | `0.0.0-manual` |

管理员可在管理后台通过开关控制是否接收预发布版本更新。

### 构建产物

| 平台 | 压缩包 | 说明 |
|---|---|---|
| Linux | `zviewer-linux-x64.tar.gz` | 含 `zviewer-backend`、`zviewer-frontend`、`zviewer-cert`、`start.sh` |
| Windows | `zviewer-windows-x64.zip` | 含 `zviewer-backend.exe`、`zviewer-frontend.exe`、`zviewer-cert.exe`、`start.bat` |
| Docker | `zerowyc0721/zviewer:latest` | Linux 单文件版的 Docker 镜像，自动推送到 Docker Hub |

---

## 本地开发

项目使用 npm workspaces，根目录统一安装依赖。

```bash
# 安装全部依赖
npm install

# 同时启动前后端开发服务
npm run dev

# 或分别启动
npm run dev:backend
npm run dev:frontend
```

开发端口：

- 前端：`http://localhost:5174`
- 后端：`http://localhost:3333`

前端开发时默认通过 Vite 代理连接后端，无需额外配置 `VITE_API_URL`。

### 项目结构

```
ZViewer/
├── backend/          # Express 后端（TypeScript + TypeORM + sql.js）
│   └── src/
│       ├── routes/          # REST API 路由
│       ├── services/        # 业务逻辑（B站解析、代理、更新等）
│       ├── modules/         # 模块化架构（房间、观众、同步等）
│       ├── entities/        # TypeORM 实体
│       └── middleware/      # 鉴权中间件
├── frontend/         # React 前端（Vite + Tailwind CSS）
│   └── src/
│       ├── pages/           # 页面组件
│       ├── components/      # 通用 UI 组件
│       ├── modules/         # 功能模块
│       └── store/           # Zustand 状态管理
├── frontend-server/  # 前端静态文件服务（零外部依赖）
├── docker/           # Docker 入口脚本
├── packaging/        # 启动脚本模板
├── dist/             # 构建产物
└── build-all.js      # 单文件编译脚本
```

---

## 环境变量

### 后端

| 变量 | 说明 | 默认值 |
|---|---|---|
| `PORT` | 后端服务端口 | `3333` |
| `HOST` | 监听地址 | 空（双栈监听） |
| `NODE_ENV` | 运行环境 | `production` |
| `DATABASE_URL` | SQLite 文件路径或 PostgreSQL 连接串 | `<config>/dev.sqlite` |
| `CONFIG_DIR` | 数据根目录 | `<project-root>/config` |
| `CORS_ORIGIN` | CORS 允许来源，多个用逗号分隔 | `*` |
| `JWT_ACCESS_SECRET` | Access Token 密钥（生产必须修改） | — |
| `JWT_REFRESH_SECRET` | Refresh Token 密钥（生产必须修改） | — |
| `JWT_ACCESS_EXPIRES_IN` | Access Token 有效期 | `1h` |
| `JWT_REFRESH_EXPIRES_IN` | Refresh Token 有效期 | `30d` |
| `RTMP_PORT` | RTMP 推流端口 | `3334` |
| `HTTP_FLV_PORT` | HTTP-FLV 拉流端口 | `3335` |

### 前端构建

| 变量 | 说明 | 默认值 |
|---|---|---|
| `VITE_API_URL` | API / Socket.IO 基础地址，留空时使用 `window.location.origin` | — |
| `VITE_FLV_BASE_URL` | OBS 推流模式 HTTP-FLV 拉流基础地址 | — |

---

## 权限模型

系统采用四层权限模型：

| 角色 | 说明 | 权限 |
|---|---|---|
| `root` | 超级管理员 | 创建/控制/删除任意房间，审核用户，修改角色，管理后台 |
| `admin` | 管理员 | 创建房间并完全控制自己的房间，不能删除他人房间 |
| `user` | 普通用户 | 加入房间观看、发送评论与弹幕，无法创建房间 |
| `guest` | 游客 | 加入房间观看、发送评论与弹幕，无法创建房间 |

新用户注册后角色为 `guest`，状态为 `pending`。仅 `root` 可在管理后台审核通过用户，通过后升级为 `user`。

---

## 视频源

### Bilibili

解析 BV 号或视频链接，支持 DASH 音视频合并播放、清晰度切换、大会员专享内容。可在管理后台配置 Bilibili 登录凭证以获取大会员清晰度。

### 直链与挂载

- **MP4 直链**：直接输入可访问的 MP4 视频地址播放。
- **WebDAV / FTP / OpenList**：在挂载点管理中保存连接配置，浏览目录并播放视频文件。

---

## ZViewerCLI 本地代理

[ZViewerCLI](https://github.com/Zero-wyc/ZViewerCLI) 是一个可选的本地代理客户端，用于解决浏览器端无法直接使用用户 Bilibili Cookie 与高画质地址的问题：

- 使用用户本地 Cookie 解析 Bilibili 视频，获取大会员等高画质地址。
- 在本地代理视频流请求，注入正确的 Referer/Origin/User-Agent，绕过 CDN 防盗链与 CORS 限制。
- 通过 WebSocket 向房间注册，前端自动检测并使用本地代理。

---

## 常见问题

### 自签证书浏览器提示"不安全"

`localhost` 与内网 IP 使用自签证书，浏览器会提示"证书颁发机构不受信任"。解决方法：

- 将 `config/ssl/cert.pem` 导入客户端"受信任的根证书颁发机构"；或
- 使用域名或公网 IP 并通过 Let's Encrypt 申请可信证书。

### WebSocket 连接失败

确认反向代理（Nginx 等）已正确配置 WebSocket 升级头：

```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
```

### WebRTC 无法建立连接

WebRTC 的 `getUserMedia` 要求 HTTPS 访问。生产环境请配置 SSL 证书。若双方处于严格 NAT 之后，可能需要部署 TURN 服务器（如 coturn）。

### 数据库说明

后端使用 TypeORM + sql.js（wasm 版 SQLite）持久化，纯 JS 实现、无原生模块——单文件版可在任意平台直接运行，无需编译。数据库文件为标准 SQLite 格式（`config/dev.sqlite`），可用常规 SQLite 工具查看。

### Bilibili 解析失败

- 检查后端是否正确携带 Referer 等请求头。
- 封面与视频地址通过后端代理获取，避免 CORS 与防盗链问题。
- 大会员专享内容需在后台配置有效的 Bilibili 登录凭证，或使用 ZViewerCLI 本地代理。

### 更新机制

系统支持从 GitHub Releases 自动检测并应用更新，也支持手动上传压缩包更新。管理员可在管理后台控制是否接收预发布版（main 分支自动构建）的更新。
