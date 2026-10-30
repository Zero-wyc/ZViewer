# 部署与配置

自建部署的参考手册：端口、Docker、环境变量、语音、交互菜单。安装与上手看 [README.md](README.md)。

## 端口

| 端口 | 用途 | 是否对外开放 |
| --- | --- | --- |
| 3333/tcp | HTTP/HTTPS、WebSocket、前端页面、`/live` FLV 代理、`/rtc` 语音信令反代 | **是** |
| 3333/udp | LiveKit 语音媒体 | **是** |
| 3334/tcp | OBS RTMP 推流 | 需要推流时 |
| 3337/tcp | 语音 ICE/TCP 直连（UDP 被拦时自动改走） | **是** |
| 3338/tcp | 语音 TURN/TLS 中继（可选） | 配齐证书三项时 |
| 3335/tcp | HTTP-FLV 拉流 | 内部 |
| 3336/tcp | LiveKit 信令 | 内部 |

## Docker

> v4.3.6 以下用 Docker 部署的，不要走面板「一键更新」，按下面重新部署一次。

```bash
docker run -d --name zviewer --restart unless-stopped \
  -p 3333:3333 -p 3333:3333/udp -p 3334:3334 -p 3337:3337 -p 3338:3338 \
  -v zviewer-data:/app/config \
  zerowyc0721/zviewer:latest
```

```yaml
services:
  zviewer:
    image: zerowyc0721/zviewer:latest
    ports:
      - "3333:3333"      # 网页 + API + /live + /rtc
      - "3333:3333/udp"  # 语音媒体
      - "3334:3334"      # RTMP 推流
      - "3337:3337"      # 语音 ICE/TCP
      - "3338:3338"      # 语音 TURN/TLS（可选）
    volumes:
      - zviewer-data:/app/config
    restart: unless-stopped
```

- 镜像标签：`latest` / `X.Y` 只在推送 `vX.Y.Z` 时更新，`X.Y.Z` 固定版本，`dev` 跟随 main。
- 容器以 HTTP 启动。HTTPS 建议交给 Cloudflare、ESA、EdgeOne，或宝塔 / 1Panel 反代到 3333。
- `/app/config` 存数据库、`ssl/`、`uploads/`；`media/` 是预留目录，推流不落盘。

## 环境变量

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
| `NMS_HTTP_FLV_URL` | 指向外部媒体服务，设置后不再内嵌 | 空 |
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

## 推流与一起听

两项都开箱可用，不用装任何外部服务。OBS 里服务器填 `rtmp://<地址>:3334/live`，推流码用房间页面给的；
一起听的网易云接口由后端自带，没有可配置项。一起听取不到数据只会是网易云侧风控 / 地区 / 版权（日志前缀 `[ncm]`），不影响观影、语音与推流。

改用外部媒体服务（SRS、node-media-server）时设 `NMS_HTTP_FLV_URL`，后端不再监听 3334/3335。

## 语音

- 服务端同时发布 `3333/udp` 与 `3337/tcp`，浏览器自动择优：UDP 直连 > TCP 直连 > TURN 中继，无需开关。
- 要彻底关掉 3337 必须显式写 `LIVEKIT_RTC_TCP_PORT=0`；留空会回落到未映射的 7881。
- 内网与外网都要直连时用 host 网络，见下。
- 进房成功但没声音，通常是 UDP 被代理 / 防火墙吞掉，先关代理再试。

### 内网与外网同时直连（host 网络）

bridge 网络下局域网用户常因路由器不支持 NAT 回环连不上，改 host 网络并把网卡限死：

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

`includes` 的网卡名要和宿主机一致（`ip -br addr` 查看，云主机常见 `eth0` / `ens18`）。写错会枚举不到 ICE 候选、语音直接连不上，拿不准就先删掉这段。

## 交互菜单（单文件版）

`start.bat` / `./start.sh` 不带参数即进入菜单；也可以直接带命令，如 `./start.sh start`，完整列表见 `start.bat help`。

| 编号 | 功能 | 说明 |
| --- | --- | --- |
| 1 | 启动服务 | HTTP 启动，端口取 `.env` 的 `PORT` |
| 2 | 仅启动后端 | 先选 HTTP / HTTPS，跳过前端产物校验 |
| 3 | 停止服务 | 按 PID 停止，端口被占用时兜底清理 |
| 4 | 重启服务 | 停止后重新启动 |
| 5 | 查看状态 | 端口、PID、程序与证书是否齐全 |
| 6 | 查看日志 | 输出 `log/backend.log` 末 50 行 |
| 7 | 签发 SSL 证书 | `localhost` 自签，或域名 / 公网 IP 申请 Let's Encrypt |
| 8 | HTTPS 启动 | 签发后以 HTTPS 启动 |
| 0 | 退出 | 只关菜单，后台服务继续运行 |

> 菜单 7 / 8 的自动签发适合测试，正式环境建议交给 Cloudflare、ESA、EdgeOne 或宝塔 / 1Panel 签发续期，再反代到 3333。

## 从 4.x 升级到 5.x

首次启动会自动清理 Node 时代遗留文件（`zviewer-frontend.exe`、`zviewer-cert`、`node_modules/`、`backend/`、`config/media` 里的推流切片），日志打印 `[cleanup] 已清理 v4 遗留文件 …`。`config/` 下的数据库、证书、上传文件不受影响。
