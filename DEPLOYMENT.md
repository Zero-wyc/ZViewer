# 部署与配置

自建部署的完整说明：端口、Docker、环境变量、推流、语音传输、交互菜单。
README 只保留功能与快速上手，细节都在这里（`docs/` 是本地目录，不进仓库，所以放在根目录）。

## 端口

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
- `/app/config` 含数据库（`dev.sqlite`）、证书（`ssl/`）、上传文件（`uploads/`）；`media/` 是预留目录，当前推流走内存转封装、不落盘
- **一起听完全开箱可用**：网易云接口由后端自带（`internal/ncm`），不需要额外部署、不需要 Node；也不要再设 `NCM_*` 变量（历史变量已移除）
- Docker 模式下仍可使用网页更新

## 环境变量

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
| `RTMP_PORT`              | RTMP 推流端口（后端进程内监听，OBS 连这个）            | `3334`                  |
| `HTTP_FLV_PORT`          | FLV 拉流端口（内部，只经 3333 的 `/live` 反代访问）     | `3335`                  |
| `NMS_BIND`               | 内置媒体服务的监听地址                            | `0.0.0.0`               |
| `NMS_HTTP_FLV_URL`       | 指向外部媒体服务（SRS / node-media-server），设置后不再内嵌 | 空（内嵌）              |
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
| `EMBY_CLIENT_NAME`       | Emby / Jellyfin 客户端标识名（`X-Emby-Authorization`）；部分服务器限制客户端名时改这里 | `ZViewer`               |

## 推流与一起听

**OBS 推流开箱可用**：后端进程内自带 RTMP 收流（3334）与 HTTP-FLV 分发（3335），
不依赖 node-media-server / SRS，也不需要额外容器。OBS 里服务器填
`rtmp://<你的地址>:3334/live`、推流码填房间页面给的码即可。想改用外部媒体服务
（集群、已有 SRS）时设 `NMS_HTTP_FLV_URL`，此时后端不再监听这两个端口。

**一起听（网易云）开箱可用**：网易云接口由后端自带（`internal/ncm`，自己实现
weapi / eapi / linuxapi 加密与 50 个接口，含扫码登录与云盘上传），页面请求直接落到
同一个进程里的函数，**没有外部服务、没有回环端口、没有子进程，也没有 Node 运行时**。
它不带任何可配置项——不需要部署任何东西，也没有「音乐服务未启动」这种状态。

拿不到数据只可能是网易云那边拒绝（风控 / 地区 / 版权，日志前缀 `[ncm]`），
观影、房间、弹幕、语音、推流都不受影响。

## 语音传输

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

## 交互菜单（单文件版）

Windows 双击 `start.bat`、Linux 执行 `./start.sh`（不带参数）都会进入交互菜单：

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

也可以跳过菜单直接带命令执行，如 `start.bat start` / `./start.sh start`；完整命令见 `start.bat help`。

> **不建议使用命令行自动签发正式证书**：菜单 `7` / `8` 的 Let's Encrypt 签发适合测试，续期、验证失败排查都要自己盯。正式环境建议把域名交给 **Cloudflare、ESA、EdgeOne** 等支持自动签发与续期的边缘服务，或使用 **宝塔、1Panel** 等面板统一申请续期，再反向代理到 ZViewer 的 3333 端口。

## 从 4.x（Node 版）升级到 5.x（Go 版）

更新完成后第一次启动会自动清理 Node 时代遗留的文件
（`zviewer-frontend.exe`、`zviewer-cert`、`node_modules/`、`backend/`、`config/media` 里的推流切片），
启动日志会打印一条 `[cleanup] 已清理 v4 遗留文件 …`。`config/` 下的数据库、证书、上传文件不受影响；
源码目录（含 `.git` 或 `frontend/src`）不会做目录级清理。
