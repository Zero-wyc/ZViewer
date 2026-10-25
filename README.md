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

## Star History

<a href="https://star-history.com/#Zero-wyc/ZViewer&Zero-wyc/ZViewerCLI&Zero-wyc/ZViewerAPP&Date">
 <picture>  
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=Zero-wyc/ZViewer,Zero-wyc/ZViewerCLI,Zero-wyc/ZViewerAPP&type=Date&theme=dark&v=2" />  
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=Zero-wyc/ZViewer,Zero-wyc/ZViewerCLI,Zero-wyc/ZViewerAPP&type=Date&v=2" />  
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=Zero-wyc/ZViewer,Zero-wyc/ZViewerCLI,Zero-wyc/ZViewerAPP&type=Date&v=2" />  
 </picture>  
</a>

## 浏览器要求

> 建议使用 Chrome / Edge 等内核 130+ 的 Chromium 浏览器。Safari 与 Firefox 对 MSE / MKV 解码支持不完整，可能出现卡顿、无法解码、字幕异常。

#### PS：另有正处于开发状态的[Zviewer手机端](https://github.com/Zero-wyc/ZViewerAPP)　|　并由[FredQin](https://github.com/fredqin2006-X)开发

## 目录

- [功能一览](#功能一览)
- [ZViewerCLI](#zviewercli)
- [安装与启动](#安装与启动)
  - [Windows 桌面版（GUI）](#windows-桌面版gui)
  - [单文件版（推荐）](#单文件版推荐)
  - [交互菜单](#交互菜单)
  - [源码](#源码)
  - [端口](#端口)
- [Docker 部署](#docker-部署)
- [部署配置](#部署配置)
  - [环境变量](#环境变量)
  - [语音传输](#语音传输)
- [Windows 桌面控制台（可选）](#windows-桌面控制台可选)

---

## 功能一览

- **一起看**：多人同步观影，房主控播，观众可申请暂停 / 快进
- **视频源**：Bilibili（分 P、清晰度、大会员画质）、MP4 直链、WebDAV / FTP / OpenList、Emby / Jellyfin、服务器本地目录
- **格式兼容**：MKV / AVI / TS / WMV、DTS / AC3 / EAC3 等浏览器不原生支持的格式
- **播放模式**：CLI 本地代理（高画质、不耗服务器流量）、服务器 DASH 转发、MP4 直链（最高 720P），按需切换
- **弹幕与字幕**：B 站官方 / DandanPlay / 本地 XML·JSON（可多轨）；SRT / ASS / SSA / VTT / SMI / SUB
- **互动与推流**：评论、语音聊天（UDP / TCP 通道自动择优，无需手动切换）、WebRTC 屏幕共享、OBS 推流
- **一起听**：网易云音乐 × 哔哩哔哩，歌单自动补位推荐、双收藏夹一键收藏、MV 歌词页背景
- **个性化**：Material You 动态主题、自定义主题色与背景、玻璃拟态、弹幕字幕字号独立调节
- **运维**：一键自动更新，Docker / 单文件版开箱即用

## ZViewerCLI

[ZViewerCLI](https://github.com/Zero-wyc/ZViewerCLI)（Go）是运行在用户本地的代理程序：用你自己的 Bilibili Cookie 在本地解析并代理视频流，让房间内所有人共享大会员画质，且几乎不消耗服务器带宽。适用于既要高画质、又想节省服务器流量的场景（服务器 DASH 转发会大量消耗带宽）。

## 安装与启动

首次启动自动创建 ROOT 管理员：用户名 `root`，密码 `root`。**安装后请立即修改密码。**

### Windows 桌面版（GUI）（Windows用户推荐）

Release 中的 `ZViewer-Windows-<版本>-x64.zip` 是原生桌面控制台（Go + 系统 WebView2），用于管理本机服务、证书、FRP 穿透与高画质代理：

- 解压后双击 `ZViewerDesktop.exe` 即可查看控制台界面，并根据其中提示进行启动
- 内置高画质代理 CLI（`runtime/zviewer-cli-windows-amd64.exe`
- `构建与调试方式见 `desktop/README.md`。

### 单文件版

从 [Releases](https://github.com/Zero-wyc/ZViewer/releases) 下载对应平台压缩包，解压后：

- **Windows**：双击 `start.bat`，进入交互菜单
- **Linux**：执行 `./start.sh`（不带参数），进入交互菜单

在菜单中选择 `1` 启动服务，完成后访问 `http://localhost:3333`。

也可以跳过菜单直接带命令执行，如 `start.bat start` / `./start.sh start`；完整命令见 `start.bat help`。

#### 交互菜单

```text
  1) 启动服务              2) 仅启动后端
  3) 停止服务              4) 重启服务
  5) 查看状态              6) 查看日志
  7) 一键签发 SSL 证书     8) HTTPS 启动（自动签发证书）
  0) 退出
```

| 编号 | 功能       | 说明                                                     |
| -- | -------- | ------------------------------------------------------ |
| 1  | 启动服务     | HTTP 启动，端口取 `.env` 的 `PORT`（默认 3333）                     |
| 2  | 仅启动后端    | 先选 HTTP / HTTPS；跳过前端产物校验，适合前后端分离调试                      |
| 3  | 停止服务     | 按记录的 PID 停止，端口被占用时兜底清理                                 |
| 4  | 重启服务     | 停止后重新启动                                                |
| 5  | 查看状态     | 端口监听、进程 PID、程序与证书是否齐全                                  |
| 6  | 查看日志     | 输出 `log/backend.log` 末 50 行                             |
| 7  | 签发 SSL 证书 | 选 `localhost` 自签，或公网域名 / 公网 IP 申请 Let's Encrypt 证书（需已解析且 80 端口可达；内网 IP 自动回退自签） |
| 8  | HTTPS 启动 | 签发证书后以 HTTPS 启动                                        |
| 0  | 退出       | 只关闭菜单窗口，后台服务继续运行；需要停止请选 `3`                            |

> 每次操作结束后按回车返回菜单。

> **不建议使用命令行自动签发正式证书**：菜单 `7` / `8` 的 Let's Encrypt 签发适合测试，续期、验证失败排查都要自己盯。正式环境建议把域名交给 **Cloudflare、ESA、EdgeOne** 等支持自动签发与续期的边缘服务，或使用 **宝塔、1Panel** 等面板统一申请续期，再反向代理到 ZViewer 的 3333 端口。

### 源码

后端是 Go（`backend-go/`，需要 Go 1.26+），前端是 React + Vite。

```bash
npm install             # 安装前端依赖
npm run build           # 生产构建（Go 后端 + 前端）
npm start               # 启动
```

`npm run build` 会先把 Go 后端编译成 `dist/zviewer-backend(.exe)`，再构建前端产物；
`npm start` 直接拉起该二进制（日志写在 `log/backend.log`）。

开发模式（Go 后端 + Vite HMR，前端默认把 `/api` 代理到 3333）：

```bash
npm run dev             # 同时起后端与前端
npm run dev:backend     # 只起 Go 后端（改 .go 保存即重启）
npm run dev:frontend    # 只起前端

npm run lint:go         # gofmt + go vet
npm run test:go         # go test ./...
npm run test:regression # 全部 Node↔Go 对拍与冒烟（33 个脚本，约 8 分钟）
```

后端热重载由 `scripts/dev-backend.js` 提供（不需要装 air 之类的外部工具）：
监听 `backend-go/**/*.{go,mod,sum}`，先编译到临时产物、**成功之后才换进程**，
所以改到一半带着语法错误保存时旧进程仍在服务，修好保存即自动恢复。
不想要热重载时用 `npm run dev:backend:once`。

或使用脚本完成依赖安装、构建与启动：

```powershell
.\start-prod.bat start    # Windows
./start-prod.sh start     # Linux / macOS
```

支持命令：`start` / `backend` / `stop` / `restart` / `status` / `logs` / `build` / `cert` / `https` / `help`。

### 端口

| 端口     | 用途                                                         |
| -------- | ------------------------------------------------------------ |
| 3333/tcp | 统一入口：HTTP/HTTPS API、WebSocket、前端页面、`/live` FLV 代理 |
| 3333/udp | LiveKit 语音聊天                                             |
| 3334/tcp | OBS 推流                                                     |
| 3335/tcp | HTTP-FLV 拉流（内部，经 3333 的 `/live` 代理，无需对外开放）        |
| 3336/tcp | LiveKit HTTP/信令（内部，经 3333 的 `/rtc` 反代，无需对外开放）    |
| 3337/tcp | 语音 ICE/TCP 直连（默认开启，UDP 被拦时浏览器自动改走此端口）      |
| 3338/tcp | 语音 TURN/TLS 中继（可选，配齐证书三项即启用）                    |

## Docker 部署

> **v4.3.6 以下版本使用 Docker 部署的用户**：请**不要**通过管理面板「基础设置 → 一键更新」升级，请按最新 docker compose 重新部署。

```bash
docker run -d \
  --name zviewer \
  --restart unless-stopped \
  -p 3333:3333 \
  -p 3333:3333/udp \
  -p 3334:3334 \
  -p 3337:3337 \
  -p 3338:3338 \
  -v zviewer-data:/app/config \
  zerowyc0721/zviewer:latest
```

或 docker compose：

```yaml
services:
  zviewer:
    image: zerowyc0721/zviewer:latest
    ports:
      - "3333:3333"      # API + WebSocket + 前端页面 + /live FLV 代理 + /rtc 语音信令反代
      - "3333:3333/udp"  # LiveKit WebRTC 媒体传输
      - "3334:3334"      # RTMP 推流（OBS）
      - "3337:3337"      # 语音 ICE/TCP 直连（默认开启，UDP 被拦时浏览器自动改走）
      - "3338:3338"      # 语音 TURN/TLS 中继（可选，配齐证书三项即启用）
    volumes:
      - zviewer-data:/app/config
    restart: unless-stopped
```

- 请将 `zviewer-data` 替换为实际数据目录
- 镜像标签：`latest` 与 `X.Y` 只在发布正式版本（推送 `vX.Y.Z` tag）时更新，`X.Y.Z` 为固定版本；`dev` 跟随 main 分支最新构建，可能不稳定，仅供尝鲜
- 镜像以 HTTP 模式启动，HTTPS 需自行配置：推荐 Cloudflare、ESA、EdgeOne 等边缘服务，或宝塔、1Panel 等面板自动签发并续期，再反代到 3333（不建议用命令行自助签发正式证书）
- `/app/config` 含数据库（`dev.sqlite`）、证书（`ssl/`）、上传文件（`uploads/`）、推流切片（`media/`）
- Docker 模式下仍可使用网页更新

## 部署配置

### 环境变量

| 变量                       | 说明                                    | 默认值                     |
| ------------------------ | ------------------------------------- | ----------------------- |
| `PORT`                   | 后端端口                                  | `3333`                  |
| `HOST`                   | 监听地址                                  | 空（双栈）                   |
| `CONFIG_DIR`             | 数据根目录                                 | `<project-root>/config` |
| `DATABASE_URL`           | SQLite 文件路径（相对 `CONFIG_DIR` 或绝对路径）      | `<config>/dev.sqlite`   |
| `SQLITE_WAL`             | 日志模式；设 `0` 退回 `journal_mode=delete`      | 启用 WAL                |
| `CORS_ORIGIN`            | CORS 来源，逗号分隔                          | `*`                     |
| `JWT_ACCESS_SECRET`      | Access 密钥（生产必须修改）                     | —                       |
| `JWT_REFRESH_SECRET`     | Refresh 密钥（生产必须修改）                    | —                       |
| `RTMP_PORT`              | RTMP 推流端口                             | `3334`                  |
| `HTTP_FLV_PORT`          | FLV 拉流端口（内部）                          | `3335`                  |
| `LIVEKIT_EXTERNAL`       | `1` 时使用外置 LiveKit，跳过内嵌               | `0`                     |
| `LIVEKIT_NODE_IP`        | ICE 广播地址；NAT 复杂或无出网环境可手动指定公网 IP       | 空（自动 STUN）             |
| `LIVEKIT_BIND`           | LiveKit HTTP/信令监听地址（仅影响 3336，媒体端口不受影响） | 空（双栈全地址）              |
| `LIVEKIT_RTC_TCP_PORT`   | ICE/TCP 直连端口（默认开启；设 `0` 关闭该监听，仅保留 UDP）       | `3337`                  |
| `LIVEKIT_RTC_ADVERTISE_INTERNAL_IP` | 内外网双 IP 候选（`advertise_internal_ip`），`false` 关闭 | `true`         |
| `LIVEKIT_RTC_SKIP_EXTERNAL_IP_VALIDATION` | 跳过外部 IP 自 ping 校验（NAT 不允许自 ping 时开启） | 未设置        |
| `LIVEKIT_TURN_TLS_PORT`  | TURN/TLS 中继端口（与 3337 分开，可同时开启）       | `3338`                  |
| `LIVEKIT_TURN_DOMAIN`    | TURN/TLS 域名                           | —                       |
| `LIVEKIT_TURN_CERT`      | TURN TLS 证书路径                         | —                       |
| `LIVEKIT_TURN_KEY`       | TURN TLS 私钥路径                         | —                       |

### 语音传输

- 通道不设开关：服务端同时发布 `3333/udp`（低延迟直连）与 `3337/tcp`（ICE/TCP 直连）两条候选，浏览器 ICE 自动择优——UDP 直连 > TCP 直连 > TURN 中继；UDP 被运营商 / 企业防火墙或代理拦截时自动改走 3337，管理端不提供也不需要切换
- 想彻底关闭 3337 监听（只开放 UDP 端口）时设 `LIVEKIT_RTC_TCP_PORT=0`。必须显式写 0——留空或删除会让 LiveKit 回落到默认 7881，而 7881 未做端口映射，客户端只会拿到必然连不上的候选
- 内外网双通：默认开启 `advertise_internal_ip`，同时广播映射后的外网 IP 与本地网卡 IP，内网与外网用户各自选中可达的那条。bridge 网络下本地 IP 是容器 172.x，对局域网客户端不可达；需要内网直连时改用 host 网络（去掉 compose 的 `ports` 段、加 `network_mode: host`），并用 `LIVEKIT_CONFIG` 的 `rtc.interfaces.includes: [eth0]` 限定网卡。NAT 不允许自 ping 时再加 `LIVEKIT_RTC_SKIP_EXTERNAL_IP_VALIDATION=true`
- 配齐 `LIVEKIT_TURN_*` 三项时，还会在 3338/tcp 开启 TURN/TLS 中继（需正式证书，穿透代理/多层 NAT 能力最强）。3337 与 3338 是两条独立通道，可并存，客户端自动择优：UDP 直连 > TCP 直连 > TURN 中继
- 纯内网 / 特殊 NAT 环境 STUN 探测失败时，用 `LIVEKIT_NODE_IP` 指定服务器公网 IP
- 排障：语音面板在媒体通道未建立时显示「媒体连接中…」，超过 10 秒会给出网络提示。进房成功但没声音，通常是媒体通道没通（代理 TUN 或防火墙吞掉 UDP），可先关掉代理 / VPN 再试

**内网与外网同时直连（推荐 host 网络）**

bridge 网络下只有映射后的地址可达，局域网用户常因路由器不支持 NAT 回环（hairpin）而连不上。需要两侧都直连时改用 host 网络，并把网卡限死：

```yaml
services:
  zviewer:
    image: zerowyc0721/zviewer:latest
    network_mode: host          # 去掉原 ports 段：3333、3333/udp、3334、3337、3338 直接监听宿主
    environment:
      LIVEKIT_BIND: "127.0.0.1"                          # 信令只绑本机（外部统一走 3333 反代）
      LIVEKIT_RTC_USE_EXTERNAL_IP: "true"
      LIVEKIT_RTC_ADVERTISE_INTERNAL_IP: "true"
      LIVEKIT_RTC_SKIP_EXTERNAL_IP_VALIDATION: "true"   # NAT 不允许自 ping 时再加
      LIVEKIT_CONFIG: |-
        rtc:
          interfaces:
            includes: [eth0]
    volumes:
      - ./config:/app/config
    restart: unless-stopped
```

host 网络没有端口映射，`LIVEKIT_BIND: "127.0.0.1"` 用来把 LiveKit 自身的 HTTP/信令端口（3336）收回本机，外部只经 3333 的 `/rtc` 反代进入。它**只作用于信令**：媒体端口（`3333/udp`、`3337/tcp`、`3338/tcp`）仍监听全部网卡，不影响内外网直连。

`interfaces.includes` 用于排除 docker0、veth、tailscale 等接口，避免广播一批必然不可达的候选。网卡名必须与宿主机实际一致（`ip -br addr` 查看，云主机常见 `eth0` / `ens18` / `enp3s0`）；写错会枚举不到任何 ICE 候选，语音直接连不上——拿不准就先删掉这段，让 LiveKit 自动枚举。
- 需要 TURN/TLS 中继时，配置 `LIVEKIT_TURN_DOMAIN` / `LIVEKIT_TURN_CERT` / `LIVEKIT_TURN_KEY` 三项即可（compose 已含 `3338:3338` 映射，需放行 3338/tcp）

## Windows 桌面控制台（可选）

Windows 用户可构建原生目录 GUI（Go + 系统 WebView2，无需安装运行时，也不依赖 Electron），双击分发目录唯一的 `ZViewerDesktop.exe` 打开控制台，运行包放在同级 `runtime/`。控制台提供系统托盘、本机 HTTPS、自建 FRP、可保存的监听端口，以及直接在窗口内配置和扫码登录的 ZViewerCLI 高画质代理。构建和使用步骤见 [desktop/README.md](desktop/README.md)，现有服务端网页与命令行源码保持兼容。
