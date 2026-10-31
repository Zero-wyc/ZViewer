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

## 这玩意能干嘛

> 本来是嫌 SYNCTV 一起看 B 站的画质太烂，想自己搞一个
>
> 结果随便一搓，一个暑假就没了

- **一起看**：多人同步，房主控播，观众能申请暂停 / 快进
- **视频源**：Bilibili（含大会员画质）、MP4 直链、WebDAV / FTP / OpenList、Emby / Jellyfin、服务器本地目录
- **格式**：MKV / AVI / TS / WMV，DTS / AC3 / EAC3 音轨都能啃
- **弹幕与字幕**：B 站、DandanPlay、本地文件；多轨字幕，字号单独调
- **语音与共享**：内嵌 LiveKit，顺带 WebRTC 屏幕共享
- **OBS 推流**：房间内 RTMP 推流 + 低延迟分发
- **一起听**：网易云 × 哔哩哔哩，歌单自动补位、双收藏夹一键收藏
- **省带宽**：配 [ZViewerCLI](https://github.com/Zero-wyc/ZViewerCLI) 走本地代理，用你自己的 B 站 Cookie 取流，全房间共享大会员画质，服务器几乎不占带宽
- **界面**：Material You、自定义背景、玻璃拟态
- **部署**：Docker / 单文件版开箱可用，带一键自动更新

> 浏览器建议 Chrome / Edge 130+。Safari 和 Firefox 对 MSE / MKV 支持不全，会卡，字幕也容易抽风。

## 装起来

首次启动自动建管理员 `root` / `root`，**登录后第一件事就是改密码**。

| 你要哪个 | 下哪个 | 怎么跑 |
| --- | --- | --- |
| Windows 桌面版（推荐） | [zviewer-windows-x64-GUI.zip](https://github.com/Zero-wyc/ZViewer/releases/download/latest/zviewer-windows-x64-GUI.zip) | 解压，双击 `ZViewerDesktop.exe` |
| Windows 单文件 | [zviewer-windows-x64.zip](https://github.com/Zero-wyc/ZViewer/releases/download/latest/zviewer-windows-x64.zip) | 跑 `start.bat` |
| Linux | [zviewer-linux-x64.tar.gz](https://github.com/Zero-wyc/ZViewer/releases/download/latest/zviewer-linux-x64.tar.gz) | 跑 `./start.sh` |

Docker 版：

```bash
docker run -d --name zviewer --restart unless-stopped \
  -p 3333:3333 -p 3333:3333/udp -p 3334:3334 -p 3337:3337 -p 3338:3338 \
  -v zviewer-data:/app/config \
  zerowyc0721/zviewer:latest
```

起来以后访问 `http://localhost:3333`。想锁版本去 [Releases](https://github.com/Zero-wyc/ZViewer/releases) 挑具体版本号：`latest` 和 `X.Y` 只在推 `vX.Y.Z` 时更新，`X.Y.Z` 固定不动，`dev` 跟 main 走。

> v4.3.6 以前用 Docker 部署的，别走面板「一键更新」，照上面重新起一遍

容器里是 HTTP 起的。HTTPS 别折腾容器，交给 Cloudflare、ESA、EdgeOne，或者用宝塔 / 1Panel 反代到 3333。`/app/config` 存数据库、`ssl/`、`uploads/`，`media/` 是预留给推流的，实际不落盘。

## 部署与配置

> 自建部署基本就是这几张表的事：端口开对、密钥改掉、语音别被网络卡住

### 端口

| 端口 | 干嘛的 | 要对外开放吗 |
| --- | --- | --- |
| 3333/tcp | HTTP/HTTPS、WebSocket、前端页面、`/live` FLV 代理、`/rtc` 语音信令反代 | **要** |
| 3333/udp | LiveKit 语音媒体 | **要** |
| 3337/tcp | 语音 ICE/TCP 直连（UDP 被拦时自动改走） | **要** |
| 3334/tcp | OBS RTMP 推流 | 需要推流时 |
| 3338/tcp | 语音 TURN/TLS 中继 | 配齐证书三项时 |
| 3335/tcp | HTTP-FLV 拉流 | 内部 |
| 3336/tcp | LiveKit 信令 | 内部 |

### 环境变量

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `PORT` | 后端端口 | `3333` |
| `HOST` | 监听地址 | 空（双栈） |
| `CONFIG_DIR` | 数据根目录 | `<项目根>/config` |
| `DATABASE_URL` | SQLite 路径（相对 `CONFIG_DIR`） | `<config>/dev.sqlite` |
| `SQLITE_WAL` | 设 `0` 退回 `journal_mode=delete` | 启用 WAL |
| `CORS_ORIGIN` | 允许来源，逗号分隔 | `*` |
| `JWT_ACCESS_SECRET` | Access 密钥（生产必改） | 自动生成 |
| `JWT_REFRESH_SECRET` | Refresh 密钥（生产必改） | 自动生成 |
| `RTMP_PORT` | RTMP 推流端口 | `3334` |
| `HTTP_FLV_PORT` | FLV 拉流端口（内部） | `3335` |
| `NMS_BIND` | 内置媒体服务监听地址 | `0.0.0.0` |
| `NMS_HTTP_FLV_URL` | 指向外部媒体服务，设了就不再内嵌 | 空 |
| `LIVEKIT_EXTERNAL` | `1` 使用外置 LiveKit | `0` |
| `LIVEKIT_NODE_IP` | ICE 广播的公网 IP | 空（STUN） |
| `LIVEKIT_BIND` | LiveKit 信令监听地址 | 空（全地址） |
| `LIVEKIT_RTC_TCP_PORT` | ICE/TCP 端口，`0` 关闭该通道 | `3337` |
| `LIVEKIT_RTC_ADVERTISE_INTERNAL_IP` | 内外网双 IP 候选 | `true` |
| `LIVEKIT_RTC_SKIP_EXTERNAL_IP_VALIDATION` | 跳过外部 IP 自 ping | 未设置 |
| `LIVEKIT_TURN_TLS_PORT` | TURN/TLS 端口 | `3338` |
| `LIVEKIT_TURN_DOMAIN` | TURN 域名 | — |
| `LIVEKIT_TURN_CERT` | TURN 证书路径 | — |
| `LIVEKIT_TURN_KEY` | TURN 私钥路径 | — |
| `EMBY_CLIENT_NAME` | Emby / Jellyfin 客户端标识 | `ZViewer` |

### 语音

- 服务端同时开 `3333/udp` 和 `3337/tcp`，浏览器自己挑：UDP 直连 > TCP 直连 > TURN 中继，不用手动切
- 想彻底关掉 3337 必须显式写 `LIVEKIT_RTC_TCP_PORT=0`，留空会掉回一个没映射的 7881
- 进房成功但没声音，八成是 UDP 被代理或者防火墙吞了，先关代理再试

#### 内网外网都要直连（host 网络）

bridge 下局域网用户经常连不上，因为路由器不做 NAT 回环。换 host，再把网卡限死：

```yaml
services:
  zviewer:
    image: zerowyc0721/zviewer:latest
    network_mode: host          # 去掉 ports 段，直接监听宿主
    environment:
      LIVEKIT_BIND: "127.0.0.1"                          # 信令只绑本机，外部走 3333 反代
      LIVEKIT_RTC_ADVERTISE_INTERNAL_IP: "true"
      LIVEKIT_RTC_SKIP_EXTERNAL_IP_VALIDATION: "true"   # NAT 不允许自 ping 时加
      LIVEKIT_CONFIG: |-
        rtc:
          interfaces:
            includes: [eth0]
    volumes:
      - ./config:/app/config
    restart: unless-stopped
```

`includes` 里的网卡名得和宿主机对上（`ip -br addr` 看，云主机多是 `eth0` / `ens18`）。写错就枚举不到 ICE 候选，语音直接连不上，拿不准先把这段删了。

### 推流与一起听

两项都不用装额外服务。OBS 里服务器填 `rtmp://<地址>:3334/live`，推流码用房间页面给的。

一起听的网易云接口是后端自带的，没有可配项。取不到数据只会是网易云那边风控 / 地区 / 版权，日志前缀 `[ncm]`，不影响观影、语音和推流。

要换成外部媒体服务（SRS、node-media-server）就设 `NMS_HTTP_FLV_URL`，后端不再监听 3334/3335。

### 交互菜单（单文件版）

`start.bat` / `./start.sh` 不带参数进菜单，也可以直接带命令，比如 `./start.sh start`，完整列表看 `start.bat help`。

| 编号 | 功能 | 说明 |
| --- | --- | --- |
| 1 | 启动服务 | HTTP 启动，端口取 `.env` 的 `PORT` |
| 2 | 仅启动后端 | 先选 HTTP / HTTPS，跳过前端产物校验 |
| 3 | 停止服务 | 按 PID 停，端口被占用时兜底清理 |
| 4 | 重启服务 | 停止后重新启动 |
| 5 | 查看状态 | 端口、PID、程序与证书是否齐全 |
| 6 | 查看日志 | 输出 `log/backend.log` 末 50 行 |
| 7 | 签发 SSL 证书 | `localhost` 自签，或域名 / 公网 IP 申请 Let's Encrypt |
| 8 | HTTPS 启动 | 签发后以 HTTPS 启动 |
| 0 | 退出 | 只关菜单，后台服务继续跑 |

> 7 / 8 的自动签发适合测试。正式环境还是交给 Cloudflare、ESA、EdgeOne 或宝塔 / 1Panel 签，再反代到 3333

### 从 4.x 升到 5.x

首次启动会自动清掉 Node 时代的遗留文件（`zviewer-frontend.exe`、`zviewer-cert`、`node_modules/`、`backend/`、`config/media` 里的推流切片），日志会打 `[cleanup] 已清理 v4 遗留文件 …`。`config/` 下的数据库、证书、上传文件一个都不动。

## 桌面端（Windows）

`ZViewerDesktop.exe` 是 Go + WebView2 的原生壳（Wails v2，没有 Electron，不用装运行时）。业务还在网页端，壳负责托管后端和网络入口。

| 能力 | 说明 |
| --- | --- |
| 托盘与单实例 | 关窗驻留托盘；同一用户再双击只唤回已有窗口 |
| 进程托管 | 一键启停后端 / LiveKit / ZViewerCLI；首次启动缺库自动 `--init-db`（`root` / `root`，登录后改） |
| 端口与 HTTPS | 端口可改并持久化；可为 localhost 签发证书 |
| 外网访问 | IPv6 直连、服务商 FRP、自建 FRP（导出 `frpc.toml`）、EasyTier 组网、Cloudflare Tunnel 一键隧道 |
| 高画质代理 | 内置 ZViewerCLI，默认 `9333`，只监听 `127.0.0.1`，扫码登录，可随服务启动 |
| 按需组件 | cloudflared / frpc / EasyTier / LiveKit 首次用到才下载，安装包不带 |
| 自动更新 | 启动 6 秒后查一次，之后每 6 小时；流式下载 + 结构校验 + 覆盖重启 |
| 日志 | 按 voice / tunnel / cli / update 分类、级别、关键字过滤，界面留最近 500 条 |

隧道和 IPv6 的实现约定见 [IMPLEMENTATION-CLOUDFLARE-TUNNEL.md](desktop/IMPLEMENTATION-CLOUDFLARE-TUNNEL.md)。

### 目录布局

| 位置 | 内容 |
| --- | --- |
| `ZViewerDesktop.exe` | GUI 入口 |
| `assets/ZViewer.ProcessHost.exe` | 进程监管宿主 |
| `runtime/` | 后端、LiveKit、CLI、网页；组件也下载到这里 |
| `runtime/.env`、`runtime/config` | 后端环境与业务数据 |
| `%APPDATA%/ZViewerDesktop` | GUI 设置、证书、FRP 凭据、日志 |
| `%USERPROFILE%/.zviewer/config.json` | ZViewerCLI 登录配置 |

整个文件夹可以直接搬走，不用安装。更新前先退出控制台，备份 `.env`、`config` 和用户配置目录。

### 构建

Go 1.26+、Node.js 22+、Python 3.11+（打包用），外加系统自带的 C# 编译器（编进程监管宿主）。

```powershell
node build-all.js --win               # 先生成 Windows 运行包
npm --prefix desktop run shell:build  # build/bin/ZViewerDesktop.exe（--console 看日志）
npm --prefix desktop run shell:dist   # dist-gui/
npm --prefix desktop run package      # ZIP + SHA256
```

界面文件是 `go:embed` 编进 EXE 的，改完 `desktop/ui/` 必须重编（调试用 `npm --prefix desktop run preview`）。自检：`cd desktop && go vet ./... && go test ./...`。

```text
zviewer-windows-x64-GUI/
  ZViewerDesktop.exe                # 唯一启动入口
  assets/ZViewer.ProcessHost.exe    # 进程监管宿主
  runtime/                          # 后端、LiveKit、CLI、网页
  许可证、BUILD-MANIFEST.json
```

别直接 `cd desktop && go build -tags production .`，会把已入库的 `desktop/desktop.exe` 覆盖掉。

### 第三方组件

| 组件 | 版本 | 许可证 | 位置 |
| --- | --- | --- | --- |
| [frp](https://github.com/fatedier/frp) 客户端 | 0.71.1 | Apache-2.0 | 按需下载到 `runtime/frpc.exe` |
| [EasyTier](https://github.com/EasyTier/EasyTier) | 2.6.4 | LGPL-3.0 | 按需下载到 `runtime/mesh/` |
| [ZViewerCLI](https://github.com/Zero-wyc/ZViewerCLI) | 0.2.1 | MIT | 随包 `runtime/zviewer-cli-windows-amd64.exe` |
| [LiveKit](https://github.com/livekit/livekit) server | 1.13.7 | Apache-2.0 | 按需下载到 `runtime/livekit-server.exe` |

都是原样分发的未修改二进制，各自留着许可证：frp / EasyTier 在 `assets/LICENSE-*.txt`，LiveKit 和 CLI 跟着 `runtime/` 走。

## 开发

> 面向改这个仓库的人

- **两个独立 Go module，根目录没有 module**：`backend-go/`（`zviewer/backend`）和 `desktop/`（`zviewer/desktop`），各编各的，不共享 internal 包
- 前端 SPA 生产由 Go 托管；开发时 Vite 跑 5174，把 `/api`、`/socket.io`、`/live` 反代到 3333
- 语音是内嵌的 LiveKit 伴生进程，推流和一起听都在后端进程里，不依赖外部服务
- `config/` 不入库（数据库、证书、上传、推流切片），新克隆必须跑 `npm run db:init`

拉下来先 `npm install && npm run db:init`，开发用 `npm run dev`（热重载），跑生产版就 `npm run build && npm start`。

| 依赖 | 版本 |
| --- | --- |
| Go | 1.26+（桌面壳 1.25+） |
| Node.js | 22+ |
| npm | 10+ |
| Git Bash | 只有 Windows 需要，跑 `backend-go/scripts/*.sh` |

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

后端换端口用 `PORT`，前端指过去用 `VITE_API_TARGET`；开发时 Vite 是 5174，其余端口见上面的[端口](#端口)。

回归脚本各自管一块（`route-parity`、`events-parity`、`bilibili-smoke`、`frontend-smoke`、`soak` 等），都用库副本，不碰 `config/dev.sqlite`。单个跑：`bash backend-go/scripts/profile-smoke.sh`。

### 数据库

1. **启动绝不建表、绝不加列**。`VerifySchema` 缺表或缺关键列直接退出
2. **`internal/db/schema.sql` 是唯一事实源**，只被 `--init-db` 用；索引写在 `internal/db/indexes.go`，启动时幂等补建
3. **加字段要改四处**：`schema.sql` → store 的 `columns` + `scanXxx` + `INSERT/UPDATE` → 老库迁移语句（没有迁移框架）→ 跑回归
4. **备份不能用 `cp`**：WAL 下最近的事务在 `-wal` 里，只拷主文件会静默丢数据

### 约定

- **后端**：`internal/api` → `internal/<域>` → `internal/store` 单向依赖；响应统一走 `httpx.OK / Fail`；表列名是带引号的 camelCase；时间比较用 `datetime('now')`
- **前端**：一律 `@/` 别名；UI 走 `@/components/ui`，弹窗用 `ui/Modal`，时长用 `formatDuration(Ms)`；`components/` 不许依赖 `modules/room`
- **不做**：ORM / 查询构建器、启动路径自动 DDL

### 发布

`.github/workflows/build.yml` 不跟 main 自动构建。手动触发填 `vX.Y.Z` 出正式版（建 tag + Release + 推产物仓库 + 同步 GitCode），留空只出 `latest` 预发布。

| Secret | 用途 |
| --- | --- |
| `RELEASE_REPO_TOKEN` | 对 `ZviewerRelease` 有 `contents:write` 的 PAT |
| `GITCODE_TOKEN` | 对 `ZViewer` 与 `ZviewerRelease` 有写权限 |

可选组件（cloudflared、frpc、EasyTier、LiveKit）放在 `ZviewerRelease` 的 **`components` 分支**：那边的 `main` 每次发版都被孤儿提交整体替换，组件会被清掉。

更新源：网页端和 GUI 都有「使用镜像更新源」开关（默认开）。清单和安装包走 GitCode raw，偏好存 `config/update-source.json` / GUI 的 `settings.json`，运维可以用 `ZVIEWER_UPDATE_SOURCE=github|gitcode|mirror` 覆盖。**不做自动回退**——选了镜像就只走镜像，失败直接报错提示关开关。

## 文档

| 内容 | 位置 |
| --- | --- |
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
