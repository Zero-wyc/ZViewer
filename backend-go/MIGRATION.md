# 迁移清单

> 基线：`backend/src` 共 220 个 `.ts` / 42,653 行 / 约 300 个 HTTP 端点 / 16 张表。
> 本文件是执行台账：每完成一个单元就在状态列打勾，并写一句验收口径。

## 一、总体进度

| 维度 | 已完成 | 总量 | 覆盖率 |
|---|---:|---:|---:|
| 代码行 | ~66,300（含测试 17,800） | 42,653 | 100%+ |
| HTTP 端点 | 182 | 182（Node 运行时实测 189 条 `/api` 路由全命中） | 100% |
| 实时事件 | 65 | 65（上行业务事件） | 100% |
| 数据库表 | 16（user / movie / room / session / playback_states / music_playback_states / music_queue_item / user_mount / danmaku_track / room_danmaku_meta / server_folder / comment / system_settings / audit_logs / bilibili_credential / ncm_credential） | 16 | 100% |

> **端点总数的口径**（两次修正后的最终版）：早期写的「~300」是粗估（把 emby/jellyfin
> 双前缀、同一路径的多方法、注释里的示例串都算进去了）。现在不再用静态计数当结论，
> 而是 `scripts/route-parity.sh`：把 Node 的 Express 路由表**运行时**导出来（189 条
> `/api`），逐条打到 Go 上，看是否落到 `/api/` 的 404 兜底。结果 **189/189 全命中、
> 0 次 panic**。Go 侧源码里是 179 处 `HandleFunc` 注册（emby/jellyfin 与四源代理
> 由循环展开成更多运行时规则）。同一个脚本的静态模式（按 `DYNAMIC_PREFIXES` 展开
> 变量前缀）也已经是零缺口：Node 189 条对应 Go 188 条——差的 1 条是 Node 显式
> 声明的 `HEAD /api/server-files/proxy`，Go 的 `GET` 注册天然接受 HEAD。

## 二、阶段 0：基座（已完成）

| 单元 | Go 包 | 状态 | 验收口径 |
|---|---|---|---|
| 环境变量与路径 | `internal/config` | ✅ | `PROJECT_ROOT` / `CONFIG_DIR` / `DATABASE_URL` 与 `services/paths.ts` 同结果 |
| `.env` 加载 | `internal/config` | ✅ | 不覆盖已有 env，支持 `export` 与引号 |
| SQLite 连接 | `internal/db` | ✅ | 能只读打开现有 `dev.sqlite`，16 表全识别 |
| Schema 守卫 | `internal/db` | ✅ | 缺表/缺列时启动失败并列出差异，不自行建表 |
| JWT | `internal/auth` | ✅ | Node 与 Go 双向验签通过（`scripts/compat-smoke.sh`） |
| bcrypt | `internal/auth` | ✅ | 校验 bcryptjs `$2b$` 哈希（`tokens_test.go`） |
| Cookie 语义 | `internal/auth` | ✅ | HTTP 不写 cookie；HTTPS 同站 Lax / 跨站 None+Secure |
| CORS / 日志 / panic 恢复 | `internal/api` | ✅ | 反射 Origin + credentials；`/api/` 访问日志 |
| 健康检查 | `internal/api` | ✅ | `startedAt` 为毫秒数字 |
| 静态资源 + SPA 回退 | `internal/api` | ✅ | 头像 7d、`/ffmpeg/` 1y；未知 `/api/` 返回 404 JSON |
| 鉴权接口 | `internal/api` | ✅ | login / register / guest / refresh / logout / me / registration-mode / public-settings |

## 三、阶段 1：鉴权收尾（已完成）

| 单元 | 源文件 | 状态 | 验收口径 |
|---|---|---|---|
| 修改密码 | `routes/auth.ts` PATCH `/password` | ✅ | 校验旧密码 → 落新哈希 → 写 `tokenInvalidBefore`；旧 token 立刻 401（`profile_integration_test.go`） |
| 改密限流 | `middleware/rate-limit.ts#passwordLimiter` | ✅ | 每用户 1 分钟 3 次，第 4 次 429「操作过于频繁，请稍后再试」 |
| 修改用户名 | `routes/auth.ts` PATCH `/username` | ✅ | 仅 root；只校验 trim 后非空（**不要**套用注册的 2–24 位规则）；重名 409 |
| 头像上传 | POST `/avatar` | ✅ | 5MB / JPG·PNG·GIF·WEBP；落盘 `<id>-<毫秒时间戳>.<ext>`；旧文件清理；匿名可 GET |
| 头像删除 | DELETE `/avatar` | ✅ | 置 `avatar = null` 并删文件；非 `/uploads/avatars/` 前缀一律不动 |
| 审计 | `services/audit.ts` | ✅ | `password_changed` / `username_changed` 落库，失败不影响主流程 |
| 登录失败锁 | `middleware/rate-limit.ts` | ⏳ | 默认关闭（`ENABLE_LOGIN_LOCK`），可最后做 |
| 管理员用户管理 | `routes/admin.ts` | ⏳ | 与 admin 模块一起迁，勿单独拆 |

验收脚本：`scripts/profile-smoke.sh`（在 `config/dev.sqlite` **副本**上跑真进程，
含"用 Node 的判定规则复核 Go 写入的吊销时间"这一步）。

## 四、阶段 2：无状态解析（约 45 人日）

这些模块**不碰库**（B 站凭证通过后续的 credential 接口拿），最适合先迁，
风险低、收益直接（占后端 CPU 与带宽的大头）。

| 单元 | TS 行数（估） | Go 包（拟） | 状态 |
|---|---:|---|---|
| 内网地址判定 / URL 规范化 | ~110 | `internal/netutil` | ✅ |
| HTTP 上游媒体代理（`http-proxy.ts`） | ~460 | `internal/proxy` | ✅ |
| Range 解析与流式输出（`range-stream.ts`） | ~230 | `internal/proxy` | ✅ |
| 防盗链代理端点 ×4（`antileech-proxy.ts`） | ~50 | `internal/api` | ✅ |
| 挂载代理 / 影片流解析（`mount-proxy.ts`、`stream-movie.ts`） | ~260 | `internal/proxy` | ⏳ 依赖 mount / movie 表，随阶段 3 一起迁 |
| B 站解析（wbi/playurl/pgc/vip/cdn/弹幕/字幕） | ~5,900 | `internal/bilibili` | ✅ 见下方「2.1」 |
| 动漫源（kazumi 规则引擎 / anime / anisubs / cms） | ~5,400 | `internal/anime` | ⏳ |
| 弹幕源（多源聚合：bilibili / bahamut / dandanplay） | ~1,460 | `internal/danmaku` | ⏳ B站 单源已完成（在 `internal/bilibili`），多源聚合与 bahamut/dandanplay 未做 |
| 字幕源（多源） | ~1,000 | `internal/subtitle` | ✅ 见 3.10（5 端点 + 44 步对拍） |
| LiveKit WS 隧道 + 凭证 | ~1,200 | `internal/voice` | ✅ 见 3.19（3 端点 + 14 步对拍） |

### 2.1 B 站解析链（已完成）

一个包内按职责拆分，不跨包引用：

| 单元 | Go 文件 | 验收口径 |
|---|---|---|
| 参数容器 + `encodeURIComponent` 等价编码 | `params.go` | 与 JS 逐字节一致（`wbi_test.go` 黄金值） |
| TTL + LRU 缓存 | `cache_internal.go`、`cache.go` | 语义对齐 `utils/ttl-cache.ts`（500 上限、惰性过期、命中刷新活跃度） |
| HTTP 客户端 / 业务码 / 匿名预热 | `client.go` | 412 重试 3 次、单请求 10s 硬超时；匿名会话用 `finger/spi` 预热 |
| WBI 签名 | `wbi.go` | `mixinKey` / `w_rid` 与 Node 同值（3 组固定 `wts` 黄金值） |
| 清晰度与权限 | `permission.go` | VIP 过滤唯一事实源；`fnval` 位标志与 `permission.ts` 同值 |
| 视频信息 | `video.go` | WBI 优先，失败清缓存降级 `/x/web-interface/view` |
| playurl 归一化 | `playurl.go` | 轨道按 `data.quality` 过滤；`currentQn` 反映**实际选中轨道**；auto→AVC 偏好 |
| 番剧 | `pgc.go` | 载荷取自顶层 `result`（不是 `data`）；试看集时长取 `durl[0].length` |
| CDN 探测 | `cdn.go` | 并行 HEAD，405 视为可达，全失败保留首个 |
| 解析主流程 | `resolver.go` | UGC / PGC 双分支、MP4 回退、NDJSON 进度 |
| MP4 直链清晰度 | `permission.go#Mp4TargetQn` | **未登录也按 720P 请求**（见下）；显式 qn 只做 720P 截断 |
| 弹幕 | `danmaku.go` | XML 正则 + 五实体解码；**裸 deflate** 自行解压 |
| 字幕 | `subtitle.go` | oid 带外校验 + 时长带内校验 + 6 次采样一致性投票，未过校验一律返回空 |

**MP4 模式的匿名清晰度（2026-10-25 修）**：

MP4 直链（`fnval=1` + `platform=html5` + `high_quality=1`）对**未登录**用户也能给 720P，
而 DASH 的匿名上限是 480P。此前 MP4 分支直接沿用 `GetDefaultQn`，匿名就被压到 `qn=32`，
更糟的是目标视频没有 480P 档时 B站 会落到 **360P**（实测 `qn=32 → quality=16`）。
现在统一走 `Mp4TargetQn`：未显式指定时匿名顶到 `MP4MaxQn(64)`，显式选择只做 720P 截断。
B站 对超权限请求是**静默降级**（匿名 `qn=80` 实测返回 `quality=64`、`code=0`），不会报错。
实测同一条视频：改前 `currentQn=32`（480P/360P），改后 `currentQn=64`（720P）。

**验收脚本**：

- `scripts/bilibili-smoke.sh`：真库副本 + 真 B站 接口，15 个用例（解析 / 弹幕 / 字幕）。
- ~~`scripts/bilibili-parity.sh`：Node 与 Go 双进程**逐字段对拍**，6 个用例
  （UGC 默认 / 降清晰度 / MP4、PGC 免费集 / 会员专享集 / 切集），当时差异总数 **0**。~~
  该脚本随 Node 后端一起删除；现在由 `scripts/bilibili-smoke.sh`（真接口，15 用例）覆盖，
  进程管理仍用 `scripts/lib-proc.sh`。

**测试脚本自身的两个坑**（曾导致对拍结论完全错误，已固化到 `lib-proc.sh`）：

1. Git Bash 里 `cmd &` 之后 `$!` 是**包装用的 bash 子进程**，不是 `node.exe` / `zviewerd.exe`
   本身。`taskkill $!` 只杀掉外壳，真正的进程继续占着端口。
2. 本机 `netstat` 看不到这些监听套接字（`TIME_WAIT` 能看到、`LISTENING` 看不到），
   既无法预检端口占用，也无法按端口反查 PID。

后果是残留进程安静地占着老端口：新进程 bind 失败退出，健康检查却被**旧进程**应答，
于是对拍拿的是上一版构建的输出——表现为「Node 少了 `videoCodecid` 字段」，
看起来像 resolver 的 bug，实际与代码无关。现在端口每轮随机，且启动判定
**先查本轮日志锚点、再查健康检查**。


**反代验收口径**：`go test ./internal/proxy` 覆盖 Range 收敛/透传、非 2xx 透传、
JSON Content-Type 纠正、m3u8 改写、超时 504、SSRF（字面量 + 重定向）；
`scripts/proxy-smoke.sh` 在真实公网源上验证 200 / 206 / 416 / 404 与通配 CORS。

## 五、阶段 3：实时核心（约 60 人日，最重）

| 单元 | TS 行数（估） | 状态 | 卡点 |
|---|---:|---|---|
| Socket.IO 兼容层 | ~500（自研协议层） | ✅ 见 3.1 | |
| 实时层接入 + 房间生命周期 + 房主/观众会话 | ~1,400 | ✅ 见 3.2（7 个事件 / 28 步对拍） | |
| 房间 REST（列表/改名/弹幕轨道/弹幕辅助数据） | ~450 | ✅ 见 4.3（实时部分见 3.2） | |
| 房间设置 / 成员管理（禁言、踢人、转交房主、审批） | ~900 | ✅ 见 3.3（12 个事件 / 46 步对拍） | 语音禁言随 WebRTC 阶段 |
| 影片列表 / 当前播放（socket 侧） | ~1,100 | ✅ 见 3.4（5 个事件） | |
| 观众端同步状态机 | ~1,800 | ⏳ | 必须走 `resolveViewerEffectiveState` |
| 评论 / 弹幕广播 | ~470（实测） | ✅ 见 3.6（6 个事件 / 32 步对拍） | |
| 共享播放记忆 | ~1,550 | ✅ 见 3.4 / 3.5：读写、推算、补偿、2s 定时广播、陈旧缓存清理全做 | |
| 一起听音乐（实时层） | ~3,170 | ✅ 见 3.7（11 个事件 + 服务器心跳 / 48 步对拍） | NCM 内部 API 与流代理属阶段 4 |
| WebRTC 信令 | ~280 | ✅ 见 3.7（6 个事件 / 36 步对拍，媒体面不在后端） | |
| CLI 代理 / 预览源 / 投屏子模式 | ~350 | ✅ 见 3.7（5 个事件） | |
| 推流（NMS → 外部 RTMP/FLV 服务） | ~580 | ✅ 见 3.20（1 端点 + `/live` 反代 + 6 步对拍） |

### 3.1 Socket.IO 协议层（spike 已通过）

结论：**自研可行，不引第三方库**。Go 侧需要的行为与 Node 的 socket.io 完全一致，
而现成的 Go 实现（go-socket.io 等）停在协议 v3/v4 早期、且不保证与 socket.io-client
4.8 的字节级兼容；手写反而可控——和 FTP / WebDAV / B 站解析链是同一个理由。

| 文件 | 行数 | 内容 |
|---|---:|---|
| `internal/sio/packet.go` | ~170 | Engine.IO v4 包类型（open/ping/pong/message/upgrade/noop）+ Socket.IO v5 包编解码（namespace、ack id、附件数）+ `\x1e` 多包分隔 |
| `internal/sio/websocket.go` | ~245 | RFC 6455 服务端：握手、掩码、分片重组、ping/pong、close 握手 |
| `internal/sio/server.go` | ~715 | 会话管理、polling（长轮询 + 超时 noop）、WebSocket probe 升级、心跳回收、包分发、房间索引 |
| `internal/sio/socket.go` | ~270 | Socket 门面（On/OnDisconnect/Emit/EmitWithAck/Join/Leave/Disconnect）与 Broadcast（to / except） |
| `cmd/sio-spike/main.go` | ~185 | **临时**验证二进制，业务事件接入后删除 |

验证脚本：`scripts/spike-sio.sh`——编译 spike 服务端，再用**真实的
`socket.io-client@4.8.3`**（仓库根 `node_modules` 里那一个，与前端同版本）跑 17 项断言：

| 分组 | 覆盖 |
|---|---|
| 传输形态 | polling 起步自动升级 WebSocket / 强制 polling / 直连 WebSocket |
| 连接与鉴权 | `socket.id` 与握手 sid 一致、`socket.data` 生效、缺令牌返回 `connect_error` |
| 事件与 ack | 单参数与多参数 ack、服务端主动发起的双向 ack |
| 房间与广播 | `socket.to(room)` 排除自己、`io.to(room)` 含自己、未加入房间收不到 |
| 大载荷 | 5 MB 上行 / 3 MB 下行（`maxPayload` 设 20 MB） |
| 断线与保活 | 客户端主动断、服务端主动断、跨 `pingInterval` 心跳保活 |

Go 单测另外锁住协议细节（`internal/sio/*_test.go`，867 行）：编码黄金值、解码拒绝
非法输入、帧长度跨 125/126/65535 三档、分片重组、以及**升级时 noop 冲刷挂起轮询**。

接入方式（下一步）：

```go
srv := sio.NewServer(sio.Options{})
srv.UseAuth(func(h *sio.Handshake) error { /* JWT + tokenInvalidBefore */ })
srv.OnConnect(func(sc *sio.Socket) { /* 按 SocketEventHandler 拆分注册 */ })
mux.Handle("/socket.io/", srv)
```

尚未覆盖（都不影响协议层，属于业务面）：

- 二进制载荷（`BINARY_EVENT` 的分包重组）：本项目全部走 JSON，注释里留了位置。
- 多命名空间：只实现 `/`；收到其他 nsp 会按协议回 `connect_error` 而不是静默丢弃。

CORS 与逐包鉴权已在 3.2 接上（挂在同一中间件链 + `UsePacketAuth`）。

### 3.2 实时层接入与房间生命周期（阶段 8）

`/socket.io/` 挂在**与 REST 同一个 mux 与中间件链**上（Node 也是挂在同一个
express 实例），鉴权分两层：

- 握手层 `UseAuth`（≈ `io.use(socketAuthMiddleware)`）：cookie `access_token`
  → `handshake.auth.token` → `query.token`，三者顺序必须一致；缺令牌回
  `connect_error: 未提供认证令牌`。
- 逐包层 `UsePacketAuth`（≈ `socket.use`）：每个上行事件前重校验令牌与账号状态，
  失败直接断开。少了这层，改密码后旧连接仍然能发包——这是「已登录永久有效」的漏洞。

| 文件 | 行数 | 内容 |
|---|---:|---|
| `internal/api/sio.go` | ~165 | 挂载 `/socket.io/`、两层鉴权、令牌到期断开、影片 DTO 注入 |
| `internal/room/handlers.go` | ~880 | 7 个事件：`create-room` / `host-leave` / `close-room` / `admin-close-room` / `register-host` / `request-join` / `disconnect` |
| `internal/room/session.go` | ~245 | 房主注册（复用会话）、观众准入（串行化）、会话结束、最近房主宽限 |
| `internal/room/state.go` | ~410 | 运行时状态（影片/当前影片/播放/字幕）、重连定时器、关闭房间、5s 权限缓存 |
| `internal/room/playback.go` | ~275 | 播放记忆读取与时间推算、hostSocketId、关闭时清理 |
| `internal/room/permission.go` | ~80 | `canCreateRoom`、`isRoomHost` / `isInRoom`（带缓存） |
| `internal/room/broadcast.go` | ~95 | `movie-list` / `current-movie` 广播与「正在播的影片被删」清理 |
| `internal/realtime/siohub.go` | ~100 | `*sio.Server` → `realtime.Bus` + `room.Hub` 适配器 |
| `internal/store/session.go` | ~260 | session 表读写（在场判定的唯一事实源） |

对拍脚本 `scripts/sio-rooms-parity.sh`：起**真实的 Node 后端**（ts-node 跑
`src/index.ts`，独立 `CONFIG_DIR` + 独立 DB 副本）与 Go 后端，用同一份驱动器
`sio-rooms-driver.js`（真实 `socket.io-client@4.8.3`）跑 28 个步骤，比较
**ack 应答 + 该步收到的事件集合**。规范化只做三件事：socketId → 角色别名、
roomId → `ROOM*`、抹掉时间列（两侧落库精度不同）。

覆盖：游客建房被拒、参数校验（人数/模式）、建房、重复 register-host、
非房主 register-host、观众进房/重复进房、房间满员、REST 增删改影片触发的
`movie-list` 广播、非房主 close-room / admin-close-room / host-leave 被拒、
观众断线、房主 host-leave 与重连恢复、close-room（含踢人）、关闭后再进房、
密码房（错密码/对密码）、管理员强制关闭（房主不被踢）。

**尚未覆盖**（阶段 9~13 已逐项补齐房间设置、成员管理、播放控制、评论弹幕、一起听、
WebRTC 信令）：只剩**推流**（NMS，见 3.7 已知缺口）。`cmd/sio-spike` 是协议层的临时
验证二进制，业务事件接完后可以删，但它那 17 项传输形态断言仍有参考价值。

### 3.3 房间设置与成员管理（阶段 9）

在 3.2 的 `room.Service` 之上补齐 12 个事件，复用同一套 session / 权限 /
运行时状态，没有新增表。

| 文件 | 行数 | 内容 |
|---|---:|---|
| `internal/room/settings_handlers.go` | ~325 | `update-room-name` / `update-room-mode` / `update-room-settings` / `p2p-mode-change` |
| `internal/room/viewer_handlers.go` | ~700 | `approve-join` / `reject-join` / `kick-viewer` / `mute-viewer` / `unmute-viewer` / `transfer-host` / `appoint-moderator` / `dismiss-moderator` |
| `internal/room/permission.go` | ~280（原 80） | 追加 `isRoomModerator`（带缓存）、`canViewerPerform`（权限矩阵）、`canModeratorActOn`（防篡权）、`getOrReactivateSharer`（重连自愈）、`setModerators` |
| `internal/room/room_settings_test.go` | ~250 | 矩阵默认值、按角色判定、防篡权文案、转交房主、禁言名单、房管上限 |

对拍：`DRIVER=sio-members-driver.js TAG=members bash scripts/sio-rooms-parity.sh`
（同一脚本，靠 `DRIVER`/`TAG` 复用启动与比较逻辑）→ 46 个步骤完全一致。
驱动器额外加一条规范化：`password` 一律替换成 `<HASH>`（bcrypt 随机盐，
同一明文两次加密结果不同，只能比「有没有密码」）。

覆盖：改名（非 owner 被拒 / 空名 / 房间不存在）、切模式（非房主被拒）、
改设置（非房主被拒 / 人数 0 与 5.5 被拒 / 正常改 / 关审批 / 设密码 / 清密码）、
`p2p-mode-change`（**发送者收不到**、非房内被拒）、禁言（非房管被拒 / 游客被拒 /
禁言 / 解禁）、任命房管（游客 / 房主本人 / 正常 / 幂等）、房管防篡权（不可动房主）、
撤销房管（幂等）、转交房主（非房主被拒 / 转给游客被拒 / 正常转交 + 房管名单清理）、
踢人（目标不存在 / 正常踢 + `viewer-kicked` + `viewer-left`）、
审批（无 socket / 批准 / 批完再拒 / 拒绝）。

**尚未覆盖**：语音禁言（`voiceMuted` 列，属 WebRTC 阶段）、房管对房管的边界用例
（只有房主侧覆盖）、`update-room-mode` 的枚举校验（Node 也不校验，刻意保持一致）。

### 3.4 播放控制、影片列表与跳转申请（阶段 10）

19 个事件，全部落在已有的 `room.Service` 上，没有新增表。实时事件 19 → 38 / 65。

| 事件组 | 事件 | 实现位置 |
|---|---|---|
| 播放控制 | `watch-together-state` / `watch-together-request-state` / `watch-together-control` / `watch-together-check-status` / `host-heartbeat` | `internal/room/playback_handlers.go`（450 行） |
| 影片列表 | `add-movie` / `remove-movie` / `play-movie` / `request-movie-list` / `request-current-movie` | `internal/room/movie_handlers.go`（306 行） |
| 字幕 / 轨道 | `subtitle-update` / `subtitle-request` / `track-change` | `internal/room/sync_handlers.go`（237 行） |
| 观众申请 | `seek-request` / `seek-response` / `pause-request` / `pause-response` / `play-request` / `play-response` | 同上 |

支撑改动：

| 文件 | 行数 | 内容 |
|---|---:|---|
| `internal/room/playback_write.go` | ~245 | `SetPlayback`（合并 + 时间戳 + 2s 节流落盘）、`ApplyHostHeartbeat`（10s 节流）、`flushToDB`（整行 upsert）、`Raw` / `ActiveRoomIDs` / `HasCache` |
| `internal/room/transport_delay.go` | ~105 | `CompensateTransportDelay`（写侧延迟补偿，clamp 0~1.5s × rate）、`NeedsProgressSync`（自检判定，容差 10s） |
| `internal/room/playback.go` | 结构升级 | 缓存从 `map[string]*Playback` 换成带 `lastDBWriteAt` / `dirty` 的条目（节流需要） |
| `internal/room/playback_write_test.go` | ~270 | 补偿边界、自检容差、节流落盘、`hostSocketId` 保留、心跳不建缓存 |
| `internal/realtime/siohub.go` | +20 | `EmitRoomExceptNoArgs`（表达「零参数事件」，见下） |

对拍：`DRIVER=sio-playback-driver.js TAG=playback bash scripts/sio-rooms-parity.sh`
→ **68 个步骤完全一致**（含阶段 11 加的两条心跳断言）。驱动器带两条额外的规范化：
- `currentTime` / `duration` / `time` 与全部时间戳不删键，替换成 `<TIME>` / `<TS>`——
  值两侧必然不同，但「键在不在」能比也必须比；
- 影片 `id` / `movieId` 按首次出现顺序映射成 `MOVIE1` / `MOVIE2`。

覆盖：建/进房、`add-movie`（房主成功 / 普通用户按矩阵默认被拒）、`request-movie-list`
（房内 / 房外）、`request-current-movie`（没有在播 / 有在播 / 删掉之后）、
`watch-together-state`（非房主被拒 / 正常）、`request-state`（**无状态时 data=null
且广播零参 request-state** / 有状态时返回推算值 + hostOnline / 房外被拒）、
`control`（play / rate / seek / seek 负数 / pause / 未知动作 / 非 watch-together 模式被拒）、
`check-status`（一致 / isPlaying 分歧 / 房外）、`host-heartbeat`（非房主被拒 / 正常 /
`suppressed` / screen-share 模式**仍转发**）、`subtitle-update`（非房主被拒 / 正常 /
缺 roomId）、`subtitle-request`（收到缓存的 subtitle-update / 房间不存在静默）、
`track-change`（非房主被拒 / 字幕索引 / 弹幕轨道 / `value: null`）、
六件套申请与回应（非房内被拒 / 房主离线拒绝 / 接受 / 拒绝 / 非房主回应被拒）、
`play-movie`（正常 / 非房主被拒 / 影片不存在）、`remove-movie`（正常 / 重复删 /
非房主被拒）、`close-room`。

**尚未覆盖**：
- Redis 存储适配器（`setStorageAdapter`，多实例共享）。单实例部署用不到。
- 阶段 11 之前这里写着「服务器周期心跳未做，别把对拍通过当成房主断线后能继续播」。
  该缺口已在 3.5 补齐，那两句话不再成立。

### 3.5 服务器周期心跳与陈旧缓存清理（阶段 11）

`backend/src/modules/playback-memory/playback-broadcaster.service.ts`（139 行）的 Go 版：
`internal/room/broadcaster.go`（229 行）。实时事件数**不变**（38 / 65）——这一层没有新增
上行事件，它填的是下行的定时器。

| 能力 | Node | Go | 说明 |
|---|---|---|---|
| 2s 心跳 | `broadcastAll` | `Broadcaster.broadcastAll` | 遍历 `ActiveRoomIDs()`；房间无连接跳过；同时发 `server-heartbeat` 与 `sync-heartbeat`（`source: 'server'`） |
| 房主在线判定 | `isHostOnlineCached` | `isHostOnlineCached` | 5s TTL；查询失败按离线处理 |
| 30s 清理 | `cleanupStaleCache` + `cleanupStaleStates` | `PlaybackMemory.CleanupStaleCache` + `Service.CleanupStaleStates` | 播放记忆先清（房主连接不在 + 10 分钟未更新），运行时状态后清（房主连接不在 + 无播放记忆） |
| 退出落盘 | `flushAllDirty` | `FlushAllDirty` | SIGINT/SIGTERM 时**先停定时器再落盘** |

这条链路补完，「房主断线后观众继续播」才真正闭环：房主断开后 `hostOnline` 翻 false，
但心跳继续按推算值推进，观众端不再因房主心跳超时而暂停。

对拍驱动器新增两处**确定性**断言（心跳是定时器推的，只能等，不能算）：

- `await-server-heartbeat`：房主首次广播 state 后，等最多 6s 收到一轮服务器心跳；
- `heartbeat-after-host-offline`：`owner.disconnect()` 后等最多 12s 收到 `hostOnline: false`
  的心跳（两端都有 5s 判定缓存，正常 7s 内翻转）。收尾改用 `admin-close-room`。

周期心跳本身**不进步骤缓冲**：两端相位必然不同，塞进 buffer 会把步骤边界切歪（阶段 10
就是靠过滤这一路才稳定下来的）。改成收集「形状集合」——payload 的键集合、`state` 的键
集合、`source` 值、`hostOnline` 的类型——去重后比较。键的**存在性**正是要验的语义
（`server-heartbeat` 有 `roomId`、`sync-heartbeat` 没有），数量与时刻不是。

### 3.6 评论 / 弹幕 / 批注（阶段 12）

`backend/src/modules/comment/`（291 + 60 + 115 = 466 行）的 Go 版：
`internal/room/comment_handlers.go`（478 行）+ `internal/store/comment.go`（96 行）。
实时事件 38 → **43 / 65**。

| 事件 | 权限 / 校验 | 广播 |
|---|---|---|
| `send-comment` | 在房（含面板标记）→ 内容 trim 非空 → 未被禁言 | `new-comment`（**含发送者**） |
| `comment-history` | 在房 | ack 返回 `comments[]`（按 createdAt 升序） |
| `join-room-panel` | 房间存在 → active → `canReadRoom` | 无广播，只写 `panelRoomIds` + `socket.join` |
| `send-danmaku` | 在房 → 内容非空 → 未被禁言 | `danmaku` + `danmaku-meta-updated` |
| `annotation-stroke` | 在房 | `annotation-stroke`（附 `senderId`） |
| `clear-annotations` | 房主 | `clear-annotations`（**零参数**） |

三处容易做错的地方：

- **评论独立窗口没有 session**：`join-room-panel` 只写 `socket.data.panelRoomIds` 并
  `socket.join`，不建 session、不占人数位、不走审批。因此 `isInRoom` 必须先看
  `panelRoomIds` 再回落 session，并且这一步要改判 `canReadRoom`（Node 的
  `roomPermissionService.isInRoom` 就是这么写的）。少了这条分支，独立评论窗口一个
  字都发不出去，且**没有任何报错**。
- **`join-room-panel` 之后必须立刻失效权限缓存**：同一个 socket 之前查过一次
  `isInRoom=false` 会被缓存 5s，不失效则进面板后 5 秒内发评论仍被拒。
- **实时弹幕的 `time` 键**：`videoTime` 缺失时 Node 的对象里没有 `time`（`undefined`
  被 `JSON.stringify` 丢弃），写成 `time: 0` 会把弹幕钉在第 0 秒。Go 用
  `*float64` + `omitempty`，只有真正的有限数才写。

对拍：`DRIVER=sio-comments-driver.js TAG=comments bash scripts/sio-rooms-parity.sh`
→ **32 个步骤完全一致**。驱动器额外记录**参数个数**（`argc`）：
`clear-annotations` 是零参数事件，Go 侧若传 `nil` 会变成 `[null]`，只比 payload 看不出差异。

### 3.7 一起听 / WebRTC 信令 / CLI 代理（阶段 13，实时层收尾）

新增 22 个事件，累计 **65 / 65**：上行业务事件全部接完。三块一起做，因为它们共享同一批
基础设施（`Hub` 的全局广播、`socket.data` 跨协程访问、定向中继），分开做要改三遍接口。

| 事件组 | 事件 | 实现位置 |
|---|---|---|
| 一起听队列 | `music:queue-upsert` / `queue-remove` / `queue-clear` / `queue-reorder` | `internal/room/music_handlers.go`（1,093 行） |
| 一起听同步 | `music:sync-state` / `host-heartbeat` / `check-status` / `get-state` | 同上 |
| 一起听申请制 | `music:control-request` / `control-response` / `sync-ack` | 同上 |
| WebRTC 信令 | `signal-offer` / `signal-answer` / `signal-ice-candidate` | `internal/room/webrtc_handlers.go`（215 行） |
| 观众就绪 | `viewer-ready` / `sharer-ready` / `sharer-error` | 同上 |
| CLI 代理 | `cli-register` / `cli-list-agents`（+ 断线全局广播） | `internal/room/misc_handlers.go`（334 行） |
| 零散能力 | `play-preview-source` / `update-share-method` / `query-stream-push-availability` | 同上 |

支撑改动：

| 文件 | 行数 | 内容 |
|---|---:|---|
| `internal/store/music.go` | ~360 | `music_queue_item` 与 `music_playback_states` 两张表的读写（队列排序 / 压实 / 时长解析 / 基线 upsert） |
| `internal/room/music_state.go` | ~660 | 音乐播放基线：内存缓存、写侧补偿、外推到歌曲时长即凝固、2s/10s 两档节流落盘、陈旧缓存清理、payload 严格校验 |
| `internal/room/music_broadcaster.go` | ~180 | 每 2s 广播 `music:sync-heartbeat(source:'server')` + 5s TTL 的 `hostOnline` + 30s 清理 |
| `internal/room/music_test.go` | ~700 | 校验边界、外推凝固、补偿两端钳位、重启恢复、order 压实、失效行真删、清理跳过脏数据 |
| `internal/sio/socket.go` | +18 | `GetData`：断线回调里读 `socket.data`（那时连接已从服务端索引移除，Hub 查不到） |
| `internal/realtime/siohub.go` | +26 | `EmitGlobal`（`io.emit`）、`SocketRooms`（信令的「同房间」判定要看**目标连接**的房间） |
| `internal/room/state.go` | +20 | `Hub` 接口补两个方法；`Deps.Music`；关闭房间改调 `Music.Clear`（内存 + DB 一起清） |
| `cmd/zviewer-server/main.go` | +12 | 装配音乐基线与广播器；退出时**先停定时器再落盘** |

对拍（同一套 `sio-rooms-parity.sh`，靠 `DRIVER`/`TAG` 复用）：

- `DRIVER=sio-music-driver.js TAG=music` → **48 个步骤完全一致**，14 条断言，心跳形状一致；
- `DRIVER=sio-misc-driver.js TAG=misc` → **36 个步骤完全一致**，13 条断言。

八处「只有对拍才照得出来」的细节：

1. **队列 order 右移必须从当前条目的下一条开始**。从当前条目自身开始右移会让它与新条目
   order 相同，连续插入时整批平局，SQLite 退化成 rowid 随机序——前端表现是「点下一首
   跳到推荐批次里的任意一首」。驱动器用名字断言顺序而不只看条数。
2. **`music:control-request` 的 `item` 必须原样透传**。用解析后的结构体转发会把
   `biliBvid` / `biliCid` / `recommended` 补成 `null`，而 Node 是 `{ item: payload.item }`
   （键直接不存在）。这是本轮唯一一条被对拍抓出来的真差异。
3. **`music:get-state` 的 `syncState` 键恒存在**（值为 `null`），且 ack 是**顶层**摊开
   （`queue` / `syncState` / `serverTs` / `hostOnline`），不是 `{ success, data }` 包装。
4. **`music:check-status` 成功时也走 `{ success: true, data: {...} }`**，失败才是
   `{ success: false, message }`——两种形态不能混用同一个结构体。
5. **`music:sync-heartbeat` 不进步骤缓冲**（与 3.5 的服务器心跳同理），改比「形状集合」：
   键集合 / `source` / `state` 的键集合 / `hostOnline` 类型 / `isPlaying` 类型。
6. **`cli-list-agents` 的 roomId 只在参数本身是裸字符串时才回显**。Node 是
   `typeof roomId === 'string'`，传 `{ roomId }` 反而不满足。驱动器三种形态都覆盖了。
7. **`query-stream-push-availability` 必须带一个占位参数**。Node 的 handler 签名是
   `(_payload, callback)`，`emit(event, cb)` 会把回调当成 payload，ack 永远不回（驱动器
   第一次就是这么超时的）。
8. **CLI 断线广播从 `socket.data` 读、不能走 Hub**。`detachSocket` 先把连接从服务端索引
   移除再跑断线回调，`Hub.SocketData` 此时返回 nil，`cli-agent-unavailable` 就发不出来。

**原已知缺口（已补齐）**：`update-share-method` 切到 `stream-push` 曾一律失败——Go 不内嵌
Node-Media-Server，`streamPushAvailable()` 恒为 `false`。阶段 25 改成**外部化 NMS**：
`internal/nms` 探测上游 TCP 端口，可用性判定、推流码生成、`share-method-changed`
广播与 Node 完全一致，见 3.20。

### 3.8 服务器文件与系统端点（阶段 14，HTTP 面开张）

实时层 65/65 收口后，HTTP 面从 78 推到 **90 / ~300**。这一批的共同点是
**「不依赖挂载表、不依赖第三方 Node 依赖」**——纯文件系统 + 纯 SQL 就能闭合，
所以先做。同时把第一个 HTTP 对拍脚本立起来（此前只有 socket 对拍）。

#### 服务器文件域（12 个端点）

| 端点 | 方法 | 鉴权 | 实现位置 |
|---|---|---|---|
| `/api/server-files/roots` | GET / POST / DELETE | requireRoot | `internal/api/serverfiles.go`（873 行） |
| `/api/server-files/browse` | GET | requireRoot | 同上 |
| `/api/server-files/browse-system` | GET | requireRoot | 同上 |
| `/api/server-files/upload` | POST（流式 multipart） | requireRoot | 同上 |
| `/api/server-files/folder` | POST | requireRoot | 同上 |
| `/api/server-files/rename` | POST | requireRoot | 同上 |
| `/api/server-files/file` | DELETE | requireRoot | 同上 |
| `/api/server-files/bilibili-download` | POST（NDJSON 流） | requireRoot | 同上 |
| `/api/server-files/resolve` | GET | **require（观众也用）** | 同上 |
| `/api/server-files/proxy` | GET / HEAD | **require（观众也用）** | 同上 |

> `/resolve` 与 `/proxy` **故意降到普通登录用户**：观众要能播房主用
> 「服务器文件」推送过来的本地视频。管理类操作才要 root。

支撑包：

| 文件 | 行数 | 内容 |
|---|---:|---|
| `internal/serverfiles/paths.go` | 210 | 前缀式路径协议（`uploads:` / `custom:<id>:` / 旧式裸路径）、越权拦截、拼音排序 |
| `internal/serverfiles/upload.go` | 213 | 流式落盘、10GB 上限、只读根拒绝、重名改名、文件名修复 |
| `internal/serverfiles/download.go` | 119 | URL → 本地文件（B站下载用），失败删残片，进度按 2% 节流 |
| `internal/store/serverfolder.go` | 127 | `server_folder` 表（第 14 张表）读写 |

#### 分散的 4 个端点

| 端点 | 方法 | 鉴权 | 要点 |
|---|---|---|---|
| `/api/stats/traffic` | GET | requireRoot | 取不到时回 **501**，不是 0 |
| `/api/client-logs` | POST | **不鉴权** | 游客报错最需要收集；4MB 上限；异步落盘后立刻 204 |
| `/api/direct-resolve/movie` | GET | 房间读权限 | 直链 TTL 缓存 + 单飞；内网地址拒绝 |
| `/api/cli/resolve` | GET | **不鉴权** | 调用方是用户本机 CLI，Cookie 原样透传，跳过 CDN 检查 |

`internal/api/directresolve.go`（281 行）的状态码映射：`NOT_FOUND` / `MOUNT_NOT_FOUND`
→ 404、`AUTH_FAILED` → 401、其余 → 400。

#### 对拍

`bash backend-go/scripts/http-serverfiles-parity.sh`
→ **65 个步骤完全一致（状态码 + 响应头 + 响应体），1 处已登记已知差异**。

HTTP 对拍与 socket 对拍的方法论差异：比的是「状态码 + 响应头 + 响应体」，所以
`normalize()` 只做三件事——绝对路径替换成 `<UPLOADS>` / `<CUSTOM>`、ISO 时间戳替换成
`<TIME>`（**替换不删键**，键存在与否是语义）、JSON 键排序（`stable()`）消除键序假差异。
统计类端点只比键集合不比数值（机器负载每次都不同）。
`KNOWN_DIFFS` 白名单登记「刻意不一致」，输出 `~` 而非 `✗`，不阻塞通过。

已知差异：`upload-readonly-root`——Node 侧 multer 的错误直落 express 默认处理器，
回 **500 + HTML 错误页**；Go 回 **400 + JSON 可读文案**。

#### 八处「只有对拍才照得出来」的细节

1. **`UPLOADS_DIR` 必须保持 Node 的「原值比较」语义**。Node 的 `UPLOADS_ROOT` 直接取
   env 原值、不做 `path.resolve`，而 `add-root` 拿 `path.resolve(absPath)` 与它比较——
   只要字符串形态不同（`C:/a` vs `C:\a`、POSIX vs Windows）就不相等，「该目录已是默认
   空间」的守卫会**静默失效**，uploads 根被当成自定义根写进表，之后 `custom:1` 指向错误
   目录、`readonly` 全错。Go 侧**不得**对 `UPLOADS_DIR` 做额外 `Clean` 化，脚本侧则一律
   用 `cygpath -w` 规范化后再传。这一条一口气造出 5 处假差异，是本轮最贵的坑。
2. **416 响应**不写响应体。播放器只看状态码与 `Content-Range`，塞一段 JSON 反而会
   让它把响应当成媒体数据解析。
3. **`ToPrefixedPath` 必须判 `rel == "."`**。`filepath.Clean` 会把 `.../uploads/` 变成
   `...\uploads`（正斜杠 → 平台分隔符），与 `root.AbsPath` 字符串不等，
   `filepath.Rel` 得 `"."`，会输出 `uploads:/.` 而不是 `uploads:/`。
4. **越权判断用 `filepath.Rel`，不能用字符串前缀**。Windows 盘符根（`D:\`）自带分隔符，
   字符串拼接会拼出 `D:\\` 而误判。
5. **目录项没有 `size` 键**。Node 里是 `undefined`，`JSON.stringify` 整键丢弃；
   Go 用 `*int64` + `omitempty` 复刻（写成 0 会让前端排序把目录排到最前/最后）。
6. **隐藏文件剔除 + 目录在前 + 拼音排序**。排序用 `golang.org/x/text/collate` +
   `language.SimplifiedChinese` 复刻 JS 的 `localeCompare(name, 'zh-Hans-CN')`；
   Collator **非并发安全**，必须加互斥锁。「阿」要排在「波」之前——码点序是相反的。
7. **上传必须流式**（`r.MultipartReader()`）。`ParseMultipartForm` 会把整个请求体先落临时
   文件，10GB 上传等于写两遍盘。`targetDir` 字段必须**排在文件 part 之前**才能边收边定根。
8. **根目录注册表带 30s TTL + 主动失效**。`/proxy` 在 seek/预取时高频到达，每次查
   `server_folder` 全表是纯浪费；增删时 `Invalidate()` 保证改完立刻生效。

#### 直链解析的三条硬约束

- **缓存 key 不含 userId**：`type|serverURL|path`——同一源文件跨影片、跨房间共享解析结果。
- **`UpgradeDirectURLValidated` 必须现场再探一次**：`httpsDirect` 是配置期一次性探测的
  持久缓存，源站拆掉反向代理后陈旧的 `true` 会变成永远连不上。
- **openlist 失败不回退拼接**，webdav 仅在非 AList 错误时才回退 `webdav.DirectURL`。


### 3.9 管理端（阶段 15）

`routes/admin.ts` 的 12 个端点，一次接完。这个模块几乎全在读写既有表，
没有第三方依赖，所以是 HTTP 面里最容易做成「完全一致」的一块。

| 端点 | 方法 | 权限 | 要点 |
|---|---|---|---|
| `/api/admin/users` | GET | admin+ | 7 列 DTO（**不含 passwordHash / tokenInvalidBefore**） |
| `/api/admin/users/{id}/role` | PATCH | root | 只收 admin/user；root 账户不可改；改完**吊销令牌** |
| `/api/admin/users/{id}/approve` | POST | root | status→active、guest→user；**不吊销令牌** |
| `/api/admin/users/{id}` | DELETE | root | root 不可删；删完吊销令牌 |
| `/api/admin/rooms` | GET | admin+ | 含 closed；批量查在线人数与 sharer 状态（消 N+1） |
| `/api/admin/rooms/{roomId}` | DELETE | root 或房主 admin | **物理删除**（级联），且**不写审计** |
| `/api/admin/rooms/{roomId}/reopen` | POST | root 或房主 admin | 仅 closed 可重开；清权限缓存 |
| `/api/admin/rooms/batch-delete` | POST | root | 逐个删，单个失败不中断，写审计 |
| `/api/admin/rooms/delete-all` | POST | root | 全删，**不写审计** |
| `/api/admin/rooms/cleanup-unused` | POST | admin+ | closed 直接清；active 需无未结束会话；admin 只清自己的 |
| `/api/admin/settings` | GET | admin+ | 18 个字段 + `desktopManaged`（运行时标识，不落库） |
| `/api/admin/settings` | PUT | admin+ | 逐字段校验，全部通过才整行保存 |

支撑改动：

| 文件 | 内容 |
|---|---|
| `internal/store/settings.go` | 补 4 列（`dataSourceConfig` / `cdnAccelerate` / `cdnProxyUrl` / `livekitExternalUrl`）+ `GetOrCreate` + `Save`（整行写） |
| `internal/store/user.go` | `ListAll` / `UpdateRole` / `Approve` / `Delete`；`scanUser` 改收 `rowScanner` |
| `internal/store/room.go` | `ListAll`（含 closed）+ `DeleteCascade`（一个事务删 7 张关联表 + room） |
| `internal/store/audit.go` | `AuditEntry` 补 `Target`（管理端审计要记「对谁做了什么」） |
| `internal/room/room_removal.go` | `DeleteRoomAndRelations`：内存 → 级联落库 → `room-closed` 广播 → 踢人 |
| `internal/auth/middleware.go` | `RequireAdmin` / `RequireRootExact`（两套 403 文案） |
| `internal/api/admin.go` | 12 个 handler + JSON 取值助手 |

对拍：`bash backend-go/scripts/http-admin-parity.sh`
→ **63 个步骤完全一致（状态码 + 响应体），0 处已知差异**。

#### 六处只有对拍（或读源码）才照得出来的细节

1. **三套 403 文案不能合并**。`middleware/auth.ts#requireRoot` 是「无权限：仅超级管理员可操作」
   （serverFiles 走它），`admin.ts#adminOnly` 是「无权限：仅管理员可操作」，
   `admin.ts#rootOnly` / `updater.ts` 是「无权限：仅 root 可操作」。同一个权限判定、
   三处不同措辞，全都是直接展示给用户的原文。
2. **列表排序不能加 tiebreaker**。Node 是 `find({order:{createdAt:'DESC'}})` → 单纯
   `ORDER BY "createdAt" DESC`。自己补个 `id DESC` 看似"更稳"，实际会在
   「同一秒创建的多行」上与 Node 排出相反顺序——两侧跑的是同一个 SQLite、同一份数据，
   用同一句 SQL 才是最忠实的做法（对拍脚本也因此必须显式错开 `createdAt`）。
3. **改角色要吊销令牌，审核通过不要**。改角色不吊销 = 被降级的管理员在令牌过期前
   仍带着 admin 权限通过每一条 `RequireAdmin`；而审核通过时吊销会让刚被批准的访客
   立刻掉线，掉的正是「等审核」那条会话。
4. **`Number.endsWith` 与 `Number.isNaN` 要分开判**。`/users/abc/role` 在 Node 是
   400「用户 ID 不正确」（`Number('abc')` 是 NaN），而 `/users/1.5/role` 是 404
   「用户不存在」（1.5 是合法数字、查不到行）。实现成一个「解析失败就 400」会让后者错。
5. **批量删除把不存在的房间号也计入 `count`**。`deleteRoomAndRelations` 不校验存在性
   （`DELETE` 0 行不报错），Node 的 `count++` 照样执行。这不是 bug，是必须保留的行为——
   单条删除有 404 守卫，批量删除没有。
6. **DELETE /rooms/:roomId 不写审计，batch-delete 写**。同一件事两条路径，一条有记录一条没有。

#### 房间自动清理定时器（阶段 22 补齐）

`modules/room/room-cleanup.service.ts` 已迁到 `internal/room/cleanup.go`：
`StartCleanupScheduler` 启动即跑一轮 + 每小时一次，删除 `status='active'` 且
`lastAccessedAt` 早于 `autoDeleteAfterHours` 的房间（`autoDeleteInactiveRooms`
关闭时整轮跳过）。store 侧加了 `Rooms.ListStaleActive`。

**注意这个定时器会让对拍出现假差异**：种子库 `config/dev.sqlite` 里的历史房间会被
单侧删掉，于是房间列表少一行、`count` 也差一。房间类对拍脚本的解法一直是种数据前
整表清空 `room` + `session`，并把种下去的 `lastAccessedAt` 设成"现在"——补了调度器
之后这条纪律更要守住。


### 3.10 字幕（阶段 16）

`routes/subtitles.ts`（290 行）+ `modules/subtitle/subtitle-source.service.ts`（715 行）
→ `internal/subtitle`（服务层）+ `internal/api/subtitles.go`（路由层）。

| 端点 | 方法 | 要点 |
|---|---|---|
| `/api/subtitles/search` | GET | 同目录下**前缀同名**的字幕（`EP01.mkv` 命中 `EP01.chs.srt`），内容一并返回 |
| `/api/subtitles/browse` | GET | 目录浏览；目录在前 → 简体中文排序；目录项**无 `size` 键** |
| `/api/subtitles/load` | GET | 返回**文件内容**（非 URL），前端转 data URL 走 socket 同步 |
| `/api/subtitles/embedded-tracks` | GET | 仅 emby / jellyfin；读 PlaybackInfo 的 `MediaStreams` |
| `/api/subtitles/embedded-extract` | GET | 调 Emby `Subtitles/{i}/Stream.{ext}`，Emby 负责转封装 |

支撑改动：

| 文件 | 内容 |
|---|---|
| `internal/subtitle/service.go` | 四源（server-files / ftp / openlist / webdav）取数编排 + Emby 内嵌轨道 |
| `internal/api/subtitles.go` | 5 个 handler + `sendSubtitleError`（按端点区分兜底状态码）+ `jsNumber` |
| `internal/openlist/openlist.go` | 新增 `ListDir` / `fsList`（AList `/api/fs/list`，带 401 重登） |
| `internal/webdav/webdav.go` | 新增 `OpenReadStream`（整文件 GET，不先 PROPFIND） |
| `internal/serverfiles/paths.go` | `CompareNames` 补 CLDR 中文「汉字优先于拉丁」重排 |

#### 五条必须保留的行为不变量

1. **`router.use(authenticateToken, requireMovieReadAccess)` 是路由级中间件**。它先于
   handler 执行，所以「缺 movieId」永远是中间件的 400「movieId 参数无效」，
   各 handler 自己写的「缺少 movieId 参数」「影片不存在」**全是死代码**。照抄 handler
   里的分支会得到两套状态码，前端一改就露。
2. **`index` 缺失与 `index=''` 不是一回事**。`Number(undefined)` 是 NaN（400），
   `Number('')` 是 0（合法，轨道 0）。只看「解析结果是否有限」会把前者误判成 0，
   于是从「缺少或无效的 movieId/index 参数」掉到「该影片未挂载服务器信息」。
3. **`index=1.5` 必须查不到轨道**。Node 是 `s.Index === streamIndex` 的数字相等，
   不是截断比较；Go 用 `float64` 承载，`int(1.5)` 会误命中轨道 1。
4. **`/embedded-tracks` 与 `/embedded-extract` 的 catch 默认 400**（不是 500），
   而 `/search` `/browse` `/load` 的 catch 默认 500。四个 catch 两种默认值。
5. **`/browse` 的排序是契约，`/search` 的不是**。browse 两侧都显式排序（目录在前 +
   中文排序），search 两侧都是目录原序（Node 的 `readdirSync` 不排序）。对拍时
   search 结果按 filename 排序后再比。

#### 中文排序：x/text 与 ICU 正好相反

`collate.New(language.SimplifiedChinese)` 走 CLDR **根规则**（拉丁字母在汉字之前），
而 Node 的 `localeCompare(name, 'zh-Hans-CN')` 走 CLDR **zh 定制**（汉字在拉丁之前）。
实测：

```
Node:  '_x' < '#tag' < '1.txt' < '123' < '阿凡达.srt' < '波西米亚.srt' < 'a.mkv' < 'Z.mkv'
x/text:'_x' < '#tag' < '1.txt' < '123' < 'a.mkv' < 'Z.mkv' < '阿凡达.srt' < '波西米亚.srt'
```

纯 ASCII 目录看不出差别，一旦混入中文标题整段颠倒。修法是在 `CompareNames` 里先按
**首个非空字符**分级（标点/数字 1 → 汉字 2 → 其他字母 3），同级再交给 Collator——
这样纯 ASCII 目录的相对顺序与改动前完全一致，中日韩与拉丁混排也回到 Node 的顺序。

#### 验收

```
$ bash backend-go/scripts/http-subtitles-parity.sh
✓ 44 个步骤完全一致（状态码 + 响应体）
```

远端源（webdav / ftp / openlist）本轮只覆盖「缺 serverUrl → 400」这类不需要真实
服务器的分支；真实取数由各自的 package 单测与 mount 对拍脚本覆盖。


### 3.11 B站 账号与内容浏览（阶段 17）

`routes/stream/bilibili-{account,videos,comments,lists,favorites,bangumi}.routes.ts`
（1,775 行）+ `helpers.ts`（233 行）→ `internal/bilibili` 的 account / browse /
comments / collections / favorites / bangumi 六个文件 + `internal/api` 的两个路由文件。
HTTP 面 107 → **129**。

| 端点组 | 端点 | 实现位置 |
|---|---|---|
| 账号 | `qr` / `qr/poll` / `login-status` / `cookie` / `cookie-login` / `logout` / `user-info` | `internal/api/bilibili_account.go`（265 行）+ `internal/bilibili/account.go`（430 行） |
| 视频 | `view` / `region-new` / `related` / `search` | `internal/api/bilibili_browse.go`（560 行）+ `internal/bilibili/browse.go`（700 行） |
| 评论 | `comments` / `comment-replies` | `internal/bilibili/comments.go`（275 行） |
| 栏目 | `link-meta` / `collection-videos` | `internal/bilibili/collections.go`（310 行） |
| 收藏 | `fav-videos` / `fav-folders` / `fav-list-videos` / `fav/collect` / `fav/status` | `internal/bilibili/favorites.go`（460 行） |
| 追番 | `following-bangumi` / `bangumi-episodes` | `internal/bilibili/bangumi.go`（215 行） |

支撑改动：

| 文件 | 内容 |
|---|---|
| `internal/bilibili/credential.go` | 补 `Save`（UPDATE 优先、未命中才 INSERT）与 `Clear`，base64 与 Node 逐字节兼容 |
| `internal/bilibili/permission.go` | `Service` 增加 `Browse *BrowseCaches` 字段 |
| `internal/bilibili/account.go` | 二维码生成（新增依赖 `github.com/skip2/go-qrcode`）、扫码轮询、SSO 逐跳收 Cookie、Cookie 校验 |
| 新增依赖 | `github.com/skip2/go-qrcode`（二维码 PNG；这是本轮唯一新增的第三方依赖） |

对拍：`bash backend-go/scripts/http-bilibili-parity.sh`
→ **36 个步骤完全一致**。

对拍方式与前面几轮不同：这批端点真的会打上游 B站，返回值随线上数据变化，
逐字段比对必然抖动。驱动器按端点性质分三档比较：

| 模式 | 比什么 | 用在哪 |
|---|---|---|
| `exact` | 状态码 + 完整响应体 | 参数校验、未绑定 B站 的 401 分支、login-status / cookie / logout |
| `shape` | 状态码 + 递归类型骨架（键集合与值类型，数组只取首元素形状） | view / region-new / related / search / comments / bangumi-episodes / qr |
| `status` | 只比状态码 | 上游结果不稳定（不存在的合集 id、公开收藏夹） |

`shape` 模式额外对「空列表」重试两次：B站 对匿名请求偶发 `code 0 + 空列表`
的软风控（不报错、只是没数据），两侧各撞一次就成了假差异。

两侧都**刻意不绑定 B站**：没有真实 Cookie 就不该假装能验「收藏成功」，
收藏夹/追番因此全部落在 401 分支。真实写路径（收藏 / 取消收藏）由
`favorites_test` 之外的假上游单测与手工冒烟负责。

#### 十一处「只有对拍（或读源码）才照得出来」的细节

1. **`/bilibili/view` 的 `pages` 不能复用解析链的 `VideoPage`**。后者带
   `duration`，而 Node 的该端点只下发 `page` / `part` / `cid`。复用会让响应
   骨架多一个键（这也是本轮唯一被对拍抓出来的形状差异）。
2. **`fav-videos` 的收藏夹选择顺序是四级 `??`**：显式 `mediaId` 命中 →
   `id === mid`（默认收藏夹）→ `list[0]` → 显式 id 兜底。写成「显式 id 优先」
   会让「传了一个不在列表里的 id」时选错夹。
3. **收藏夹列表在没有 `count` 时只翻一页**。Node 的 `total` 初值是
   `+Infinity`，每轮改成 `count ?? rawList.length`——接口不给 count 时它变成 0
   （取的是 append **之前**的长度），循环立刻结束。Go 侧初值必须写 `MaxInt64`，
   写 `-1` 会一页都不翻。
4. **扫码登录有两套状态语义**：新版是 `data.code`（86101/86090/86038 → 0/1/3，
   `code=0 && url` 才是 2），旧版是 `data.status`。映射顺序是「先看 code，
   未命中回落 status ?? -1」，不能只看一个。
5. **登录 Cookie 在 SSO 跳转链的每一跳里**。poll 只给一个跨域 URL，
   `SESSDATA` / `bili_jct` / `DedeUserID` 分散在 passport → biliGame 的若干次
   302 里，必须 `redirect: manual` 逐跳收 Set-Cookie，三个键缺一不可
   （缺 `bili_jct` 之后所有收藏/投币都会 -400）。
6. **搜索是虚拟分页**：单一排序最多 50 页（B站 硬限制），第 51 页起切换排序
   分片（click / dm / stow），映射写错一位就会出现「第 51 页翻回第 1 页」。
7. **评论必须带 buvid**：`reply/main` 缺 `buvid3` 直接命中 `-352` 风控；
   而且匿名只放前 3 条主楼（`is_end` 提前为 true），响应里的 `loginLimited`
   就是给前端提示「登录后查看全部」用的。
8. **`link-meta` 的 `/lists/{sid}` 分不出合集还是系列**。判据是
   `seasons_archives_list` 返回的 `meta.mid` 与链接 mid 是否一致——一致才是合集；
   不一致说明这个数字恰好是**别的 UP** 的合集 id，必须回退按系列查。
9. **401 文案有三套**：收藏夹/收藏状态是「B站 未登录」，`following-bangumi`
   是「未登录 B站」，`cookie-login` 在 userId 缺失时是「未登录」。同一类判定
   三种措辞，全是直接展示给用户的原文。
10. **`/user-info` 失败也是 200**。上游报错时把 `err.message`（含
    `B站 API 业务错误 [-101] 账号未登录: …`）原样放进 `message` 返回 200，
    前端据此显示「未登录」而不是弹「请求失败」。
11. **`fav/status` 未收藏时 `folderId` / `folderTitle` 整键消失**。Node 给的
    是 `undefined`，`JSON.stringify` 会丢键；Go 写成 `0` / `""` 会让前端的
    「已收藏在 X 夹」判断拿到空壳。

#### 刻意与 Node 不同的一处

收藏 / 取消收藏的 POST **不重试**。Node 的 `bilibiliFetch` 对所有请求都做
412 重试，但写操作重投会把刚做出的变更再翻一次（收了又取消），比直接报错
更难收拾。失败时用户点一次就好，混淆的副作用不可逆。


### 3.12 CMS 采集源（阶段 18）

`routes/cms.ts`（274 行）+ `services/cms/*`（797 行）+ `utils/resolve-cache.ts`
+ `utils/githubCdn.ts` → `internal/cms`（1,140 行）+ `internal/api/cms.go`（230 行）。
HTTP 面 129 → **135**（`/proxy` 早已由 `registerProxyRoutes` 统一挂载，不重复计）。

| 端点 | 说明 | 实现 |
|---|---|---|
| `GET /sources` | 列出 TVBox 配置里的 CMS 站点 | `service.go#Sources` |
| `GET /search` | 单站搜索 | `provider.go#Search` |
| `GET /search-all` | 全站并发聚合 + 标题去重 | `service.go#SearchAll` + `SearchAllCoalesced` |
| `GET /detail` | 详情与播放组 | `provider.go#Detail` |
| `POST /resolve` | 解析直链（6 分钟缓存 + 单飞） | `service.go#Resolve` + `resolve_cache.go` |
| `GET /inspect` | 预览配置（admin/root） | `tvbox.go#Load` |

支撑实现：

| 文件 | 内容 |
|---|---|
| `internal/cms/http.go` | `fetchText` + `decodeBody`（charset 嗅探：声明 → UTF-8 → GB18030） |
| `internal/cms/tvbox.go` | TVBox 配置解析（type 1 过滤、跳转配置递归 ≤2 层、10 分钟缓存 + 单飞 + 过期兜底） |
| `internal/cms/provider.go` | 苹果 CMS V10 客户端（videolist → detail 双 ac 兼容、`vod_play_url` 解析） |
| `internal/cms/resolve_cache.go` | 泛型 TTL + 单飞 + 容量淘汰缓存 |
| `internal/api/cms.go` | 6 个 handler；`inspect` 用 `auth.ClaimsFrom(ctx).Role` 判 admin/root |

对拍：`bash backend-go/scripts/http-cms-parity.sh`
→ **25 个步骤完全一致（状态码 + 响应体）**。上游是本地假采集站
（`scripts/mock-cms.js`：TVBox 配置 + 两个 CMS 接口 + 一份 GBK 配置），
数据固定，所以全部按 exact 比较——CMS 的「解析」本来就是纯函数。

#### 六处必须守住的细节

1. **`ac=videolist` 拿不到非空列表时要回退 `ac=detail`**。部分老站只认后者，
   少了这一步表现为「搜索永远没结果」，而且不报错。
2. **`vod_play_url` 的分组下标必须保留原始 `$$$` 序号**。空组会被跳过，但
   `playFromIndex` 是**原始下标**而不是「第几个非空组」——用后者会让
   「线路二」播成「线路三」。
3. **`parsePlayGroups` 与 `resolve` 共用同一套分组语义**：resolve 直接从原始串
   按组/集取地址（不经中间对象），保证直链是当下最新的；两边对 `#`/`$` 的
   切分规则必须逐字一致。
4. **charset 必须嗅探**：TVBox 配置与采集站大量是 GBK 且不声明 charset。
   优先级是「声明的 charset → 严格 UTF-8 → GB18030」；少了这一步中文站名
   整片乱码，表象却是「配置里没有 CMS 源」。
5. **配置拉取失败要用过期缓存兜底**，且空注册表不缓存。TVBox 配置源本身
   可用性波动很大，「拉不到就一个源都没有」是最差的降级。
6. **聚合搜索的站点顺序必须稳定**（按配置顺序），去重时保留先到者的位置、
   只在「先到者没有备注」时补上后来者的备注与封面。顺序一乱，前端列表
   每次刷新都换序，看过的条目会「跳走」。

#### 刻意与 Node 不同的一处

**不迁 PowerShell TLS 兜底**。Node 版 `fetchText` 在 fetch 失败后会起
`powershell Invoke-WebRequest`（借 .NET/Schannel 的 TLS 指纹绕过 Cloudflare）。
Go 的 TLS 栈本来就是独立指纹，不存在「Node 指纹被拦」这个前提；在服务端
起子进程既慢又会把错误信息变形。真遇到按指纹拦截的站点，应改 UA/Referer
或换源，而不是加回子进程。


### 3.13 动漫源（阶段 19）

`routes/animeSources.ts`（149 行）+ `services/anime/*`（922 行）
→ `internal/anime`（1,054 行）+ `internal/api/anime.go`（217 行）。
HTTP 面 135 → **139**（`/proxy` 同样早已由 `registerProxyRoutes` 统一挂载）。

| 端点 | 说明 | 实现 |
|---|---|---|
| `GET /sources` | 列出数据源（内置 B站 + 配置出来的 RSS/第三方） | `service.go#List` |
| `GET /search` | 按关键词搜索 | 由 provider 决定（见下表） |
| `GET /episodes` | 取分集 | 同上 |
| `POST /resolve` | 解析播放地址 | 同上 |

| 数据源 | 文件 | 说明 |
|---|---|---|
| `bilibili_bangumi` | `bilibili.go` | 关键词里能抠出 seasonId（`ss123`/`ep45`/裸数字）时**直连** pgc season，否则走 WBI 搜索 |
| `rss_{id}` | `rss.go` | RSS 2.0 / Atom，正则解析（不引 XML 解析器） |
| `third_party_{id}` | `thirdparty.go` | URL 模板（`{keyword}`/`{id}`）+ 字段回落链 |

顺带给 `internal/bilibili` 补了两个方法（`bangumi.go`）：
`SearchBangumi`（WBI 签名的 `media_bangumi` 搜索）与 `BangumiSeason`
（季信息 + 分集，含 `aid`）。**同一份 pgc 载荷有两套分集选取语义**：

- 路由 `/bangumi-episodes` 是 `result.episodes || result.main_section?.episodes || []`
  再「为空则拍平 section」——**空数组在 JS 里是 truthy**，所以 episodes 为空时
  不回落 main_section，直接进 section 拍平；
- 动漫源 `getBangumiEpisodes` 是三步都要求**非空**才采用（`if (x && x.length > 0)`）。

两处不能合并，改一处会让另一处回归。`BangumiEpisodes` 的 section 兜底条件
也在这轮被修正（原来是 `season.Episodes == nil`，应为 `len(episodes) == 0 &&
season.Section != nil`）——线上数据 episodes 非空时看不出来。

对拍：`bash backend-go/scripts/http-anime-parity.sh`
→ **23 个步骤完全一致（状态码 + 响应体）**。上游是本地假站点
（`scripts/mock-anime.js`：一份 RSS、一份 Atom、一组第三方端点），
数据固定所以按 exact 比较；唯一真打 B站 的「直连 seasonId」步骤用 shape。

#### 四处必须守住的细节

1. **`SearchResult` 的 `cover` / `description` 必须用指针**。Node 侧
   「字段不存在」与「空串」在 JSON 里是两种形态（前者整键消失）：RSS 源的
   `description` 永远存在（可能为空串），B站源的 `description` 只有上游给了
   才有。用 `string` + `omitempty` 会把两者混为一谈。
2. **`third_party` 的 `id` 回落链是 `id ?? animeId ?? seasonId ?? ''`**，
   而 `cover` 走的是**真值**判断（空串/0 都当没有）。两个操作符在 JS 里
   语义不同，Go 侧必须分开实现（`lookup` 跳过 null，
   `truthy` 判假值）。
3. **URL 模板里的 `encodeURIComponent` 要用 `%20` 而不是 `+`**。
   Go 的 `url.QueryEscape` 把空格编成 `+`（表单语义），放进路径段会变成
   字面量加号。对拍脚本专门让假上游回显**原始查询串**来锁这一点。
4. **默认端点自带占位符**：`{baseUrl}/episodes/{id}` 里本来就有 `{id}`，
   所以「含占位就插值，否则拼 `?id=`」的分支只对**用户自定义的**
   无占位模板生效。写成「默认走查询串」会让分集请求 404。

#### 刻意与 Node 不同的一处

**上游请求加了 30s 超时**。Node 的 `fetch` 没有超时，一个挂住的上游会永久
占着那条请求（Node 侧是事件循环里的一个 promise，Go 侧是一个泄漏的
goroutine + 连接）。超时后错误文案是 Go 自己的 `context deadline exceeded`，
与 Node 的 `fetch failed` 不同——只在上游真的挂死时才会看到。

### 3.14 ani-subs 订阅源（阶段 20）

`routes/anisubs.ts`（180 行）+ `services/anisubs/*`（1,679 行）
→ `internal/anisubs`（1,651 行）+ `internal/api/anisubs.go`（218 行）。
HTTP 面 139 → **143**（`/proxy` 同样早已由 `registerProxyRoutes` 挂载）。

| 端点 | 说明 | 实现 |
|---|---|---|
| `GET /sources` | 订阅展开后的数据源列表 | `service.go#List` + `subscription.go` |
| `GET /search` | 抓列表页 / JSON 接口搜索 | `scraper.go#ParseSearchResults` |
| `GET /episodes` | 抓详情页取分集 | `scraper.go#ParseEpisodes` |
| `POST /resolve` | 抓剧集页正则匹配播放地址（6 分钟缓存 + 单飞） | `scraper.go#ResolveVideoURL` + `ttlcache` |

顺手抽了两个共用包：

| 包 | 用途 | 原实现 |
|---|---|---|
| `internal/webfetch` | 上游文本抓取（charset 嗅探、Cloudflare 判定） | `cms/http.go` + `anisubs/httpClient.ts` 两份拷贝 |
| `internal/ttlcache` | TTL + 单飞 + 容量淘汰缓存 | `cms/resolve_cache.go` + `utils/resolve-cache.ts` |

新增依赖两个：`PuerkitoBio/goquery`（cascadia，CSS3 选择器）与
`dlclark/regexp2`（回溯正则）。

#### 五处必须守住的细节

1. **正则必须用 regexp2，不能用 RE2**。ani-subs 的 `matchVideoUrl` 大量使用
   `(?!...)` 负向先行断言（例如 `(?!.*http)` 排除「URL 里还套着 URL」），
   Go 的 `regexp` 编不出来 → 直接 `compileRule` 失败 → 一半数据源「匹配不到
   播放地址」。regexp2 是回溯引擎，**必须设 MatchTimeout**（规则来自社区，
   碰上灾难性回溯不能把进程拖住）。
2. **`Accept-Encoding` 一定要剥掉**。浏览器头里写着 `gzip, deflate, br`，
   照抄给 Go 会让服务端回 brotli，而 `net/http` 只会自动解 gzip（且只在它
   自己加的请求头时才解）——最后拿到的是一堆二进制，表象是「页面里找不到
   选择器」。`webfetch` 统一剥，单测里锁住了。
3. **`matchVideo.addHeadersToVideo.referer` 是三态**：键不存在 → 回落剧集页
   地址；存在且为空串 → **不带 Referer**；存在且非空 → 用它。用 `string` 会
   把中间那态吃掉（表现为某些防盗链源 403）。
4. **集号必须用 float64**。规则允许 `第 1.5 话`，Node 侧 `episodeNumber` 就是
   number，`id` 也和集号拼在一起（`第 1.5 话-1.5`）——取整会让 id 与前端
   记录对不上。
5. **内置订阅副本要吃掉 UTF-8 BOM**。两份 `default-*.json` 都带 BOM，Node 的
   JSON 加载器会剥、Go 的 `json.Unmarshal` 不会；不处理就是启动后
   「一个源都没有」。副本内容与 Node 侧逐字节相同，更新订阅时两边一起换。

#### 与 Node 的两处可见差异

- **`[*]` 作用在对象上时按键名排序**（JS 用属性插入序，Go 的 map 无序）。
  订阅里几乎都是数组，实际触发概率极低，排序至少保证可复现。
- **JSON 解析失败的错误文案不同**：Node 是 `Unexpected token '<' ...`，
  Go 是 `invalid character '<' looking for beginning of value`。都是 502。

对拍：`bash backend-go/scripts/http-anisubs-parity.sh`
→ **19 个步骤完全一致（状态码 + 响应体）**。上游是本地假站
（`scripts/mock-anisubs.js`：订阅 JSON + 列表页（a 格式/JSONPath 格式）+
详情页（无线路/线路分组）+ 剧集页 + RSS），数据固定所以全 exact。
抓站逻辑（选择器、JSONPath、正则规则、URL 补全、Referer 回落）都走真实
HTTP，一步到位覆盖两侧的解析差异。

### 3.15 Kazumi 规则源（阶段 21）

`routes/kazumi.ts`（179 行）+ `services/kazumi/*`（1,751 行）
→ `internal/kazumi`（2,309 行）+ `internal/api/kazumi.go`（198 行）。
HTTP 面 143 → **147**（`/proxy` 同样早已由 `registerProxyRoutes` 挂载）。

| 端点 | 说明 | 实现 |
|---|---|---|
| `GET /sources` | 规则展开后的数据源列表（id = `kazumi_{展开下标}`） | `ruleloader.go` + `service.go` |
| `GET /search` | `searchMode=xpath` 抓搜索页 / `=api` 走 JSON | `provider.go` / `api_rule.go#APISearch` |
| `GET /episodes` | `chapterMode=xpath` 抓详情页 / `=api` 走 JSON | `provider.go` / `api_rule.go#APIChapters` |
| `POST /resolve` | 抓播放页并沿回退链取地址（6 分钟缓存 + 单飞） | `scraper.go#resolveVideoURL` |

规则的两套运行时：

| 模式 | 实现 | 说明 |
|---|---|---|
| XPath | `scraper.go` | x/net/html 建树 + antchfx/xpath 查询；`parser` 比 Node 少两次序列化 |
| API | `api_rule.go` | 受限 JSONPath（`$.a.b[*]['k']`）+ `@var` 模板 + GET/POST（json/form） |

新增依赖两个：`antchfx/htmlquery`（含 `xpath`）与 `golang.org/x/net/html`（后者本已在依赖树里）。

#### 六处必须守住的细节

1. **`textContent` 不含注释**。DOM 的 textContent 只拼文本节点；页面上写
   `<!-- 注解 -->番剧三` 时，Node 得到「番剧三」，把注释也算进去会多出几个字。
   （对拍第一轮就抓到了这条。）
2. **集号正则不能复用 anisubs 的**。`ExtractEpisodeNumber` 的默认规则只有
   `第 N 话/集`，命不中返回 0；Kazumi 的正则是
   `第\s*(\d+(?:\.\d+)?)\s*[话集]|(\d+(?:\.\d+)?)`，`EP12` 要得 12。
3. **单 `/` 开头是绝对路径**。`ezdmw` 的 `chapterResult` 是
   `/self::*[@class='line_button1']/following-sibling::a[...]`；Node 只给
   `//` 开头的表达式补 `.`，所以它在**文档根**上求值（结果是空）。Go 侧必须
   显式切回文档根，否则会「意外修好」这条规则、与 Node 行为不一致。
   `//x` 则始终是「当前子树」（navigator 的根落在 scope 上即可等价）。
4. **URL 归一化的端口比较要用显式端口**。WHATWG 解析会把默认端口丢掉，
   所以 `http://a.com` 与 `https://a.com` 的 `port` 都是空串；按「有效端口」
   比（80 vs 443）会漏掉「同站换协议」这一支（Node 确实会把 http 改成 https）。
5. **序列化要按 WHATWG 的可见规则自己拼**：空 path 补 `/`、默认端口去掉、
   主机小写、path 百分号编码。Go 的 `url.String()` 这四样都不做，直接用会
   让同一部番在两侧得出两个不同的 id。
6. **`renderMap` 的 `String()` 与 `renderTemplate` 的空串不是一套语义**：
   `renderTemplate` 里 null → `''`，`renderMap`（headers/query）里 null →
   `'null'`。两个都要照抄，别合并。

#### 三处可见差异

- **query 参数按键名排序**。Node 用对象插入序，Go 的 map 无序。上游对参数
  顺序不敏感，只在「生成的播放页 URL 里有多个 query 键」时才看得出来。
- **`~` 不编码**。`url.Values.Encode` 保留 `~`，而 `URLSearchParams` 编成
  `%7E`。
- **`[*]` 作用在对象上时按键名排序**（同 anisubs 那条）。

对拍：`bash backend-go/scripts/http-kazumi-parity.sh`
→ **20 个步骤完全一致（状态码 + 响应体）**。假站 `scripts/mock-kazumi.js`
提供规则索引（含非法名、坏规则）、XPath 规则的搜索/详情页、6 种播放页
（直链 / `player_aaaa` 两种加密 / iframe 嵌套 / HHJX bootstrap / youku 拿不到）
与 API 规则的三个接口（POST JSON 搜索、nested、delimited）。索引指向
`index.json` 而不是逐个规则文件，顺带锁住「坏规则跳过但下标不塌陷」
（期望 id 是 `kazumi_0/1/2/4`）。

### 3.16 多源弹幕（阶段 22）

`routes/danmaku.ts`（218 行）+ `services/danmaku/*`（1,213 行）
→ `internal/danmaku`（1,644 行）+ `internal/api/danmaku.go`（237 行）。
HTTP 面 147 → **151**。

| 端点 | 说明 | 实现 |
|---|---|---|
| `GET /sources` | 四个内置源（顺序即下拉框顺序） | `service.go` |
| `GET /search` | 简繁三路并行搜索 + 去重 + 模糊优先 | `api/danmaku.go#handleDanmakuSearch` |
| `GET /episodes` | 取分集 | 各 provider |
| `POST /fetch` | 取弹幕（统一成 rolling/top/bottom 三档） | 各 provider |

| 源 | 文件 | 上游 |
|---|---|---|
| `bilibili-video` | `bilibili.go` | 复用已迁的 `Search` / `GetVideoInfo` / `GetDanmaku` |
| `bilibili-bangumi` | `bilibili.go` | 复用 `SearchBangumi` / `BangumiSeason` / `GetDanmaku` |
| `bahamut` | `bahamut.go` | 抓 HTML（搜索页/作品页）+ 弹幕接口 |
| `dandanplay` | `dandanplay.go` | 开放平台 API（签名认证） |

#### 简繁转换不能用近似表

`toTraditional` / `toSimplified` 决定搜索关键词，转错就是「巴哈姆特一条都搜不到」。
Node 用的是 opencc-js，Go 侧没有等价库，所以**把词典导出来自己实现最长匹配**：

- `scripts/gen-opencc-data.js` 从 `node_modules/opencc-js` 导出 7 份词表（1.0MB）；
- `internal/danmaku/chinese` 按 opencc-js 的结构跑：**组内多份词表合并成一棵
  Trie，组与组之间才是多趟**。

那个「组内合并」不是实现细节，是语义：`周杰伦 → 周杰倫`、`面条 → 麪條`
（再过一趟 TWVariants 才是 `麵條`）、`乾隆`（繁→简时不许变成「干隆」）全靠
长词优先。一开始我按「一个词表一趟」实现，逐字那一趟先改掉 `杰→傑`，词条
就再也匹配不上，实测得到 `周傑倫`、`頭發` 这种半对半错的结果。

#### 三处必须守住的细节

1. **弹弹play 的 mode 1/2 与统一格式相反**：它 1=底部、2=顶部，统一格式
   1=顶部、2=底部。照抄不换位会让顶部弹幕跑到底部。
2. **`parseInt` 只吃前缀**：`#12zz` 要得 18（`parseInt('12zz',16)`），
   `16711680` 会被当成十六进制（37.6 亿）而不是十进制。Go 的 `strconv` 遇到
   尾随垃圾直接报错，所以写了个 `parseIntPrefix`。
3. **`SearchItem` 新增的三个字段不能进 JSON**：弹幕搜索要 `aid` / `favorites` /
   `review`，但 `/bilibili/search` 的 DTO 只有 8 个键。三个字段一律
   `json:"-"`，否则 stage 17 的 36 步对拍立刻挂。

#### 对拍方式：Node 生成期望值

弹幕源的上游地址全是硬编码的（`ani.gamer.com.tw` / `api.dandanplay.net`），
没法像其它模块那样起假站。改成：

- `internal/danmaku/testdata/` 放夹具（搜索页 HTML、作品页 HTML、三个接口 JSON）；
- `scripts/gen-danmaku-fixtures.js` 把 Node 的 `globalThis.fetch` 换掉、按
  「host + path」返回夹具，然后调 **Node 的 provider**，把输出写成 `expected.json`；
- Go 侧 `provider_test.go` 用同一份夹具跑自己的 provider，逐字段与 `expected.json` 比对。

9 个用例（巴哈姆特搜索/多集/单集回落/弹幕两态、弹弹play 搜索/多集/空集/弹幕）
全部一致。这比写死断言强：期望值来自真实实现，不是我以为的实现。

另：`/search` 的简繁合并逻辑（三路并行 → 按原顺序合并 → 按 id 去重 →
标题命中的排前面）在 `internal/api/danmaku_test.go` 里用「按关键词返回不同
夹具」的 transport 锁住。

### 3.17 一起听音乐（阶段 23）

`modules/music/{music.routes,ncm-api.service,ncm-api-client,ncm-account.service,
ncm-cookie.service,ncm-forward.service,ncm-stream.service,ncm-stream.handlers}.ts`
（1,381 行）→ `internal/ncm`（1,354 行，另有 406 行测试）+ `internal/api/music.go`
（491 行）+ `store.NcmCredentials`（150 行）；阶段 34 再补 `internal/ncmapi`
（1,425 行 + 493 行测试）承接原来那个 npm 包的协议层。HTTP 面 151 → **160**。

| 端点 | 说明 | 实现 |
|---|---|---|
| ANY `/api/music/ncm/*` | 注入当前用户 cookie 后转发到内部 NCM 服务 | `forward.go#Forward` |
| `GET /ncm-cookie` | 导出持久化 Cookie（迁移/备份） | `api/music.go` |
| `POST /ncm-cookie-login` | Cookie 登录（两种输入格式）+ 校验登录态 | `api/music.go` |
| `POST /cloud/upload` | 云盘上传（multipart 原样流转发） | `forward.go#CloudUpload` |
| `GET /album/full` | 专辑详情（登录态截断时匿名补齐） | `account.go` |
| `GET /login/status` | 登录状态（按需补昵称/头像/会员） | `account.go` |
| `POST /logout` | 删除持久化凭证 | `api/music.go` |
| `GET /stream` | 音质降级链解析 + Range 流式转发 / 直链 302 | `stream.go` + `api/music.go` |
| `GET /song-quality` | 实际解析音质元数据（15 分钟缓存） | `api/music.go` |

#### 最大的一处架构差异：NCM 服务（阶段 23 外部化 → 阶段 34 进程内）

阶段 23 把网易云协议**外部化**了：Node 用 `@neteasecloudmusicapienhanced/api`
在本进程内起`127.0.0.1:36530` 的服务，Go 不可能重写那 3 万行所以改成指向外部服务。

阶段 34 补上了这块：`internal/ncmapi` 复刻同一个 REST 方言并跑在进程内，
`NCM_API_BASE` 由 `StartBundled` 改写成哨兵地址 `http://ncm.internal`（请求由
自定义 `RoundTripper` 直接交给 handler，**不建连接、不占端口**），**默认交付不再需要额外服务**。
外部化路径没有删——显式 `NCM_API_BASE` 或 `NCM_UPSTREAM=node` 仍会走外部/随包 Node。
细节见**第十三节**。

`internal/ncm` 这一侧的行为完全没变，仍然负责：凭证读写、转发（注入 cookie、
绕 apicache、剥客户端传的 `cookie`/`noCookie`）、业务编排（音质降级链、直链缓存、
音频流 Range 代理）。判断上游在不在仍靠一次轻量探测：在线缓存 30s、离线 3s，
不可达时一律 503 `NCM_UNAVAILABLE`——只是现在它基本不会触发了。

#### 六处必须守住的细节

1. **扫码三接口必须无 cookie 调用**（`/login/qr/key|create|check`）。网易云按
   请求携带的 cookie 判定登录态，注入旧凭据（尤其过期的 MUSIC_U）会让二维码
   轮询进 800 循环，表现为「二维码扫了没反应」。对拍里专门有一步回显 cookie。
2. **转发要剥掉客户端传的 `cookie` / `noCookie`**（query 与 body 两处），否则
   客户端能用参数覆盖服务端注入的登录态——这是个越权口子，不是洁癖。
3. **每次调用都要带 `timestamp`**。内部服务挂了 2 分钟的 apicache，缓存 key
   只含 method+URL（不含 cookie），不同登录态会互相串味（匿名结果被 VIP 用户
   拿到）。唯一化 URL 是唯一解。
4. **弹弹play 那条之外的 mode 陷阱：音乐这边是 `/song/url/v1` 的 `level` 与
   老接口的 `br`**。v1 依赖残缺时模块顶层 require 会抛 MODULE_NOT_FOUND，路由
   返回 404；老接口 `/song/url` 没这个依赖、始终可用，所以降级链里必须回退它，
   并把 `level` 补写进响应，否则缓存与元数据都会缺档位。
5. **`freeTrialInfo` 非空 = 试听片段 = 不可用**。继续沿降级链走；整链都失败时
   它是 `VIP_REQUIRED` 的判据（不是 `RESOLVE_FAILED`）。
6. **直链必须是 `*.music.126.net`**。上游给什么都要自己核一遍域名——否则一个
   被污染的响应就能把服务端变成任意地址的下载器（SSRF）。直链模式下还要把
   `http://` 改写成 `https://`，不然 https 页面会被 mixed content 拦。

#### 刻意与 Node 不同

- **`NCM_API_BASE` 的默认值与探测**：Node 的 base 只在自己启动成功后才有值，
  不会指向一个「别人起的」服务。Go 默认就看 36530，这是外部化的必然结果；
  如果那个端口上跑着不兼容的服务，行为会与 Node 不同（Node 会 503）。
- **不迁移 `ncm-api.service.ts` 的启动/重试逻辑**（端口 +1 重试、就绪轮询）。
  那是「拉起 npm 包」的胶水，外部化之后没有意义。

#### 对拍方式：给 Node 换上游

Node 的 base 是模块级变量、没有 setter。对拍驱动器
（`scripts/ncm-parity-preload.js`）在加载前把 `ncm-api.service` 的编译产物塞进
`require.cache`，让 `getNcmApiBase()` 返回假服务地址；Go 侧读同一个
`NCM_API_BASE`。两侧打同一份假上游（`scripts/mock-ncm.js`），数据固定
→ 全部 exact 比较。

`bash backend-go/scripts/http-music-parity.sh` → **41 个步骤完全一致**。
覆盖游客/登录/退出三种身份、Cookie 登录两种输入格式、凭证落库、转发注入与
剥离、扫码不带 cookie、上游 3xx 与非 JSON、专辑匿名补齐、音质降级链（试听 /
无版权 / 非白名单域名 / 老接口回退）、直链 302 与缓存、音质元数据与缓存、
云盘 multipart 透传。

**代理模式（`direct=0`）的对拍缺一步**：假上游的直链域名必须是
`*.music.126.net` 才能过 SSRF 校验，而那个域名不可能指向本地假站。所以
`ProxyAudio` 的 Range/206 透传由 `internal/ncm/ncm_test.go` 的
`TestProxyAudioPassesThroughRange` 覆盖（httptest 上游 + Range 断言）。

### 3.18 更新器（阶段 24）

`services/updater/{index,script-templates}.ts`（1,131 行）+ `routes/updater.ts`
（266 行）→ `internal/updater`（~1,000 行）+ `internal/api/updater.go`（300 行）
+ `internal/updater/templates/*.tmpl`（8 份脚本模板）。HTTP 面 160 → **165**。

| 端点 | 说明 | 实现 |
|---|---|---|
| `GET /api/system/update/check` | 查 GitHub Releases，判定是否有更新 | `github.go#GetUpdateInfo` |
| `POST /apply-stream` | 下载 + 应用（SSE 进度） | `apply.go#ApplyUpdate` |
| `POST /apply` | 同上，无进度（兼容旧前端） | 同上 |
| `POST /upload-stream` | 上传包 + 应用（SSE 进度） | `apply.go#ApplyUpdateFromFile` |
| `POST /upload` | 同上，无进度 | 同上 |

三层门禁顺序照抄 Node：`authenticateToken`（401）→ root（403「无权限：仅 root
可操作」）→ 桌面托管（409 + `desktopManaged: true`）。顺序不能换——409 放在
鉴权前面等于对陌生人宣告「这台是桌面版」。

#### 核心设计：本进程永不替换自己

Node 与 Go 走的是同一条路：下载/解压都做完后，生成一份平台脚本
（Windows `apply-update.bat`、裸机 Linux `apply-update.sh`、容器
`apply-update.sh` 的另一个差异段），detached 拉起后立刻返回。

脚本负责：停服 → 备份 `config/` → 覆盖程序文件 → 恢复 `config/` → 重启。
之所以不能在本进程里干，两个平台的限制都是硬的：

- Windows 不允许覆盖正在运行的 exe（`ERROR_SHARING_VIOLATION`）；
- Linux 覆盖运行中的 ELF 会把进程打成 SIGBUS（`cp` 截断正在被映射的段）。

容器版还有第三层差异：先 `touch .restart-backend` 再按 PID 发 SIGTERM，
让 entrypoint 的监控循环知道「这次退出是更新」而不是崩溃，随后由它重启后端
（不重启容器，`config` volume 状态保持）。

#### 脚本模板用 go:embed 而不是 Go 字符串

TS 模板字面量里的 `\` + 换行是 **LineContinuation，编译后反斜杠与换行都不存在**
（bat 里那段 PowerShell 续行实际拼成了一行）。手抄成 Go raw string 必然抄成
「看着像但字节不同」的版本，而这两份脚本要原样落盘并被 cmd/bash 执行。

所以加了 `scripts/dump-updater-templates.js`：把 Node 导出的 8 个字符串原样写进
`internal/updater/templates/*.tmpl`，Go 侧 `//go:embed` 读入，只重写占位符渲染
（多轮替换，最多四轮——差异段自身还带 `{{TAG}}`）。改了 Node 模板就重跑一次导出。
模板文件在 `.gitattributes` 里钉了 `eol=lf`：检出成 CRLF 时 bash 会因为 shebang
里的 `\r` 直接报错，表象是「更新脚本一闪而过、文件没替换」。

#### 版本判定：四类分支一个纯函数

`selectRelease` 单独抽出来是因为它的分支最多、又没法在对拍里覆盖
（本地版本取自 `package.json`，进程内改不了）：

| 本地版本 | includePrerelease | 取哪条 release | hasUpdate |
|---|---|---|---|
| 任意 | true | 列表第一条（GitHub 按 created_at 降序） | 见下 |
| `0.0.0` / `0.0.0-dev.*` | true | 第一条 | 恒 true |
| 正式版 | true | 第一条 | 第一条是预发布 → true；否则语义化比较 |
| `0.0.0` | false | 第一条正式版（无则第一条） | 恒 true |
| `0.0.0-dev.*` | false | 第一条正式版 | 恒 true |
| 正式版 | false | 第一条正式版（无则第一条，但不提示更新） | 语义化比较 |

`CompareVersions` 逐段复刻 `Number(x) || 0`：`core.split('.').map(Number)` 对
`0-dev.<sha>` 这种段会产生 NaN，Node 静默按 0 处理，Go 必须同样宽松。
prerelease 后缀按**字典序**比较（`beta.2 > beta.10`），看着反直觉但 Node 一直
这么跑——两端不一致会让同一个 release 给出相反的「有没有更新」。

#### 对拍：只覆盖拒绝路径

`bash backend-go/scripts/http-updater-parity.sh` → **16 个步骤完全一致**
（401 ×5、403 ×5、400 ×3、SSE error 事件、扩展名校验）。

成功路径不进军对拍脚本：它会真的下载发布包、覆盖程序文件，并拉起一个
**第一件事就是 `taskkill /IM node.exe`、把仓库根 `config/` 挪走**的脚本。

这不是理论风险。第一版脚本里塞了一步「扩展名对但内容不是压缩包」，实测
Node 侧返回 **200**：Windows 分支用 `powershell Expand-Archive` 解压，非压缩包
时错误只落在 stderr、**退出码仍是 0**，于是 Node 一路走到拉起脚本，把当次对拍
的 Node 进程连同仓库根的 `config/` 一起处理了一遍（脚本在 `ping` 等待阶段被
`kill_tree` 打断，`config` 随后恢复，未造成损失）。Go 用标准库解压，同输入直接
`解压失败` → 500。

这一条已记进「刻意与 Node 不同的地方」：Node 的「假成功」是它自己的缺陷，
不该被当成对拍基线；Go 的行为由 `internal/api/updater_test.go` 单测钉住。

版本判定的期望值另走 `scripts/gen-updater-fixtures.js`：把 `https.get` 换成
按 URL 回夹具的实现、`system-settings` 直接塞进 `require.cache`（否则会链条式
拉进 typeorm 全部 entity），调 Node 的 `getUpdateInfo` 生成
`testdata/check-expected.json`，Go 单测拿同一份 releases 喂假 GitHub 逐字段比对。

### 3.19 语音（阶段 25，3 端点）

`routes/voice.routes.ts`（232 行）→ `internal/voice`（340 行）+ `internal/api/voice.go`
（337 行）。媒体面完全在 LiveKit，后端只做三件事：签 token、调 Twirp 禁言/踢人、
告诉客户端连哪个地址。

| 端点 | 语义 |
|---|---|
| `POST /api/voice/token` | 400 缺 roomId → 404 房间不存在或已关闭 → 403 尚未获准进入房间 → 503 未配置 → 200 `{success,url,token}` |
| `POST /api/voice/mute` | 400 缺参 → 403 无权限 → 404 目标不在语音中 → 静音 AUDIO 轨 + 写 metadata |
| `POST /api/voice/kick` | 400 缺参 → 403 无权限 → `RemoveParticipant` |

#### 五处必须守住的细节

1. **`trackKind` 把缺失的 `type` 当成 AUDIO**。protojson 省略零值枚举，AUDIO 轨的
   `type` 字段常常整个不存在；当成「未知」就会漏禁言，表现是「管理员点了禁言但对方还能说」。
2. **客户端 token 带 `sub`、admin token 不带**。客户端 `user:<id>` 让重连顶替同一条轨，
   游客 `guest:<base36 时间戳><4 位随机>` 每次加入换一次性身份（否则两个游客互顶）。
   admin token 只带 `video.roomAdmin + video.room`，10 分钟有效。
3. **JWT header 只有 `alg`**，与 livekit-server-sdk 同形；claims 字段名必须是 camelCase
   （`roomJoin` 而不是 `room_join`），写错不报错、只是没权限。
4. **禁言只 mute 音频轨，metadata 每次都要写**。解禁时不调 `MutePublishedTrack`，
   但仍要 `UpdateParticipant({metadata:{adminMuted:false}})`——客户端靠它恢复麦克风。
5. **权限是四级**：root / admin-房主 / 房主 / 房管（`moderators` JSON 数组）。
   少一级就会出现「房管禁不了人」，多一级就是越权。

#### 对拍方式：假 LiveKit

`scripts/mock-livekit.js` 固定两个参与者（各带 AUDIO/VIDEO 轨）、记录收到的 Twirp 调用；
`http-voice-parity.sh` → **14 个步骤完全一致**（含 JWT payload 与三次管理的调用序列）。

- 请求形状与 sdk 一致：`POST /twirp/livekit.RoomService/<Method>`，JSON 体，camelCase。
- 比较 JWT 时**忽略 `iat/exp/nbf`**：Node 的 jose 会自动加 `iat`，Go 不加；只比
  `iss/sub/name/video` 与 `(exp-nbf)/3600`。
- 503（未配置密钥）不在对拍里（两侧都得配好密钥才能跑其余步骤），由
  `internal/api/voice_test.go` 覆盖。

### 3.20 OBS 推流（阶段 26，1 端点 + `/live` 反代）

`modules/stream-push/*`（547 行）→ `internal/nms`（230 行）+ `internal/api/streampush.go`
（420 行）。REST 只有 `GET /api/stream-push/obs-config/:roomId`，外加 `/live` 的
HTTP-FLV 反代与两个 socket 事件（`update-share-method` / `query-stream-push-availability`，
早前已在实时层迁完，本阶段把「恒 false」换成真探测）。

#### 最大的架构差异：NMS 外部化

> 2026-10-25 补：这条外部化方案在**阶段 33 改回进程内实现**（见 3.26），
> 下面「外部化」的配置与探测语义作为**可选路径**保留（`NMS_HTTP_FLV_URL`）。
> 保留这一段是为了记住当时的取舍与探测缓存的原因。

`node-media-server` 是纯 Node 库（RTMP 3334 + HTTP-FLV 3335），Go 侧不内嵌，改成：

| 变量 | 作用 |
|---|---|
| `NMS_HTTP_FLV_URL` | `/live` 反代上游 + 可用性探测目标（默认 `http://127.0.0.1:3335`） |
| `RTMP_PORT` | OBS 配置里的推流端口（默认 3334） |
| `SERVER_HOST` | 推流地址里的主机名（缺省从请求 Host 推导） |
| `STREAM_PUSH_ENABLED=0` | 与 Node **同名开关**：显式关闭，不探测、恒不可用 |

可用性 = 「上游 TCP 端口连得上」，带 5s 缓存（Node 是进程内布尔量、零延迟；
socket 事件会反复问，每次握手太浪费）。部署含义：只跑 Go 版时推流需要额外跑
一个 NMS 兼容服务（node-media-server / SRS / mediamtx 均可），与一起听的 NCM
外部服务同一套策略。

#### 四处必须守住的细节

1. **OBS 场景集合的形状要逐字段贴近**：`sources[0]`（场景）**没有** `private_settings`，
   `sources[1]`（rtmp_output）**有**——多一个键就可能被 OBS 的版本迁移改写。
   `private_settings` 必须初始化成 `{}`（nil map 会序列化成 `null`）。
2. **`shareMethod` 不在 obs-config 里落库**。Node 是 `roomRepo.save(room)` 整行写；
   Go 只写 `streamKey` 一列——「先下配置、再切子模式」是正常流程，顺带改 shareMethod
   会把刚切好的状态打回去，整行写还会覆盖并发修改的其他列。
3. **Host 头在 Go 是 `r.Host`**，不在 `r.Header` 里。用 `r.Header.Get("Host")` 会永远
   拿到空串 → 推流地址变成 `rtmp://localhost:3334/live`（局域网里推不上去）。
4. **`/live` 在 NMS 不可用时要落到 SPA 回退**（Node 的 `return next()`），不是 502。
   路径不以 `/api/` 开头，最终返回 index.html。注册顺序必须在 `mux.Handle("/")` 之前。

#### 对拍与单测

`bash backend-go/scripts/http-streampush-parity.sh` → **6 个步骤完全一致**
（401 / 404 / 400 / 首次生成推流码 / 二次复用同一码 / 已有码复用）。推流码随机，
驱动侧归一化成 `<KEY>` 并额外断言「两处一致」「二次请求没换码」。

`/live` 不进对拍：需要一条真实 RTMP 推流才有字节可比。由
`internal/api/streampush_test.go` 用假 NMS 覆盖（字节透传、头、原始 URI 含查询串、
不可用回落 SPA、长连接首块即时可见）。

### 3.21 ACME / 自签证书（阶段 27，收尾）

`services/ssl/*`（1,023 行：`self-signed-cert` / `acme-client` / `cert-cli`）→
`internal/ssl`（cert / acme / cli，共约 1,100 行）+ `main.go` 的 `--gen-cert` 分流与
HTTPS 启动分支。

这一块不是 HTTP 端点，而是**启动期与 CLI 行为**：`HTTPS=true` 时自动签自签证书、
`--gen-cert` 支持「域名 → Let's Encrypt / 内网 → 自签」双模式。

#### 三个入口

| 入口 | 行为 |
|---|---|
| `HTTPS=true` 启动 | 证书缺失 → 自动签自签（CN=localhost），随后 `ListenAndServeTLS` |
| `--gen-cert [host] [选项]` | 签发后退出，**不连库、不起服务** |
| `--gen-cert --help` | 打印用法后退出 |

`--gen-cert` 必须在 `db.Open` 之前分流——Node 也是在 `bootstrap()` 之前判断的，
先连库会让「只想签个证书」的场景因为数据库被占用而失败。

#### 四处必须守住的细节

1. **私钥形态是 PKCS#1**（`BEGIN RSA PRIVATE KEY`）。Node 用 node-forge 的
   `privateKeyToPem`，产出 PKCS#1；域名密钥则用 `export({type:'pkcs8'})`，是 PKCS#8。
   两个形态不能混：自签私钥写成 PKCS#8 时 Node 侧仍然能读，但两端的文件不再可互换，
   排查「换了实现之后证书加载失败」会多绕一圈。
2. **RFC 7638 指纹的键顺序是 `e → kty → n`**，且 n 不能带前导零。顺序错了
   keyAuthorization 就不对，表象是 CA 来取挑战文件时 404 或内容不匹配。
   单测里用 RFC 7638 §3.1 的官方示例公钥做黄金值
   （`NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs` 那一条）。
3. **POST-as-GET 的 payload 必须是空串**，不是 `{}`。ACME 的授权/订单/证书下载
   都是 POST + 空 payload；写成 `{}` 会被 Boulder 当成「停用授权」而报错。
4. **公网 IP 证书要带 `profile: "shortlived"`**（Let's Encrypt 的硬要求，160 小时），
   不带直接拒单。DNS 证书不带。

#### 为什么手写 ACME 而不是用 x/crypto/acme

三条理由：IP 标识符 + shortlived profile 的支持取决于库版本；错误文案与轮询节奏
（3s / 120s / 60s）是用户可见行为；手写之后可以用假 ACME 服务器把整条链路跑成单测。

#### 验证

- `internal/ssl/acme_test.go`：假 ACME 服务器会**真的按 RFC 流程验签**（nonce 一次性、
  签名、`protected.url` 与请求路径一致），并在收到 challenge 通知后**真的用 HTTP 去
  挑战端口取 keyAuthorization**——这比「断言收到了某个字段」强得多，能抓住
  「本机挑战服务器没起来」「token 没写进去」「指纹算错」三类致命问题。
  还校验 finalize 的 CSR 能解析、SAN 正确、签名有效。
- `bash backend-go/scripts/https-smoke.sh` → **19 项检查全过**：用法文案、自签 CN/SAN/
  10 年有效期（openssl 复核）、二次运行跳过、`--force` 指纹变化、域名写进 SAN、
  `HTTPS=true` 自动生成 + TLS 握手 + `/health`、明文 HTTP 拿不到业务响应。
- ACME 真连 CA 无法自动化（需要公网域名 + 80 端口），这条由上面的假 CA 覆盖；
  真机验证方式是 `--gen-cert <域名> --staging`。

### 3.22 OpenList 挂载与解析（阶段 28，13 端点）

这一节是**阶段 5 检查单逼出来的**：之前台账把「挂载源（openlist/webdav/ftp/emby）」
记成已完成，实际只迁了 `GET /api/openlist/stream` 一条。`scripts/route-parity.sh`
（Node 路由表运行时导出 → 逐条打 Go）一跑就红了 13 条：

| 缺口 | 端点 |
|---|---|
| OpenList 挂载管理 | `GET/POST /api/openlist/mounts`、`POST /mounts/test`、`PUT/DELETE /mounts/{id}`、`GET /mounts/{id}/browse` |
| OpenList 文件解析 | `GET /api/openlist/resolve`、`/direct-url`、`/me`、`/proxy`、`/search` |
| stream 媒体代理 | `GET /api/stream/proxy`（带鉴权）、`GET /api/stream/proxy-image`（免鉴权） |

`routes/openlist.ts`（789 行）→ `internal/api/openlist_mounts.go`（约 600 行）+
`internal/openlist` 扩到约 780 行（新增分页列举、搜索、me、连通性测试）。

#### 与 WebDAV 那套只有三处不同

1. **地址要补 `/dav`**：`NormalizeServerURL` 会补 scheme、补 `/dav`。用户填
   `192.168.1.5:5244`，挂载表里存 `http://192.168.1.5:5244/dav`，两边不一致就永远
   匹配不上（表象是「影片有密码却提示未授权」）。
2. **密码要哈希后落库**：`sha256(明文 + "-https://github.com/alist-org/alist")`，
   与 AList 官方前端一致。落库形态同时决定登录走 `/api/auth/login` 还是
   `/api/auth/login/hash`（靠「64 位 hex」判断）。
   **测试连接也必须用哈希后的密码**，否则会出现「测试通过、保存后失败」。
3. **流代理透传的是 `fs/get` 的带签名 `raw_url`**，不是 WebDAV 的字节流。

#### 三个容易漏的行为

- **`/direct-url` 对内网地址硬拒**（`INTERNAL_NETWORK_FORBIDDEN`）：即使挂载记录里
  `directLink=true` 也要再拦一次——旧数据可能带着过期的直链设置，而浏览器根本连不到
  `192.168.x.x`，给了直链只会让播放器停在「加载中」。
- **`/me` 与 `/search` 的 NOT_FOUND 不映射成 404**（Node 传 `notFound:false`）：
  「没搜到」不是资源不存在，回 404 会被前端当成路由错误。`/mounts/{id}/browse`
  相反，`NOT_FOUND → 404`。
- **签名直链过期自愈**：上游对 `raw_url` 回 401/403/410 时立刻失效 raw_url 缓存，
  下一次 Range 请求重新 `fs/get`。为此给 `proxy.HTTPOptions` 加了
  `OnUpstreamStatus` 回调——不然 5 分钟 TTL 窗口内所有分片都会拿着死 URL 反复 403。

#### 验证

- `scripts/http-openlist-parity.sh`：假 AList（`scripts/mock-alist.js`，两侧连同一个
  实例）+ 两侧同一个种子库，**25 步零差异**（鉴权、列表、浏览含 object not found、
  解析、直链、me、搜索、整段与 Range 流代理、连通性测试三态、增改删、
  `proxy-image` 的 400/403、`/api/stream/proxy` 的正常代理与缺参）。
- `internal/api/openlist_mounts_test.go`：7 个用例覆盖「密码哈希落库 / 地址补 `/dav` /
  越权 404 / 删除后列表为空且再删 404 / 内网直链拒绝 / Range 透传 206」。
- `scripts/openlist-stream-smoke.sh` 回归通过（`/stream` 的行为未变）。

### 3.23 全量回归与两处修复（阶段 29，为删除 `backend/` 做准备）

删除 Node 之前的最后一轮体检：新增 `scripts/regression-sweep.sh` 串行跑完 32 个脚本，
新增两份**契约快照**（端点 189 / 事件 65）让覆盖检查在 Node 退场后仍可执行。

三处实质改动：

1. **`Metas.GetOrCreate` 并发首读 500**（产品 bug，soak 抓到）：`SELECT` 不到就
   `INSERT`，而 `roomId` 有 UNIQUE 索引；4 并发首次打开同一房间时，后到的请求必然
   撞约束 → 500。修法：INSERT 失败后重读一次（说明别人刚建好）。
   `TestMetasGetOrCreateConcurrent` 用文件库 + 16 并发钉住，并已验证「去掉修复必红」。
2. **四个挂载/房间对拍脚本的种子时间戳过期**（测试时间炸弹）：`lastAccessedAt`
   写死 `2026-01-01`，被 Go 启动清理当成长期无人访问删掉，而 Node 侧最小应用不跑清理。
   改成以 now 为基准 + 清空基线库历史房间。
3. **项目根探测只认 `backend/`**（删库后才会炸的隐患）：`findProjectRootUpward` 原来
   要求「同时有 `frontend` 与 `backend`」。删掉 `backend/` 后，`go run`（exe 在 TEMP）
   从 `backend-go` 起步会一路找不到根，退化成临时目录 —— 表现为「数据库空了、设置全丢」。
   现在 `backend-go` 也算后端目录，`internal/config/config_test.go` 三个用例钉住。

#### 验证

- `bash backend-go/scripts/regression-sweep.sh`：当时 33 个脚本全绿（含 Node 参照脚本）；
  删除 Node 后收敛为 **13 个纯 Go 脚本**（见第九节与 10.4）。
- `bash backend-go/scripts/route-parity.sh --fixture`：**只读契约快照、不需要 Node 后端**，
  189 条全部命中；`bash backend-go/scripts/events-parity.sh`：65 / 65 精确相等。
- `gofmt -l .` 空、`go vet ./...`、`go test ./...` 全绿。

### 3.24 运行/开发入口切到 Go（阶段 30）

删 `backend/` 之前必须先把「怎么起服务」这件事的入口换掉，否则删完 `npm run dev`、
`npm start`、`start-prod.*` 全部指着 `backend/dist/index.js`。

| 入口 | 改前 | 改后 |
|---|---|---|
| `npm run dev` / `dev:backend` | `npm run dev -w backend`（ts-node-dev） | `cd backend-go && go run ./cmd/zviewer-server` |
| `npm run build` | `npm run build -ws`（含后端 tsc） | `build:frontend` + `build:backend`（`scripts/build-backend.js`） |
| `npm run lint` | `-ws`（含后端 `tsc --noEmit`） | `lint:frontend`；新增 `lint:go`（`gofmt -l . && go vet ./...`） |
| `npm run test:server` | Node 服务级回归 | 保留到删 `backend/` 为止；新增 `test:go`、`test:regression` |
| `start-prod.sh` / `.ps1` | `node dist/index.js`（WorkingDirectory=backend） | `dist/zviewer-backend(.exe)`（WorkingDirectory=仓库根 + `PROJECT_ROOT`） |

几处必须一起改的细节：

- **产物路径统一**：新增 `scripts/build-backend.js` 作为唯一编译入口（`go build -trimpath
  -ldflags "-s -w"`，`CGO_ENABLED=0`，平台后缀自动加）。三个调用方（npm script、
  `start-prod.sh`、`start-prod.ps1`）都调它，避免「产物名各写一份、总有一处忘」。
- **`HOST="::"` 会拼出 `:::3333`**：`start-prod.ps1` 显式设 `HOST="::"` 要双栈，Node 能接受，
  而 `fmt.Sprintf("%s:%d")` 拼出来的字符串 `net.Listen` 直接失败（服务起不来）。
  改用 `net.JoinHostPort` → `[::]:3333`，`main_test.go` 用 5 组取值钉住。
  实测 `[::]:34925` 同时接受 `127.0.0.1` 与 `[::1]`。
- **HTTPS 自签不再走 `scripts/generate-cert.js`**：`start-prod.*` 的 `cert` / `https` 菜单
  直接调 `zviewer-backend --gen-cert [host]`（域名→Let's Encrypt，localhost/内网→自签）。
- **`SSL_CERT_PATH` / `SSL_KEY_PATH` 不再写死 `config/ssl`**：Go 侧按 `CONFIG_DIR` 推导，
  写死会在用户覆盖 `CONFIG_DIR` 时指向错误的证书。
- **依赖检查改判据**：`start-prod.*` 原来检查 `node_modules/{express,sql.js,typeorm}`，
  现在只检查前端构建链（`vite` / `typescript`），否则 Go 版永远判成「依赖未安装」。

#### 验证（都是实跑）

- `npm run dev:backend` → 起在 34921，`/health` 200；`npm run build:backend` → 19.3 MB。
- `bash start-prod.sh build` → Go 后端 + 前端全部构建成功。
- `start-prod.ps1 build` / `status` → 产物 19.3 MB、状态显示 `dist\zviewer-backend.exe 存在`。
- `HOST=:: ` 直跑二进制：`监听 [::]:34925`，v4 与 v6 的 `/health` 都通。
- 回归：`route-parity.sh` 189/189、`desktop-env-smoke.sh` 8 项、`go test ./...` 全绿。

> 注：`start-prod.ps1 start` 的 `Start-Process` 分支没能在本机验证——当前会话的
> PowerShell 进程环境里 `Path`/`PATH` 同时存在（PowerShell 5.1 的已知行为），
> 任何 `Start-Process` 都会抛「已添加项」。这是**执行环境**的问题，真实用户从
> `start-prod.bat`（cmd 启动）不会有；启动分支本身只改了 `-FilePath` / `-WorkingDirectory`。

### 3.25 开发热重载（阶段 31）

Node 后端原来靠 `ts-node-dev` 改完即重启；迁到 Go 后 `go run` 没有这层，改一行要
手动 Ctrl+C 重跑。这里补上，实现是 `scripts/dev-backend.js`（约 240 行，只用 Node
内置模块）。

**为什么自己写而不是装 `air`**：`air` 要做 `go install`（走代理 + 本机编译一遍），
而它干的活就是「监听 → build → 换进程」。仓库开发链已经全在 Node 上，自己写一份
零安装、`npm run dev` 直接可用，也不用给贡献者多写一条环境准备说明。

**为什么编译到临时文件而不是继续 `go run`**：

1. `go run` 会 fork 出真正的服务进程，父进程被 kill 时子进程可能残留在端口上
   （Windows 上表现为「端口占用、新版本起不来」）。自己 `go build` 再 spawn，
   pid 就是我们启动的那个，能确定地杀掉。
2. `go run` 的产物在 `go-build` 缓存里、名字不可控，没法清理，也没法判断
   「现在跑的是不是最新一次编译」。

**与 `air` 一致的语义（都是刻意的）**：

- **先编译、成功才换进程**。改到一半带语法错误保存，旧进程继续对外服务，
  终端里打出 `internal\api\xxx.go:3:14: syntax error: ...`；修好保存即自动恢复。
  `go run` 式的「先杀再编译」会让服务在每次半成品保存时都断一截。
- **编译中又有保存** → 记一个 pending，本次编译结束后再跑一轮（不会并发编译，
  也不会丢掉最后一次改动）。
- **debounce 250ms**：编辑器保存常常一次抛多个事件（写入、属性、改名），
  不攒一下会连编译两三次。

**几个实现细节**：

- 监听 `backend-go/**/*.{go,mod,sum}`，`fs.watch(recursive)`；排除 `testdata` /
  `scripts` / `tmp` / `node_modules` / `dist` / `.git`（改测试数据不该重启）。
- 临时产物写 `<tmp>/zviewer-dev-backend/zviewer-server-<序号>.exe`：每次新文件名，
  避开 Windows 上「旧进程还占着同名 exe、链接失败」；启动新进程后删掉除当前之外的旧文件。
- 子进程 cwd 是仓库根（与 `start-prod` 一致），所以 `findProjectRootUpward` 的
  探测结果与生产完全一样。
- Windows 没有 SIGINT 给别的进程，换进程用 TerminateProcess；Go 版每个事务都直接
  落盘（没有内存库快照），强杀不丢数据。`Ctrl+C` / `npm run dev` 的 `--kill-others`
  会带上整棵树，子进程不会残留（脚本里也注册了 `exit` 兜底）。
- `npm run dev:backend:once`（`--no-watch`）保留「只编译运行一次」的语义，给
  CI / 临时排查用。

**验证（都是实跑，临时库 + 34941 端口）**：

| 场景 | 结果 |
|---|---|
| 首次启动 | 编译 1.4s，`已启动（PID …）`，`/health` 200 |
| 新增一个 `.go` 文件 | 触发重启，旧 PID 消失、新 PID 起在 1.8s |
| 改成语法错误 | `syntax error` + `编译失败：保留当前正在运行的进程`；`/health` 仍 200、`startedAt` 未变 |
| 修好保存 | 自动重启；编译期间又删掉文件 → 打 `排队中的改动` 后再重启一次 |
| 临时目录 | 只剩当前 `zviewer-server-N.exe`，旧产物已清 |
| `--no-watch` | 只启动一次、不打印监听行、`/health` 200 |

### 3.26 内置媒体服务：RTMP 收流 + HTTP-FLV 分发（阶段 33）

阶段 26 把 NMS 外部化了（3.20），代价是「开箱推流」这条产品行为丢了：容器镜像、
ZIP 产物包、桌面壳都不带媒体服务，用户装完看到的是「推流服务不可用」。
本阶段把它收回来——**进程内实现**，不再有任何外部二进制依赖。

#### 为什么不用现成的媒体服务器

| 方案 | 问题 |
|---|---|
| 继续外置 SRS / node-media-server | 单文件交付与桌面壳装不进去；node-media-server 还要 Node 运行时 |
| mediamtx | 只支持 RTMP/RTSP/HLS/WebRTC/SRT，**没有 HTTP-FLV 输出**，前端 flv.js 得整体换 |
| SRS | 功能对得上（RTMP in + HTTP-FLV out），但 Windows 版是 Cygwin 构建的安装包，打进 ZIP/桌面壳不现实 |

而这条链路的真实需求很窄：**OBS 推 H.264/AAC，浏览器拉 FLV**，全程**转封装不转码**。
RTMP 音视频消息的载荷与 FLV tag body 是同一份字节，所以实现量可控（约 1,300 行）。

#### 实现拆分（`internal/nms/`）

| 文件 | 内容 |
|---|---|
| `rtmp_chunk.go` | chunk 流读写：fmt0-3 头、扩展时间戳、chunk size 协商、消息重组；写侧只用 fmt0 + fmt3 |
| `amf0.go` | AMF0 编解码（number/boolean/string/object/ECMA array/strict array/date/null），嵌套上限 32 层 |
| `rtmp_session.go` | 简单握手 + 命令分发：`connect` / `releaseStream` / `FCPublish` / `createStream` / `publish` / `deleteStream`，`@setDataFrame` 元数据 |
| `streamhub.go` | 流注册表 + GOP 缓存（12 MB / 1200 tag 上限）+ 订阅者广播（队列满丢帧、关键帧丢失直接断开）+ FLV tag 编码 |
| `embedded.go` | 监听与生命周期、`/live/{key}.flv` 的 HTTP-FLV 输出（joined 时补发元数据 + 序列头 + GOP） |
| `nms.go` | 保留原有 `Service`（可用性 / 推流地址 / 推流码），新增 `Start` / `Close` 与内嵌模式 |

配置优先级：`NMS_HTTP_FLV_URL` 有值 → 外部模式（不再监听本地端口，可用性退回 TCP 探测）；
为空 → 内嵌模式（默认）。`NMS_EMBEDDED=0` 强制不内嵌，`NMS_BIND` 指定监听地址，
`STREAM_PUSH_ENABLED=0` 仍然整体关闭。启动失败（端口被占）不致命：记一行日志后
自动降级成外部探测模式。

#### 五个必须守住的细节

1. **每条消息换新缓冲**。chunk 组装时若复用 `payload[:0]`，后面到的帧会覆盖已被
   hub 长期持有的序列头 / GOP 缓存——表现是「前几秒画面正常、之后花屏」，
   而且只在缓存帧多于一条时出现，非常难查。
2. **chunk size 是单向的**。服务端发 `Set Chunk Size(4096)` 只约束**自己写出**的块；
   客户端仍需按 128 解析，直到它自己发 `Set Chunk Size`。测试端漏了这一步就会
   把续块当新消息，卡死在读超时。
3. **`Set Chunk Size` 消息本身要用旧块大小写出去**，写完再切换写侧状态。
4. **GOP 缓存只在关键帧处重置**，否则观众进来先看到一段 P 帧（花屏到下一个关键帧）。
   `subscribe` 的补发顺序固定：`onMetaData` → 视频序列头 → 音频序列头 → GOP。
5. **订阅者广播不能阻塞**：队列满时音频/普通帧直接丢（下个关键帧自愈），
   关键帧丢了就断开该订阅者，让播放器重连重新对齐——绝不能让一个卡住的
   HTTP 客户端拖慢推流解析。

#### 验证

`go test ./internal/nms/` 覆盖：AMF0 往返、chunk 重组（800 字节跨块）、
**假推流端到端**（握手 → connect → publish → 元数据/序列头/关键帧 → HTTP 拉流 →
按 FLV 结构逐 tag 断言）、流不存在回 404、`Start`/`Close` 的可用性、端口被占时降级。

端到端用例里的假客户端只做「协议上合法的最小事」，等价于 OBS 的 librtmp 行为：
握手 → `connect` → `releaseStream` → `FCPublish` → `createStream` → `publish`，
之后发 `@setDataFrame` + AVC/AAC 序列头 + 关键帧。

#### 交付形态的变化

| 形态 | 之前 | 现在 |
|---|---|---|
| 源码 `npm run dev` | 需要自己跑 NMS | 开箱即用 |
| Docker 单容器 | 3334 没人监听 | 后端进程内监听，镜像无需改 |
| Windows ZIP / 桌面壳 | 无推流 | 开箱即用 |
| 已有外部媒体服务 | 设 `NMS_HTTP_FLV_URL` | 行为不变（自动转外部模式） |

一起听（NCM）仍然是外部服务，见第十三节「外部依赖」——那部分是网易云协议实现，
不属于 Go 重写的范围，交付上改为「compose 可选服务 + 明确降级」。

## 六、阶段 4：挂载源与系统（约 50 人日）

| 单元 | TS 行数（估） | 状态 |
|---|---:|---|
| 影片库 CRUD + 挂载（OpenList 含 CRUD/浏览/解析/直链/me/搜索，见 3.22） | ~1,900 | ✅ 见 4.1 + 3.22 |
| WebDAV 挂载 + 流代理 | ~800 | ✅ 见 4.2 |
| FTP 挂载 + 流代理 | ~660 | ✅ 见 4.4 |
| Emby / Jellyfin 协议仿真 | ~1,600 | ✅ 见 4.5 |
| 服务器文件浏览 | ~1,200 | ✅ 见 3.8（12 端点 + 65 步对拍） |
| 一起听音乐（含 NCM） | ~3,170 | ✅ 见 3.17（9 端点 + 41 步对拍） |
| 语音（LiveKit 凭证 + 禁言/踢人） | ~430 | ✅ 见 3.19（3 端点 + 14 步对拍） |
| OBS 推流（配置下发 + /live 反代） | ~580 | ✅ 见 3.20（1 端点 + 6 步对拍） |
| 管理端 / 统计 / 客户端日志 | ~900 | ✅ 见 3.8 / 3.9（63 步对拍） |
| 更新器（下载/解压/sha256） | ~1,400 | ✅ 见 3.18（5 端点 + 16 步对拍） |
| ACME / 自签证书 | ~1,020 | ✅ 见 3.21（`--gen-cert` CLI + HTTPS 启动 + 19 项冒烟） |
| CLI 代理端点 | ~280 | ✅ 见 3.8 |

### 4.1 影片库与挂载流（已完成部分）

| 文件 | 行数 | 内容 |
|---|---:|---|
| `internal/store/movie.go` | ~640 | 影片 CRUD、order 自增、`sourceMountId` 锚定、JSON 列规范化、时间解析 |
| `internal/store/movie_crypto.go` | ~130 | 凭证列的 AES-256-CBC（与 Node 的 `encryptMovieField` 逐字节兼容） |
| `internal/store/room.go` / `mount.go` | ~190 | 房间存在性、会话准入、挂载读取（含凭证解密） |
| `internal/api/movie.go` | ~430 | 6 个影片 REST 端点 + DTO 序列化 |
| `internal/proxy/moviestream.go` | ~230 | `resolveMovieStream`（熔断 + 30s 缓存 + 凭证回退） |
| `internal/openlist/openlist.go` | ~780 | AList 客户端：token(12h) / raw_url(5min) / 单飞 / 分页列举 / 搜索 / me / 连通性测试 |
| `internal/api/openlist.go` | ~150 | `GET /api/openlist/stream`（签名直链 + Range 透传） |

端点：`GET/POST/DELETE /api/rooms/{roomId}/movies`、`POST .../movies/reorder`、
`PUT/DELETE /api/rooms/{roomId}/movies/{movieId}`、`GET /api/openlist/stream`。

验证脚本：
- `scripts/movie-smoke.sh`——真实库副本上的 14 个用例（CRUD、权限、必填、内网强制转发、凭证回填、密文校验）；
- `scripts/movie-parity.sh`——与 Node 逐字段对拍（种子 0 差异、跨实现读 0 差异、双向密码加解密）；
- `scripts/openlist-stream-smoke.sh`——mock AList 上的 9 个用例（206/200/416、缓存命中、AUTH_FAILED、NOT_FOUND）。

### 4.2 WebDAV 挂载与流代理

| 文件 | 行数 | 内容 |
|---|---:|---|
| `internal/webdav/webdav.go` | ~660 | PROPFIND（Depth 0/1）、`encodeURIComponent` 等价编码、href→相对路径、Range GET、stat(30s)/dir(60s) 缓存 |
| `internal/mountutil/mountutil.go` | ~260 | HTTPS 能力探测与直链升级（含现场活性校验 + 自愈写回）、内网强制中转 |
| `internal/store/mount.go` | ~300 | 挂载 CRUD（全部按 `id + userId + type` 限定归属）、`SaveHTTPSDirect` |
| `internal/api/webdav.go` | ~600 | 10 个端点：mounts CRUD / test / browse / resolve / proxy / direct-url / stream |

端点：`GET/POST /api/webdav/mounts`、`POST /api/webdav/mounts/test`、
`PUT/DELETE /api/webdav/mounts/{id}`、`GET /api/webdav/mounts/{id}/browse`、
`GET /api/webdav/{resolve,proxy,direct-url,stream}`。

验证脚本：
- `scripts/mock-webdav.js`——极简 WebDAV 服务器（中文/空格文件名、严格 Basic Auth、Range）；
- `scripts/webdav-parity.sh`——25 步逐字节对拍（挂载 CRUD、浏览、解析、四种 Range 形态、
  内网直链拒绝、错密码错误码、影片流凭证回退）。

### 4.3 房间 REST

| 文件 | 行数 | 内容 |
|---|---:|---|
| `internal/store/room.go` | ~300 | 房间读取（全列）、`status='active'` 列表、在线观众/sharer 批量聚合、改名 |
| `internal/store/danmaku.go` | ~390 | 弹幕轨道 upsert/批量替换/偏移更新、弹幕辅助数据（屏蔽词/已删除/实时记录） |
| `internal/api/rooms.go` | ~520 | 9 个端点 + DTO + `requireRoomControlMsg`（每个端点自己的 403 文案） |
| `internal/realtime/bus.go` | ~30 | 房间事件广播契约（`realtime.Noop` 占位，等 socket.io 迁移后替换实现） |

端点：`GET /api/rooms`、`PUT /api/rooms/{roomId}/name`、
`GET/POST /api/rooms/{roomId}/danmaku-tracks`、`POST .../danmaku-tracks/bulk`、
`PUT .../danmaku-tracks/{trackId}/offset`、`DELETE .../danmaku-tracks/{trackId}`、
`GET/PUT /api/rooms/{roomId}/danmaku-meta`。

验证脚本：`scripts/rooms-parity.sh`——28 步逐字节对拍（含 upsert 去重、批量替换事务、
`realtimeLog` 不被覆盖、`viewerCount`/`sharerOnline` 聚合、`hasPassword` 语义、四种权限边界）。

### 4.4 FTP 挂载与流代理

| 文件 | 行数 | 内容 |
|---|---:|---|
| `internal/ftp/ftp.go` | ~760 | 自研 FTP/FTPS 客户端：被动模式（EPSV→PASV 回退）、SIZE/MDTM、REST 分段、MLSD/LIST/DOS 三种目录格式解析、stat(30s)/dir(60s) 缓存 |
| `internal/api/ftp.go` | ~660 | 11 个端点：挂载 CRUD / test / browse / resolve / proxy / stream，外加临时连接的 `resolve-ftp` + `proxy-ftp`（票据链路） |

端点：`GET/POST /api/ftp/mounts`、`POST /api/ftp/mounts/test`、`PUT/DELETE /api/ftp/mounts/{id}`、
`GET /api/ftp/mounts/{id}/browse`、`GET /api/ftp/{resolve,proxy,stream}`、
`GET /api/stream/{resolve-ftp,proxy-ftp}`。

验证脚本：
- `scripts/mock-ftp.js`——极简 FTP 服务器（MLSD/LIST 双形态、`nosize.mkv` 触发 stat 回退、
  中文+空格名、错误的 PASV 报文路径）；
- `scripts/ftp-parity.sh`——34 步逐字节对拍。**两种目录格式各跑一遍**：
  `bash ftp-parity.sh`（MLSD）与 `LIST_ONLY=1 bash ftp-parity.sh`（老式 LIST），
  两种模式都必须全绿——MLSD 有可靠时间戳、LIST 没有，DTO 的字段集因此不同。

### 4.5 Emby / Jellyfin 协议仿真

| 文件 | 行数 | 内容 |
|---|---:|---|
| `internal/emby/client.go` | ~700 | REST 客户端：登录（24h 缓存 + 单飞 + 401 重登）、`/Users/Me` 回退 `/Users`、Views / Items / Images / Search / PlaybackInfo / Subtitles |
| `internal/emby/versions.go` | ~330 | 多版本（MediaSource）选择、版本标签（复刻 JS `toFixed`）、resolve 载荷与 `Path ?? title` 语义 |
| `internal/api/emby.go` | ~1,050 | 一套 handler 注册两次（emby / jellyfin）：挂载 CRUD、test、browse、search、海报（免认证 + 弱 ETag）、resolve、movie-source、proxy、stream |

端点（每个前缀 12 个 × 2 = 24）：`GET /api/{emby,jellyfin}/mounts`、
`POST .../mounts/test`、`POST .../mounts`、`PUT/DELETE .../mounts/{id}`、
`GET .../mounts/{id}/browse`、`GET .../mounts/{id}/search`、
`GET .../mounts/{id}/image`（免认证）、`GET .../resolve`、`GET .../movie-source`、
`GET .../proxy`、`GET .../stream`。

验证（`mock-emby.js` / `emby-parity.sh` 已随 Node 后端删除，结论保留、覆盖改由单测承担）：
- 当时的对拍：最小 Emby 假站（登录校验客户端标识头、`/Users/Me` 对特定账号返 500、
  缺 Path / 缺海报的条目、多版本、DTS 音轨、空 MediaSources、Range 流、带 api_key 的 m3u8、
  `POST /__invalidate` 清会话），**52 步**逐步骤一致，m3u8 **按全文**比对；
- 现在：`internal/emby/*_test.go` 覆盖登录缓存单飞 + 401 重登、多版本选择、版本标签、
  客户端标识头形状。

**客户端标识名可配置（`EMBY_CLIENT_NAME`）**：`X-Emby-Authorization` 里的
`Client="ZViewer"` 原本是写死的，部分私有服务器会按客户端名做白名单（改成 `Emby Web` /
`SenPlayer` 才放行）。现在默认仍是 `ZViewer`，设了环境变量就替换：空值/纯空格回落默认，
双引号与 CR/LF 会被剥掉（否则会截断 `Client="…"` 的键值或造出非法头）。
DeviceId 仍是进程级常量，见 `internal/emby/clientname_test.go`。

---

## 七、必须保留的行为不变量

重写最容易丢的不是代码，是**为什么这么写**。以下每条都对应一处曾经踩过的坑，
移植时不得"顺手优化"掉：

| 不变量 | 出处 | 后果 |
|---|---|---|
| VIP 清晰度过滤的唯一事实源在后端 `permission.ts`，前端不再二次过滤 | `services/bilibili/permission.ts` | 前端再过滤会导致会员可用清晰度被误杀 |
| 观众端挂载必须走 `resolveViewerEffectiveState` | `modules/viewer` | 绕过它会让观众看到与房主不一致的源 |
| 新增影响引擎/源的 state 字段时，`isStateEqual` 必须比较它 | 同步状态机 | 否则观众端广播被判定"等价"而跳过，不重挂载 |
| 解析身份默认锚定房主（`useHostCookie=true`） | `services/bilibili/credential.ts` | 改成观众身份会让普通用户解析失败 |
| PGC 试看：badge 非空且非大会员时强制 MP4，时长取 `durl[0].length` | `services/bilibili/pgc.ts` | 否则试看片段时长显示错误 |
| CLI `/resolve` 的 UGC 分支必须有 cid，只给 bvid 直接 400 | `ZViewerCLI`（独立仓库） | 去掉这步首解析必然失败并回退服务器端 |
| 影片级 `serverProxy` / `playsvideoEnabled` 改动后要触发源重载 | `MovieRuntimeSettings` | 否则开关改了不生效 |
| 三类数据源（anime/kazumi/cms）都有 `serverProxy`；Kazumi 必须落 `sourceMeta` | 添加影片流程 | 缺 meta 只能靠 URL 解包回退，Referer/UA 会丢 |
| 推流鉴权按 `streamKey` 查 Room 且校验为 `stream-push` 子模式 | `modules/stream-push` | 直接用 roomId 会泄露房间号且无法独立轮换密钥 |
| 语音通道不设 UDP/TCP 开关，服务端恒发两条候选 | `livekit` 配置 | 加开关会让本该走 UDP 的场景退化 |
| Engine.IO 收到 `2probe` 时必须往**轮询**通道补一个 `noop` | engine.io `Socket#onProbe` | 不发的话客户端要等满 `pingInterval` 才能停下长轮询，页面表现为「打开好几秒才转成 WebSocket」 |
| 长轮询到期回 `noop`（`6`），不能回空响应 | engine.io polling | 空 200 会被客户端当成传输错误，直接重连 |
| CONNECT 应答（`40{"sid":…}`）必须先于 `connection` 回调里的任何 `emit` | socket.io server | 顺序反了客户端会把先到的事件当成「尚未连接」丢弃，表现为「刚进房的首个事件总是丢」 |
| ack id 中 `0` 是合法值，**不能**用字段零值表示「没有 ack id」 | socket.io-parser | 用零值判空会把 CONNECT 应答编成 `400{"sid":…}`，客户端解析出的 sid 直接是错的 |
| `maxPayload` 必须是 20 MB | `index.ts#new SocketIOServer` | 房主广播的 `subtitle-update` 带完整 ASS 轨道可达数 MB，默认 1 MB 会让大字幕同步静默失败 |
| HTTP 请求不写 auth cookie | `middleware/auth.ts` | 非 Secure 的 `SameSite=None` 会被浏览器丢弃，登录死循环 |
| 桌面托管时 `/api/system/update/*` 返回 409 | `services/desktop-runtime.ts` | 网页更新只换后端产物，会与 GUI 整包版本脱节 |
| 时间列写入必须**带毫秒**；`tokenInvalidBefore` 必须写**带 Z 的 ISO 串** | `DateUtils.mixedDateToUtcDatetimeString` | 截到秒会让同一秒内签发的令牌在改密后仍有效；无时区串在 TypeORM 水合时按本地时区解释，会让"Go 已吊销、Node 仍放行" |
| 影片表的时间列按 **UTC** 解释，不要加本地时区偏移 | `movie.service.ts` + 实测对拍 | 这条与上一条不冲突但极易混：`tokenInvalidBefore` 是手写字符串，TypeORM 会 `new Date()` 按本地解释；而 `movie.createdAt` 走 sql.js 驱动的 DATE 列，driver 抛出的已经是按 UTC 解释的 Date。**曾经按前者类推加了 +8h，对拍立刻差 8 小时**——跨实现的语义只能实测 |
| 影片 DTO 的 `username` / `password` **恒为 null**，连 socket 广播也不下发 | `movie.service.ts#serializeMovie` | 传了就等于把房主的 NAS 账号发给房间内每个观众 |
| 更新影片时传 `null` **不清空**字段（`acceptQuality`/`pages`/`sourceMeta` 除外，它们是"显式 null = 清空"） | `movie.service.ts#updateMovie` | Node 用 `typeof x === 'string'` 判定，null 的 typeof 是 object 所以跳过；实现成"null 即清空"会让前端表单里未填的字段把已存值抹掉 |
| 挂载型源（openlist/webdav/emby/jellyfin）遇内网地址时强制 `directLink=false` | `movie.routes.ts` | 公网访问者浏览器根本连不到 192.168.x.x，直链只会一直转圈 |
| 代理模式新增影片后要把 `url` 重写成 `/api/<source>/stream?movieId=<id>` | `movie.service.ts#createMovie` | 保留原始直链会让观众端绕开服务器、且依赖各自的挂载表 |
| 凭证列解密失败要返回 **nil**，不能返回空串指针 | `internal/store` | 空串会被当成"有密码但为空"，覆盖挂载表里的真实密码，表现为"配了密码却提示未授权"且无日志可查 |
| OpenList token 缓存 key 必须是 `baseURL` + `username` 两段 | `openlist-token-cache.ts` | 只按 baseURL 缓存会让"改了密码"在 12 小时内不生效（旧 token 仍被复用） |
| OpenList 的 raw_url 若为相对路径，必须补全成绝对地址 | `services/openlist.ts` | AList 未配 `site_url` 时返回 `/d/xxx?sign=`，直接交给代理层是非法 URL |
| 请求参数编码必须等价于 **`encodeURIComponent`**，不能用 `url.QueryEscape` | `services/bilibili/params.ts` | 空格编 `+`、以及转义 `!*()'~` 会让 `w_rid` 与服务端重算的串不同，签名全线失效（表现为全部 -403/-352） |
| PGC 接口载荷在**顶层 `result`**，UGC 在 `data` | `services/bilibili/pgc.ts` | 只读 `data` 会让番剧解析永远拿到空载荷，报错文案却像"接口失败" |
| `currentQn` 必须反映**实际选中的轨道**，不是 `data.quality` | `services/bilibili/playurl.ts` | 低权限时 `quality` 高于真实下发轨道，前端会显示错误清晰度 |
| DASH 轨道必须按 `data.quality` 过滤后再按 codec 选 | `services/bilibili/playurl.ts` | `dash.video` 一次性返回所有清晰度，不过滤会永远选最高档（超权限 → 播放失败） |
| MP4 直链上限 720P（`fnval=1 + platform=html5`） | `services/bilibili/playurl.ts` | 1080P+ 只有 DASH 支持，承诺 MP4 高清晰度会拿到低档 |
| 弹幕接口必定回 `Content-Encoding: deflate`（**裸 deflate**，无 zlib 头） | `services/bilibili/danmaku.ts` | Go 的 transport 只自动解 gzip；不解压就读到乱码，正则一条都匹配不上，表现为"接口成功但弹幕为空"且不报错 |
| 字幕必须过 **oid 带外校验 + 时长带内校验 + 一致性投票**，任一不过即丢弃 | `services/bilibili/subtitle.ts` | `x/player/v2` 会随机返回**别的视频**的字幕，且字幕 JSON 里没有任何视频标识，无法自证；"择优录取"会让错字幕照常上屏 |
| `user_mount` 的 `password` / `apiKey` 是**明文**（全仓只有 `Movie` 实体的列带 AES transformer） | `entities/UserMount.ts` | 照 Movie 那样解密会把真实密码判成"解密失败"而静默丢成 nil，所有挂载变成无凭证访问（第 4 阶段曾这么写，第 5 阶段修正为"能解就解、解不出按明文"） |
| WebDAV 代理的 `Content-Type` 由**源站**决定，不要按扩展名覆盖 | `webdav-client` → `request#pipeDest` | `request` 库把流 pipe 给响应时会把上游响应头整份照抄；按扩展名强行改会让同一台 NAS 出现"Node 播得动、Go 播不动" |
| 目录列表项必须带 `size`（缺 `getcontentlength` 时填 0） | `webdav-client#readdir` | 少字段会让前端排序/展示出现 `undefined` 参与比较 |
| WebDAV 路径编码必须与 `encodeURIComponent` 逐字符一致 | `services/webdav.ts#normalizePath` | `url.PathEscape` 的转义集合不同（`!*'()` vs `$&+,;=:@`），文件名含这些字符时两端会指向不同 URL |
| FTP 的 `stat` 必须先 SIZE/MDTM、失败才回退 CWD+LIST | `services/ftp.ts#statFTPFile` | 视频 seek 每个 Range 请求都要 stat；全目录 LIST 在高延迟 FTP 上是秒级延迟。回退路径必须保留（老服务器 SIZE 返 550） |
| FTP 目录项 `type` 只有 `item.type === 1` 才是 `file`，符号链接算 `directory` | `routes/ftp.ts#listFTPDirectory` | 前端按 directory 渲染才允许再进一层；把符号链接标成 file 会让用户点不进 NAS 的常见目录链接 |
| FTP 代理**必须**把响应体截到 `Content-Range` 声明的长度 | 实测（Node 会把整个文件写出去） | FTP 的 REST 只能定起点，服务端一直发到文件尾；Node 侧实际字节数 > Content-Length，curl 会报 "Excess found in a read"。这是 Go 侧**刻意修掉的协议违规**，见下 |
| FTP 端口要用 `port` 列，不要从 `serverUrl` 里解析 | `routes/ftp.ts#mountToParams` | 两处都填时以 `port` 为准；`serverUrl` 只取主机名 |
| 临时连接（`resolve-ftp`）的凭证只能走服务端票据 | `routes/stream/ftp.ts` | 旧实现在 `video.src` 里带明文密码，会泄漏到浏览器历史与代理日志；票据与签发者 userId 绑定、30min 滑动续期 |
| Emby 登录结果按 `sha256(server+账号+密码)` 缓存 24h、上限 500，**并发共用同一个登录过程** | `services/emby-client.ts#login` | Emby 对并发 authenticatebyname 会限流；缓存掉重复登录是浏览瀑布流不卡的前提 |
| 401 重登前必须**丢弃陈旧登录缓存**（仅当缓存 token 正是当前 token） | `services/emby-client.ts#request` | 不丢的话重登会拿回同一个失效令牌，重试必然还是 401，表现为「密码是对的，但 token 过期后永远连不上」 |
| `X-Emby-Authorization`（MediaBrowser Client=…）每个请求都要带，登录尤其必需 | `services/emby-client.ts` | 缺它登录直接 400；DeviceId 必须是**进程级常量**，每请求换一个会把服务器会话表刷爆 |
| `/Users/Me` 失败要回退 `/Users` 并**优先取管理员** | `services/emby-client.ts#me` | 部分 Emby 版本 `/Users/Me` 返 500；取到普通账号会让媒体库列表为空 |
| emby/jellyfin 挂载的 `directLink` **不套**内网强制中转 | `routes/emby-like-factory.ts` | 内网判定在**影片级**（`movie.routes.ts`）做，挂载存的是用户偏好；在挂载层加会和 Node 行为分叉 |
| HLS 子资源（`?resource=`）必须限定同源 + 同 `videos/{itemId}/` 前缀，且改写时抹掉 `api_key` | `routes/emby-like-factory.ts#validateHlsResource` | 否则 `/proxy` 就是开放代理（可读内网、可带令牌打任意地址）；令牌留在 playlist 里等于把它发给每个观众 |
| 改写后的 m3u8 响应 `Content-Type` 必须带 `; charset=utf-8` | express `res.send(string)` | Express 给任何字符串响应体补 charset；少了这半句两端 Content-Type 就不一致 |
| 海报端点免认证，且必须复刻 Express 的**弱 ETag + 304** | `<img>` 无法带 Authorization 头 | 没有 ETag 每次滚动瀑布流都重拉图；ETag 格式是 `W/"<hex长度>-<sha1 base64 前 27 位>"` |
| 条目 DTO 里上游缺失的字段要**整键消失**，不能下发 `""`/`0` | `res.json` 丢弃 undefined | 前端用 `entry.filePath ?? 解析文件名` 兜底，空串会让兜底失效 |
| `format` 取 `source.Path ?? title`：Path **缺失**用 title、Path 为**空串**用空串（→ unknown） | `services/emby-versions.ts` | 两种情形必须区分，否则「路径为空」的条目会被判成 mp4/mkv |
| 版本标签体积用 JS `toFixed(1)`，不是 Go 的 `%.1f` | `services/emby-versions.ts` | 恰好半分时 JS 进位、Go 取偶：1.25GiB 是 `1.3GB` 而非 `1.2GB`（1.25×2^30 是精确可表示值，真会碰上） |
| 房间/会话/挂载的时间列同样按 **UTC** 解释 | 实测（`rooms-parity.sh`） | 与 `movie` 表同一路径（sql.js 驱动水合时补 `Z`），不要套用 `tokenInvalidBefore` 的本地时区逻辑 |
| REST 写出房间事件时必须走 `realtime.Bus`，事件名集中定义 | `realtime/bus.go` | 现在 `Noop` 丢弃事件，但调用点与载荷形状要一次写对，socket.io 落地后只换实现 |
| Socket.IO 业务事件只接了 19 个，剩余 49 个上行事件仍不可用 | `modules/room` 等 | 房间能创建/进人/改设置/管成员/关闭，但播放控制、评论弹幕、一起听、WebRTC 信令都还没注册；别把「能建房」当成「房间可用」 |
| 字幕接口失败也是 `200 + success:true + lines:[] + message` | `routes/stream/bilibili-videos.routes.ts` | 改成 4xx/5xx 会让前端当成请求失败去重试，只会继续掷骰子 |
| 每个 socket 必须自动加入**以自身 ID 命名的房间** | socket.io `Socket` 构造函数 | `io.to(socket.id).emit(...)` 全靠它；少了这步，所有「只推给某一个人」的事件（`join-approved` / `viewer-kicked` / `moderators-changed`）都会静默发不出去且不报错 |
| WS 升级必须走 `http.NewResponseController(w).Hijack()`，不能直接 `w.(http.Hijacker)` | 主服务的 `statusRecorder` 包装 | 包装层不实现 `Hijacker`，直接断言会失败；表现是「REST 全部正常，WebSocket 永远连不上，客户端只报 websocket error」 |
| 握手取令牌顺序：cookie `access_token` → `handshake.auth.token` → `query.token` | `middleware/socket-auth.ts` | 只认 `auth.token` 会让同源带 cookie 的常规浏览器场景全部 `connect_error`，表现为「刷新后一直显示未连接」 |
| 令牌必须在**每个上行包**上重校验，并在 `exp` 到期时主动断开 | `socket.use` + `setTimeout(revoke, exp)` | 只在握手校验等于给旧连接发永久通行证：改密码 / 封禁后旧连接仍能继续控制房间 |
| 房主注册（`register-host`）成功后要先 `join(roomId)` 再广播 `movie-list` | `roomSessionService.registerHost` | 顺序反了房主自己收不到列表；后端重启后内存影片为空，`play-movie` 会一直报「影片不存在」 |
| 房主重连必须**复用**同一个 sharer 会话（改 socketId），不新建行 | `roomSessionService.registerHost` | 新建会让一个房间攒下多条 sharer 记录，`getRecentSharer` 的「最近一条」判定随之漂移 |
| `movies` 字段在没有影片时是 `[]`，**不是 `null`** | `roomStateService` 初始化 | 前端按数组使用（`.map` / `.length`），`null` 直接白屏；Go 侧 `Movies()` 因此永不为 nil |
| `host-disconnected` / `room-closed` 的广播必须**先于**踢人 | `roomStateService.closeRoomAndNotify` | 反过来的话被踢的客户端收不到通知，前端会停在播放页而不是跳回房间列表 |
| `close-room` 时**不断开**房主连接（`sharerSocketId` 排除），其余人先 `leave` 再 `disconnect` | 同上 | 房主关房后还要继续用这条连接创建下一个房间 |
| 房主宽限期 = 重连 10 分钟 / 观众可加入 5 分钟，两套时长不能混用 | `room-state.service.ts` / `viewer-join.handler.ts` | 统一成一个值会让「房主掉线 6 分钟后观众进不来」或「房间空转 10 分钟还能进人」 |
| 重连超时后是否关房取决于 `autoDeleteInactiveRooms`；**读设置失败时按关闭处理** | `roomStateService.closeRoomAfterHostGrace` | 异常态下让房间泄漏比误关更难收拾 |
| 人数上限判定用 `>=`：`maxViewers=1` 时第二个人必须被挡 | `roomSessionService.admitViewer` | 写成 `>` 会让房间永远多出一个人 |
| 观众准入（校验人数 + 插入会话）必须**串行** | `admitViewer` 的 `admissions` 链 | 并发进房时两个请求都读到 n-1 然后双双通过，房间直接超员 |
| 游客准入按 `guestId` 绑定，登录用户不写 `guestId` | `Session.guestId` | 所有游客共享 `userId=0`，只看 userId 会让游客互相冒用准入 |
| 权限缓存（`isRoomHost`/`isInRoom`）TTL 5s，但 session 变更时必须**立刻失效** | `roomPermissionService.invalidatePermissionCache` | 只靠 TTL 会让被踢/被转交的人在 5 秒内继续有权限，表现为「踢了没反应，几秒后才掉」 |
| 建房前先退出旧房间并结束旧 sharer 会话 | `room-lifecycle.handler.ts#create-room` | 否则同一个 socket 同时在新旧两个房间，新房间会显示旧房间的影片列表 |
| `create-room` 的 `mode` / `maxViewers` 只在**显式传入**时校验，缺省不校验 | 同上 | 把 `undefined` 当非法值会让「只传 name」的调用全部失败 |
| 房间密码用 bcrypt（cost 10）存 `room.password`，`root` 进房跳过校验 | `room-lifecycle` / `viewer-join` | cost 与 Node `bcrypt.hash(pw, 10)` 一致才能互验；root 跳过是为了管理员救场 |
| REST 的影片写操作（增删改/清空/重排）完成后**必须广播 `movie-list`** | `movie.routes.ts` | 少了这一步：接口 200、库里也改了，但观众端列表不动，要刷新页面才看得到 |
| 当前播放的影片被删时要广播 `current-movie: {movieId: null}` | `movie-broadcaster.service.ts` | 观众端靠这条事件停止播放；只发 `movie-list` 会出现「列表里没这片，播放器还在放」 |
| `viewer-left` 统一用 `viewerSocketId` 字段 | `viewer-list.service.ts` | 历史上前端两种字段名都读过，混用会让在线人数偶发不减少 |
| 房管/房主身份的 `role` 与账号 `role` 是两套值，补发在线观众时要用 **账号 role**（`user`/`admin`），新观众自己的 `viewer-joined` 才写死 `viewer` | `viewer.service.ts#getOnlineViewers` | 混用会让前端把普通观众显示成「观众」、把账号角色判错 |
| `update-room-name` 的权限是「root 或房间 owner」，**不是** sharer | `room-settings.handler.ts` | 用 isRoomHost 会把「房主掉线由管理员改名」挡在外面 |
| 权限矩阵缺省值：房管/admin **允许**（只有显式 `false` 才拒），user **拒绝**（必须显式为 `true` 才允许） | `roomPermissionService#matrixAllow` | 两个方向不对称，统一成「必须为 true」会让所有房管在矩阵上线前先失效 |
| 房主在 `canViewerPerform` 里先短路放行，root 次之，之后才查矩阵 | 同上 | 房主是房间唯一内容源，受矩阵约束会出现「房主禁不了自己房间的人」 |
| 房管防篡权：房管不能操作房主 / 其他房管 / root（**房主不受此限**） | `roomPermissionService#canModeratorActOn` | 缺这道判定，房管可以踢掉房主、或房管互踢形成夺权 |
| 禁言按 `userId` 存，**游客（userId<=0）必须拒绝**并提示改用踢出 | `viewer-management.handler.ts#mute-viewer` | 所有游客共享 userId=0，禁一个等于禁全体 |
| `unmute-viewer` 不做防篡权、不挡游客（与 mute 不对称） | 同上 | Node 侧就是如此；补齐会让解禁在边界场景下报出 Node 不会报的错 |
| 转交房主必须**事务**完成，且新房主若原为房管要从 `moderators` 移除 | `roomSessionService#transferHost` | 无事务会出现「owner 改了、角色没换」的半截状态；不清名单会让房主多一个「房管」徽标并留下脏数据 |
| `appoint-moderator` 的检查顺序：游客 → 房主本人 → 已在名单（幂等成功） → 目标在房间内 → 人数上限 10 | `viewer-management.handler.ts` | 顺序换了会改变提示文案；「已在名单」返回 `{success:true}` 且**不带 data** |
| 审批通过后**必须清掉 `pendingRoomId`**，否则房主再点「拒绝」仍会成功 | `roomSessionService#admitViewer` | 这是对拍抓到的真实差异：标记不清会让同一个申请被反复批准/拒绝 |
| `approve-join` 的事件顺序：`join-approved` → `moderators-changed` → `movie-list` → `current-movie` → 字幕 → `viewer-joined` → 白名单 → 补发在线观众 | `viewer-management.handler.ts#approve-join` | 与 `finishJoin` 的顺序**不同**（那边房管列表在末尾），别把两条路径合并 |
| `p2p-mode-change` 用 `socket.to(room)` 语义：**发送者自己收不到** | `room-settings.handler.ts` | 用 `io.to(room)` 会让发起端收到自己刚发的状态，前端乐观更新时来回抖 |
| 只有登录用户（userId>0）被批准后才写入 `approvedViewers` 白名单 | `viewer-management.handler.ts` | 游客没有稳定身份，写进去只会污染白名单 |
| `update-room-mode` **不校验 mode 枚举**，只信任前端取值 | `room-settings.handler.ts` | Node 侧就没有校验；加一道会在新旧前端混用时报出 Node 不会报的错 |
| `update-room-settings` 的 `password` 只认**字符串**：`null`/缺失=不动，空串=清空（列写 NULL） | 同上 | 把 null 当清空会让「只改人数」的调用顺手把密码删掉 |
| `room-settings-updated` 下发的 `password` 是**密文本身**（与 Node 一致） | 同上 | 前端只用它判断「有没有密码」；改成布尔会让两端载荷形状不同 |
| `update-room-settings` 先校验 `maxViewers`（整数 1..100）再写库，非法时**整条不落库** | 同上 | Node 是「先改内存实体、校验失败直接 return」，没走到 save；分开写会产生「密码改了但人数没改」的半截状态 |
| 写播放状态前必须做**传输延迟补偿**：`currentTime += clamp((now-clientTs)/1000, 0, 1.5) × rate`，暂停态与缺 `clientTs` 不补偿 | `playback-memory/transport-delay.ts` | 房主上报的是「发出时刻」的进度，到服务器已前进一个 RTT；不补的话观众每次请求状态都比房主慢半拍，越播越明显 |
| 补偿只能做一次：`applyControlToPlayback` 里已显式补过，再调 `setPlayback` 时必须**不传 clientTs** | `playback-memory.handler.ts#applyControlToPlayback` | 传了就是二次补偿，进度会凭空多走 1.5s |
| `seek` 控制**不改变 `isPlaying`** | 同上 | 旧实现强制置 false，观众端 seek 后会暂停、等下次心跳才恢复，肉眼可见地抖一下 |
| `watch-together-state` 落库后广播，与心跳落盘都要**节流**（state 2s / 心跳 10s），内存永远是权威 | `playback-memory.service.ts` | 不节流会让房主 500ms 一次的推送把 SQLite 写成瓶颈（迁移期还与 Node 共库） |
| `setPlayback` 覆盖整个 state 时必须**保留 `hostSocketId`** | 同上 | 丢了会让 `isHostOnline` 在房主在线时返 false，服务器心跳与房主广播同时发，观众进度来回跳 |
| 心跳**不校验房间模式**（screen-share 下同样转发） | `heartbeat.handler.ts` | 观众端靠心跳重置「房主离线」计时器，漏转发 = 6 秒后误报离线并暂停播放 |
| 心跳在**没有播放缓存时不能创建**（直接返回） | `playback-memory.service.ts#applyHostHeartbeat` | 心跳缺 `sourceUrl` 等字段，凭空建一条会让观众加入时拿到「有状态但源为空」的记录 |
| `watch-together-state` / `control` 要先判「活跃房主」再判「房间是 watch-together 模式」 | `playback-memory.handler.ts` | 顺序反了会把「没权限」的人告知成「模式不支持」，前端提示语对不上 |
| `watch-together-request-state` 无状态时：ack 里 `data` 必须是**显式 null**，同时向房间广播**零参数**的 `watch-together-request-state` | 同上 | `data` 键缺失与 `data:null` 前端走不同分支；带 `null` 参数的广播会让观众端 `if (payload)` 判成真 |
| 观众自检（`check-status`）容差 **10s**，且**不比对 playbackRate** | `check-status.ts` | 观众软同步追赶会临时 +0.1 倍速，比倍速会在追赶期误触发纠偏、打断收敛；容差必须显著大于主路径阈值 |
| `add-movie` 走的是 `createMovie`，**不做** REST 那套 url/title 必填校验、挂载凭证回填、内网强制代理 | `movie-list.handler.ts` | 两条路径本来就不是一套校验，照搬 REST 会让 socket 侧能加的「先占位后补链接」影片被拒 |
| `play-movie` 广播 `current-movie` 用 `io.to(room)`（**发送者也收**），与 `p2p-mode-change` 的 `socket.to` 相反 | 同上 | 切换当前影片要所有人（含发起者）同步到同一个 id |
| 服务器心跳**不按房主在线跳过**，只按「房间有没有连接」跳过 | `playback-broadcaster.service.ts#broadcastAll` | 服务器推算值是观众进度的**唯一权威来源**；房主在线时也发，否则房主广播与服务器心跳两条时间轴在观众端打架 |
| 每轮同时发 `server-heartbeat`（带 `roomId`）与 `sync-heartbeat`（`source:'server'`，**不带** `roomId`） | 同上 | 老前端只认前者、统一协议只认后者；`sync-heartbeat` 与音乐侧共用事件名，多带一个 `roomId` 会让两条协议分叉 |
| 房主在线判定带 **5s TTL 缓存**，查询失败按**离线**处理 | 同上 `isHostOnlineCached` | 每 2s × 每房间打一次 session 表太贵；失败按在线会让观众端永远进不了自主控制模式 |
| 清理顺序：**先清播放记忆，再清房间运行时状态** | `playback-broadcaster.service.ts#start` / `room-state.service.ts#cleanupStaleStates` | 运行时状态的判据里含「有没有播放记忆」，反过来清永远清不掉 |
| 清理用的「房主在线」是**连接存活**（`hostSocketId` 那条 socket 在不在），不是 session 表的房主 | `playback-memory.service.ts#isHostOnline` | 后端重启后从 DB 恢复的 `hostSocketId` 早已失效，按 session 判会把陈旧缓存一直留着 |
| 清理时 `connected` 回调缺失按**在线**处理（不清） | 同上 | 没有连接信息时宁可留着播放记忆，也不要误删 |
| 陈旧判定阈值 **10 分钟**，且**先落盘再删**（DB 记录一起删） | `cleanupStaleCache` | 房主可能只是掉线，重连后要接着播；DB 记录留着会在下次重启被当成有效状态读出来 |
| 进程退出：**先停定时器再 `flushAllDirty`**，最后才 `Shutdown` | `index.ts#gracefulShutdown` | 定时器不停，落盘期间还有新状态写进内存，刚写进 DB 的那份立刻变旧 |
| `request-current-movie` 的载荷**恒带 `movieId` 键**（没在播就是 `null`），不能 `omitempty` | 同上 | Node 的 `getCurrentMovieId` 对「没选过」与「已清空」都返回 null |
| `subtitle-update` 转发的是**整份原始载荷**（含 `roomId`），并缓存供 `subtitle-request` 补发 | `subtitle-sync.handler.ts` | 观众端把整份 payload 合并进本地状态，少一个键就少同步一项 |
| `subtitle-request` **没有 ack**，非法输入静默返回 | 同上 | 加了 ack 会让前端的 `emit` 多一个回调，行为虽不坏但与 Node 不一致 |
| `track-change` 的 `value` 要能区分「缺失」与「显式 null」 | `track-sync.handler.ts` | `null` 是「关闭该轨道」，缺失是「没带这个字段」，前端两处判断不同 |
| 申请类事件（`seek/pause/play-request`）转发时要**附加 `viewerSocketId` + `viewerUsername`**，房主不在线直接拒 | `seek-approval.handler.ts` | 不附身份房主端弹不出「谁想跳转」；不拒会让前端停在「等待房主确认」 |
| 回应类事件（`*-response`）只做定向转发，**不改播放状态** | 同上 | 房主端接受时已自行 seek/pause/play 并广播过 control，服务端再改一次会重复推进进度 |
| 「在房判定」必须先看 `socket.data.panelRoomIds`（评论独立窗口），命中则改判 `canReadRoom`，再回落 session | `room-permission.service.ts#isInRoom` | 独立窗口**没有 session**；少了这条分支评论窗口发不出任何消息，且不报错 |
| `join-room-panel` 成功后要**立刻失效权限缓存** | `comment.handler.ts` | 同一 socket 之前查过 `isInRoom=false` 会缓存 5s，不失效则进面板后 5 秒内发言全被拒 |
| `join-room-panel` 不建 session、不占人数位、不走审批 | 同上 | 它只是「读评论」的轻量入口，建 session 会把房间人数顶满并影响准入 |
| `send-comment` / `send-danmaku` 的 `new-comment` / `danmaku` 用 `io.to(roomId)`（**发送者也收**） | 同上 | 评论要立刻在自己界面上屏，靠回显会有一帧延迟 |
| 实时弹幕日志的 `time` 键在 `videoTime` 缺失时**必须整个消失**，不能写 0 | `danmaku-meta.service.ts#appendRealtime` | 写 0 会把弹幕钉在第 0 秒；`JSON.stringify(undefined)` 会丢键 |
| 弹幕辅助数据落库/广播失败**不影响弹幕上屏** | `comment.handler.ts#send-danmaku` | 实时弹幕的价值是「此刻看到」，存储失败只记日志 |
| 实时弹幕日志上限 **500 条**，超出丢弃最旧的 | `REALTIME_LOG_LIMIT` | 这是「最近弹幕」而非全量存档，不截断会让 meta 行无限膨胀 |
| `danmaku-meta-updated` 三个字段**恒为数组**（坏数据回落到 `[]`） | `serializeDanmakuMeta` | 前端直接 `.map`，`null` 会抛 TypeError |
| `clear-annotations` 是**零参数**事件，且只有房主能发 | 同上 | 用 `payload=nil` 会编成 `[null]`，前端 handler 收到 null 而非 undefined |
| `annotation-stroke` 只转发 `{stroke, senderId}`，`stroke` 缺失时整个键消失 | 同上 | 笔画的内部结构归客户端管，服务端不解析（解析就会限制前端演进） |
| 评论历史按 `createdAt` **升序**，同毫秒按插入序兜底 | `comment.service.ts#listComments` | 只按 createdAt 排时同毫秒多条顺序不稳定，前端历史列表会跳 |
| **`UPLOADS_DIR` 不做额外 `Clean` 化**，保持 Node 的「env 原值」语义 | `routes/server-files.ts` | Node 的 `UPLOADS_ROOT` 是 env 原值、`add-root` 用 `path.resolve` 与它比较；Go 侧一旦规范化，字符串形态分叉会让「该目录已是默认空间」的守卫静默失效，uploads 根被写进 `server_folder`，之后所有 `custom:N` 指向错误目录、`readonly` 全错 |
| 服务器文件路径必须用 **`filepath.Rel`** 判越权，不能拼字符串前缀 | `internal/serverfiles` | Windows 盘符根（`D:\`）自带分隔符，字符串拼接会拼出 `D:\\` 把合法路径误判成越权 |
| `ToPrefixedPath` 必须把 `rel == "."` 当成根路径 | 同上 | `filepath.Clean` 把正斜杠换成正平台分隔符，与 `root.AbsPath` 字符串不等；不判 `"."` 会输出 `uploads:/.`，前端面包屑与「当前目录」比较全部失配 |
| 416 响应**不写响应体** | `range-stream.ts#sendRangeNotSatisfiable` | Node 是 `res.status(416).setHeader(); res.end()`。播放器只看状态码与 `Content-Range`，塞 JSON 会让它把响应当成媒体数据解析 |
| 目录项的 `size` 键**整个消失**（不是 0） | `server-files` 目录 DTO | Node 的 `size` 是 `undefined`，`JSON.stringify` 丢键。写 0 会让前端排序把目录与空文件混在一起 |
| 上传必须用**流式** multipart 读取，且 `targetDir` 字段要排在文件 part 之前 | `routes/server-files.ts` | `ParseMultipartForm` 先把整个请求体落临时文件，10GB 上传写两遍盘；字段顺序反了则边收边定根会失败 |
| 服务器文件根目录注册表带 **30s TTL + 主动失效** | `internal/serverfiles/paths.go` | `/proxy` 在 seek/预取时高频到达，每次查 `server_folder` 全表是纯浪费；只做 TTL 则「新增根后立刻浏览」看不到 |
| 直链解析缓存 key **不含 userId**（`type\|serverURL\|path`） | `internal/api/directresolve.go` | 同一源文件跨影片、跨房间共享解析结果；带 userId 会让缓存命中率归零并放大上游压力 |
| 直链升级前必须**现场再探**一次（`UpgradeDirectURLValidated`） | `mountutil` | `httpsDirect` 是配置期一次性探测的持久缓存，源站拆掉反向代理后陈旧的 `true` 会变成永远连不上 |
| 流量统计取不到时回 **501**，不能回 0 | `routes/stats.ts` | 回 0 会让用户以为服务器真的没流量 |
| 客户端日志端点**不鉴权** | `routes/client-logs.ts` | 登录页/游客态的报错最需要收集；鉴权会让最该有日志的场景一条都没有 |
| 中文排序必须**汉字优先于拉丁** | `Intl.Collator('zh-Hans-CN')` | x/text 走 CLDR 根规则（拉丁在前）正好相反；纯 ASCII 目录看不出来，中英混合目录整段颠倒 |
| 管理端三套 403 文案**不能合并** | `middleware/auth.ts#requireRoot` / `admin.ts#adminOnly` / `admin.ts#rootOnly` | 「仅超级管理员可操作」「仅管理员可操作」「仅 root 可操作」是同一个判定的三种措辞，全部直接展示给用户；合并成一个等于改前端文案 |
| 管理端列表 `ORDER BY "createdAt" DESC` **不补 tiebreaker** | `routes/admin.ts` | Node 就这一句 SQL。自己加 `id DESC` 会让「同一秒创建的多行」排出与 Node 相反的顺序；两侧跑同一个 SQLite，同一句 SQL 才最忠实 |
| 改角色必须**吊销令牌**，审核通过**不吊销** | `routes/admin.ts` | 改角色不吊销 = 被降级的管理员在令牌过期前仍带 admin 权限（JWT 里的 role 是旧值）；审核通过时吊销会让刚被批准的访客立刻掉线，掉的正是「等审核」那条会话 |
| `Number('abc')`=NaN → **400**，`Number('1.5')` 是合法数字 → **404** | `routes/admin.ts` 的 `Number.isNaN(id)` | 只写「解析失败就 400」会让小数 ID 报出 Node 不会报的错；两种结果必须分开判 |
| 批量删除把**不存在**的房间号也计入 `count` | `room-removal.service.ts` | `deleteRoomAndRelations` 不校验存在性，`DELETE` 0 行不报错。单条删除有 404 守卫，批量删除没有——别"修正" |
| `DELETE /admin/rooms/:roomId` **不写审计**，`batch-delete` 写 | `routes/admin.ts` | 同一件事两条路径一条有记录一条没有。补齐会让「逐个删」与「批量删」的审计条数对不上 |
| 设置 PUT 是**整行写**，且未提交字段保持原值 | `routes/admin.ts` + `system-settings.ts` | Node 是「读实体→改几个字段→整行 save」；做成部分列 UPDATE 会让「显式 null 清空」与「未提交」两种语义分叉 |
| 重开房间后必须**清权限缓存** | `roomPermissionService.invalidatePermissionCache` | 缓存里有 5s 的 `isInRoom=false`，不失效则重开后头 5 秒观众发言仍被拒（表现为「重开了但进不去」） |
| `/bilibili/view` 的 `pages` 只下发 `page`/`part`/`cid`，**不带 duration** | `bilibili-videos.routes.ts` | 复用解析链的 `VideoPage` 会多一个键，前端分集下拉会显示冗余信息 |
| `fav-videos` 的收藏夹选择必须按 `mediaId → id===mid → list[0] → 显式 id` 四级回落 | `bilibili-favorites.routes.ts` | 改动顺序会让「传了列表外 id」时选错收藏夹 |
| 收藏夹列表缺 `count` 时**只翻一页**（`total` 初值 +∞、每轮改成本轮 append 前的长度） | 同上 | 初值写 -1 会让一页都不翻（Go 侧必须 `MaxInt64`） |
| 扫码状态的映射是「先看 `data.code`，未命中回落 `data.status ?? -1`」 | `bilibili-account.routes.ts` | 只看一边会让旧版接口的「已扫码」永远显示成「未扫码」 |
| 扫码成功后必须**逐跳**跟随 SSO 链收 Set-Cookie，且要求 `SESSDATA`+`bili_jct`+`DedeUserID` 齐全 | `helpers.ts#fetchCookiesFromSsoUrl` | 少收一跳就只有半个登录态：缺 `bili_jct` 时收藏/投币全部 -400 |
| 评论请求必须拼上 `buvid3`/`buvid4`，且 `loginLimited = !用户Cookie` | `bilibili-comments.routes.ts` | 缺 buvid 直接 -352 风控；把 buvid 当登录态会让前端误以为能翻页 |
| `link-meta` 判合集/系列必须比对 `meta.mid` 与链接 mid | `bilibili-lists.routes.ts` | sid 是两套命名空间，只按数字查会把别人的合集当成系列 |
| `fav/status` 未收藏时 `folderId`/`folderTitle` **整键消失** | `bilibili-favorites.routes.ts` | 写 0 / 空串会让前端「已收藏在 X 夹」拿到空壳 |
| 收藏/取消收藏的写请求**不重试** | 刻意与 Node 不同 | 重投会把刚做的变更翻回去（收了又取消），副作用不可逆 |
| CMS 列表接口 `ac=videolist` 为空必须回退 `ac=detail` | `cmsProvider.ts#requestVodList` | 部分老站只认 detail，少了这步表现为「搜索永远没结果」且不报错 |
| `vod_play_url` 的 `playFromIndex` 是**原始 `$$$` 下标**（跳过空组但不重编号） | `cmsProvider.ts#parsePlayGroups` | 重编号会让「线路二」播成「线路三」 |
| 配置/页面文本必须按「声明 charset → UTF-8 → GB18030」嗅探 | `anisubs/httpClient.ts#decodeBody` | TVBox 配置大量是 GBK 且不声明，硬解 UTF-8 会让中文源名整片乱码 |
| 配置拉取失败要回退过期缓存，且空注册表不写缓存 | `tvboxConfigLoader.ts` | 配置源本身波动大，「拉不到就零个源」是最差降级 |
| 聚合搜索按配置顺序输出，去重保留先到者位置、只补缺失的备注/封面 | `services/cms/index.ts#searchAllProviders` | 顺序不稳会让前端列表每次刷新都换序 |

## 七之二、刻意与 Node 不同的地方

这些是「对拍里对不上、但 Go 侧认为自己对」的点。改回去之前请先读原因——
每一条都对应一个会让用户看见的故障。

| 位置 | Node 的行为 | Go 的行为 | 为什么改 |
|---|---|---|---|
| FTP 流代理的响应体 | REST 只定起点、服务端发到文件尾，但 `Content-Length` 只声明请求区间 → 实际字节数**多于**声明，curl 报 `Excess found in a read`，部分播放器直接判定流损坏 | 按声明长度截断（`io.LimitReader`） | HTTP/1.1 要求响应体长度必须等于 `Content-Length`；多出来的字节会被当成下一个响应。对拍脚本因此只比较「声明长度内的字节」 |
| FTP `serverUrl` 的主机解析 | `serverUrl.replace(/^ftp/i, '')` 把 `ftp.example.com` 变成 `example.com` | 按 scheme 前缀或裸主机正确处理，完整保留 `ftp.example.com` | 前者是笔误级别的正则（想剥 `ftp://` 协议头），实际结果是「主机名以 ftp 开头就必然连不上」 |
| FTP 裸主机里的端口 | `host:2121` 会被整段当主机名交给 `net.connect`，端口参数被忽略 | `host:port` 形态直接采用其中的端口 | 同一个函数里既然已经从 URL 取 `hostname`，裸主机形态也该认端口 |
| Emby m3u8 里的非法子资源 | 改写回调抛错，整个请求 500（已吐出的分片作废） | 该条 URI 置空，其余条目照常输出 | 抛错会让「一个坏分片」拖垮整段播放列表；置空既不影响其余分片，也绝不把带 `api_key` 的原始地址回退给客户端 |
| B站 收藏 / 取消收藏的 POST | `bilibiliFetch` 对 412 风控做 3 次重试（写请求也重试） | 写请求不重试，直接报错 | 重投会把刚做出的变更再翻一次（收了又取消），副作用不可逆；失败让用户点一次即可 |
| 动漫源的上游请求超时 | `fetch` 无超时，挂住的上游会永久占住请求 | 30s 超时（`internal/anime/http.go`），超时报 `context deadline exceeded` | Go 侧挂住就是一条泄漏的 goroutine + 连接，没有事件循环帮你回收；上游真挂死时错误文案会与 Node 不同，属于可接受的差异 |
| CMS/TVBox 文本抓取的重试与 TLS 兜底 | fetch 失败后起 `powershell Invoke-WebRequest` 借 .NET 的 TLS 指纹绕过 Cloudflare | 只用 Go 的 net/http，不设子进程兜底 | Go 的 TLS 栈本来就是独立指纹，不存在「Node 指纹被拦」这个前提；起子进程既慢又会把错误信息变形 |
| 一起听的 NCM 上游从哪来 | 进程内起 `@neteasecloudmusicapienhanced/api`（127.0.0.1:36530） | `NCM_API_BASE` 指向外部服务，并用探测决定 `NCM_UNAVAILABLE` | Go 不带那 3 万行 npm 包；不跑外部服务时音乐面板收到 503，属于**新增部署依赖** |
| Kazumi 生成 URL 里的 query 顺序 | 按规则 JSON 里的书写顺序 | 按键名排序 | Go 的 map 无插入序；上游对参数顺序不敏感，只在多键 `episodePage.query` 时可见 |
| Kazumi 生成 URL 里的 `~` | `URLSearchParams` 编成 `%7E` | `url.Values.Encode` 保留 `~` | 同上，纯编码口味差异 |
| ani-subs 抓站的重试与 TLS 兜底 | fetch 失败后起 `powershell Invoke-WebRequest` 借 .NET 的 TLS 指纹绕过 Cloudflare | 只用 net/http（`internal/webfetch`） | 同 CMS 那条：Go 的 TLS 栈本来就是独立指纹；真被按指纹拦时该换源，而不是在服务端起子进程 |
| 浏览器头的 `Accept-Encoding` | 原样发送 `gzip, deflate, br` | 一律剥掉，交给 transport 自己协商 | Go 只会自动解 gzip，服务端回 brotli 时拿到的是二进制，表象是「页面里找不到选择器」，极难排查 |
| 更新包解压失败（Windows） | `powershell Expand-Archive` 对非压缩包**退出码仍为 0**（错误只写 stderr），于是 Node 认为解压成功，继续生成更新脚本并 detached 拉起它 | `archive/zip` 直接报错 → 500「解压失败: …」，不会产生任何脚本 | 这是 Node 的缺陷而非特性：实测对着垃圾字节走一遍，脚本真的被拉起来了，它会 `taskkill /IM node.exe` 并把仓库根 `config/` 挪走（随后恢复）。解压失败必须硬失败 |
| 更新包解压实现 | Windows 用 PowerShell、Linux 的 zip 用 adm-zip、tar.gz 用系统 `tar` | 一律标准库 `archive/zip` + `archive/tar` | 容器里没有 `tar`/`unzip` 也要能更新；三套实现还会带来三套失败语义。代价是「解压失败」的具体文案与 Node 不同，对拍只比状态码 |
| 更新脚本的自删除 | bat 结尾 `del "%~f0"` 的注释与实际不符（脚本并未删除自己） | 不尝试自删 | 自删依赖「脚本已读入内存」这个未定义行为，两种结果都能接受，不做无意义的对齐 |
| OBS 推流的媒体服务 | 进程内 `require('node-media-server')` 起 RTMP 3334 + HTTP-FLV 3335 | **已改为进程内实现**（`internal/nms`，阶段 33，见 3.26）；`NMS_HTTP_FLV_URL` 仅作为「用外部媒体服务」的可选路径，可用性 = TCP 探得通（5s 缓存） | 当初外部化是为了不重写 RTMP 服务器；结果是三种交付形态都不带媒体服务，开箱推流直接不可用，等于丢了一条产品能力，所以补了进程内实现 |
| 推流可用性判定的时延 | 进程内布尔量，零延迟 | 5s TTL + 300ms TCP 探测 | socket 事件会反复问；每次握手不划算。最坏情况是「NMS 刚起来 5s 内仍报不可用」 |
| `obs-config` 补推流码的写库粒度 | `roomRepo.save(room)` 整行写（含 shareMethod 等） | 只 `UPDATE "streamKey"` 一列 | 整行写会把并发修改的其他列覆盖回读到的旧值；「先下配置、再切子模式」是正常流程，不该被顺带改掉 |
| `SERVER_HOST` 推导时的 IPv6 | `host.split(':')[0]` 把 `[::1]:3333` 切成 `[`，生成 `rtmp://[:3334/live` | `SplitHostPort` 后补回方括号，生成 `rtmp://[::1]:3334/live` | Node 那行对 IPv6 是明显的坏地址；Go 修好它不影响任何 IPv4/域名场景 |
| `/live` 的反代实现 | 复用通用 `proxyHttpUpstream`（含 Range 收敛、https→http 降级、HLS 改写） | 专用极简反代：透传 Range/条件头、wildcard CORS、32KB 分块 + 立即 flush | FLV 是长连接推送，套用「Range 收敛 + 30s 连接超时」那套反而会掐断直播流；这里只需要「字节搬运 + 及时 flush」 |
| OpenList 列表的错误文案 | `listOpenListDirectory` 原样抛上游文案（`[AList 服务器] object not found`） | 与 Node 完全一致：`ListDirPaged` 不翻译，只有 `FetchFileInfo` 才改写成人话 | 一开始 Go 在 `ListDir` 里做了「认证失败/目录不存在」的改写，对拍立刻报差异。翻译只该发生在**用户直接看见播放失败原因**的那一层 |
| OpenList 挂载删除的一致性 | 在「刚 PUT 过该挂载」的对拍序列里，`DELETE` 回了 200 但行仍在列表里（sql.js 持久化的写后读不一致），第二次 DELETE 也可能回 200 | 每次写都直接落盘：删除后列表立即为空，再删一次 404 | 「删了没删掉」对用户是数据安全问题，不能对齐。因此对拍不断言「删除后列表」，该语义由 `openlist_mounts_test.go` 断言 |

## 八、每个单元的完成定义（DoD）

1. `go build ./...` 与 `go vet ./...` 干净；
2. 有单元测试覆盖核心分支（尤其是错误分支）；
3. 与 Node 版对同一输入的响应**逐字段相等**（含错误文案）；
4. 涉及的库表读写不改变 schema；
5. 在 `MIGRATION.md` 的状态列打勾，并补一句验收口径。

## 九、切换检查单（阶段 5）

- [x] 全部端点覆盖，Go 侧 `/api/*` 无 404 兜底命中
      → `bash backend-go/scripts/route-parity.sh`：Node 运行时 189 条 `/api` 路由逐条
      打到 Go，**189/189 命中、0 次 panic**。首次跑出 13 条缺口（OpenList 12 + stream
      媒体代理 2 里的 1 条），已按 3.22 补齐；这条检查单本身抓出了「台账说完成、
      实际只迁了一条」的漏项，以后每次改路由都要重跑。
      配套 `bash backend-go/scripts/events-parity.sh`：19 个 handler / **65 个上行事件
      与 Go 精确相等**（零缺失零多余），`disconnect` 走 `OnDisconnect` 单独核对。
      两者的端点/事件清单已冻结成契约快照（见下「契约快照」），删掉 `backend/` 后
      仍可继续跑。
- [ ] 停 Node 进程 → 仅 Go 运行 24h 无告警
      → **压缩版已就绪并跑通**：`bash backend-go/scripts/soak.sh`（默认 120s，4 并发，
      11 个代表性端点）实测 60s **74,148 次请求 / 0 超时 / 0 个 5xx / 吞吐无衰减
      （后半程 1.05×前半程）/ 无 panic**。真机 24h 用同一条命令：
      `SOAK_SECONDS=86400 bash backend-go/scripts/soak.sh`（这一步只能在目标机器上做，
      需要停掉 Node 进程独占 `config/dev.sqlite`）。
- [x] `config/` 目录双向兼容验证：Go 写入后 Node 仍能读（回滚保障）
      → `bash backend-go/scripts/config-roundtrip.sh`：同一份 `cfg/` 上跑三轮
      （Go 写 → Node 读写 → Go 再读），快照全等；另加两条硬断言：Node 启动后
      `jwt-secrets.json` 的 sha256 不变（能解析、没重生成），以及证书双向互操作
      （node-forge 生成的证书 Go 能加载、Go `--gen-cert` 的证书 Node 能加载）。
      细节见本节末尾「config/ 兼容性实测」。
- [x] 前端全链路回归（首页 / 房间 / 一起听 / 管理端）
      → `bash backend-go/scripts/frontend-smoke.sh`：前端 `tsc` + `vite build` + 单测，
      再由 Go 托管产物、用真实 Chromium 逐页访问（首页/登录/房间列表/管理页/个人中心/
      房间页），断言「页面锚点文案 + 控制台零 error + 无 4xx/5xx 请求」，**12 项全过**。
      这条一跑就抓到一个**线上级 bug**：`GET /` 回 404 JSON（见下）。
- [x] 桌面壳改为同进程内嵌，删除 `ZVIEWER_DESKTOP` 注入与 409 分支
      → **决策变更：不内嵌，壳继续以子进程托管 Go 产物**（用户 2026-10-25 决定）。
      理由见下方「关于同进程内嵌的取舍」：子进程模型已经有 Job Object 回收、崩溃隔离、
      重启按钮与日志按行转发，换成同进程要把这些全部重做一遍，收益只是「少一个进程」。
      前置验证 `bash backend-go/scripts/desktop-env-smoke.sh` **8 项全过**（TLS + /health、
      静态首页、匿名 401 → root 409 + `desktopManaged:true`、无 panic）。
      构建链路已切换：
        · `node build-all.js --win` / `--linux` 默认用 `go build` 产出
          `dist/<平台>/zviewer-backend(.exe)`（`--backend=node` 可回退旧的 pkg 打包）
        · `npm run build:exe` 同样默认走 Go（`--backend=node --skip-build` 回退）
        · `ZVIEWER_DESKTOP` 与更新端点的 409 守卫**保留**——整包更新仍归 GUI，
          网页端不该自己替换被托管的二进制
- [ ] 删除 `backend/` 与 `node_modules`
      → **暂缓，但前置工作已做完**：`backend/` 是回滚路径，不能凭「迁移完成」就删。
      两步走：① 真机按 `SOAK_SECONDS=86400 bash backend-go/scripts/soak.sh` 跑满 24h
      并跑通 `config-roundtrip.sh`；② 再按下面「删除 `backend/` 的影响面」逐项收尾。
      在真机验证通过之前，保留 `backend/` 的回滚能力（`git checkout` 即可恢复源码，
      `npm install` 恢复依赖）。
      **已完成的收尾**：运行/开发入口已全部切到 Go（见 3.24）——`npm run dev` /
      `npm run build` / `npm start` / `start-prod.sh|ps1` 都不再依赖 `backend/dist`，
      也不再需要 `node_modules` 里的 express/typeorm/sql.js。

### 全量回归汇总：`regression-sweep.sh`

一条命令按顺序跑完仓库里全部 **13 个**纯 Go 验收脚本（串行——它们各自要占随机端口起进程，
并行会互相踩），输出「通过/失败/耗时」表，失败项自动打印日志尾部：

```bash
bash backend-go/scripts/regression-sweep.sh            # 全部
bash backend-go/scripts/regression-sweep.sh http-voice # 只跑名字匹配的
```

第一次跑就红了 6 项，没有一项是「随机抖动」，每一类都有明确根因：

| 失败项 | 根因 | 处理 |
|---|---|---|
| `rooms-parity` / `webdav-parity` / `ftp-parity` / `emby-parity` | **种子时间戳过期**：这些脚本把房间的 `lastAccessedAt` 写死成 `2026-01-01`，而 Go 启动即跑一轮「长期无人访问房间清理」（阈值 24h），把种子房间连同挂在它身上的影片一起删了；Node 侧用的是最小 express 应用、不跑清理，于是「列表/影片流」一侧 200 一侧 404 | 种子改成「以 now 为基准」的相对时间，并清空基线库里的历史房间/影片（`rooms-parity` 的三处时间列也一并参数化） |
| `sio-rooms-parity` | **自伤**：跑 sweep 的同时我用 `taskkill /IM zviewerd.exe` 清理实验进程，把它刚拉起的 Go 服务一起杀了（表现为「Go 侧缺少该步骤」「事件不同」） | 重跑即通过；教训是「按镜像名杀进程」在并发跑测试时是危险的 |
| `http-bilibili-parity` | `search` 一步打的是 B站**线上**搜索接口，上游返回骨架偶有变化 | 重跑通过；这类外部依赖项在对账里天然有抖动，不能当成回归失败 |
| `soak` | **真 bug**：`GET /api/rooms/:id/danmaku-meta` 偶发 500 —— `Metas.GetOrCreate` 是「SELECT 不到就 INSERT」，而 `roomId` 上有 UNIQUE 索引；4 并发同时首次打开房间时后到的必撞约束 | `GetOrCreate` 在 INSERT 失败后重读一次（另一请求已建好）；新增 `TestMetasGetOrCreateConcurrent`（16 并发、文件库、断言只有 1 行），已验证「去掉修复必红」 |

其中 soak 那条只有**并发**才能暴露：Node 版 sql.js 单线程，`await` 之间不会被同类写入
插队，所以 13 套 HTTP 对拍全部通过，问题一直藏到压测才现形。

最终结果（修完之后）：

```
汇总：通过 33 / 失败 0 / 跳过 0          总耗时 7m26s
route-parity 9s   events-parity 2s    http-bilibili 35s   http-anime 17s
http-anisubs 15s  http-cms 16s        http-kazumi 15s     http-music 13s
http-openlist 13s http-serverfiles 17s http-subtitles 16s http-updater 15s
http-voice 14s    http-streampush 12s  http-admin 16s      webdav 7s
ftp 7s            emby 7s              movie 10s           rooms 6s
bilibili 17s      sio-rooms 39s        profile-smoke 3s    movie-smoke 4s
proxy-smoke 4s    openlist-smoke 4s    bilibili-smoke 10s  compat-smoke 1s
https-smoke 5s    desktop-env 4s       config-roundtrip 43s frontend 16s
soak 34s
```

另外两个「只有跑全套才会撞见」的坑，记在这里省得下次再踩：

- **同一脚本内两次种子必须用同一个时间戳**：`rooms-parity` 的种子脚本对 node/go 两个库
  各调用一次，各自 `datetime.now()` 会差 1 秒，`:48` 与 `:49` 落到列表里就是 2 处差异，
  且只在跨秒时偶发（跑 3 次可能全绿）。现在由 bash 侧算一次再传参。四个脚本统一如此。
- **不要一边跑 sweep 一边按镜像名杀进程**：`taskkill /IM zviewerd.exe` 会把脚本刚拉起的
  服务一起杀掉，表现成「Go 侧缺少该步骤」「事件不同」，看起来像实现 bug。

### 契约快照：让「端点/事件全覆盖」在 Node 退场后仍然可验证

删掉 `backend/` 会连带废掉两件事的**判定依据**——`route-parity.sh`（Node 运行时路由表）
与 `events-parity.sh`（Node 运行时事件表）都以 Node 为参照。所以在删之前先把参照物冻结：

| 快照 | 内容 | 生成方式 |
|---|---|---|
| `backend-go/testdata/contract/routes.json` | **189** 条 `/api/*` + `/health`（含方法） | `node backend-go/scripts/route-audit.js --snapshot backend-go/testdata/contract/routes.json` |
| `backend-go/testdata/contract/events.json` | **65** 个上行 Socket 业务事件 + `lifecycle:[disconnect]` + 19 个 handler 名单 | `node backend-go/scripts/event-audit.js --snapshot backend-go/testdata/contract/events.json` |

两个脚本都支持 `--fixture`：**只读快照、不 require ts-node、不碰 `backend/`**。

- `route-parity.sh` 会自动判断：`backend/src` 还在 → 用实时路由表（能发现 Node 新增了什么）；
  不在 → 自动切 `--fixture backend-go/testdata/contract/routes.json`（也可显式 `--fixture`）。
- `events-parity.sh` 同理：`backend/src` 存在时现采 Node 事件表，否则用快照。

冻结时踩到两个坑（都已在脚本里处理）：

1. **事件表不能静态抓源码**：`socket.on('...')` 的匹配会混进 `SIGINT/SIGTERM`、
   `close/data/end/finish/timeout`、NMS 的 `prePublish/postPublish/donePublish/postClose`、
   甚至 EventEmitter 的 `error`。改成**运行时 harness**——拿生产同一份
   `createSocketRegistry()`，用会记账的假 socket 调 `registerAll()`，`on()` 挂上什么就是什么，
   得 19 handler / 65 事件（`disconnect` 是框架级，单列）。
2. **Go 侧有三条事件是循环注册的**：`for _, event := range []string{"signal-offer",
   "signal-answer", "signal-ice-candidate"} { sc.On(event, ...) }`，只认字面量 `.On("x")`
   会把它们误判成「缺失」。但本包里 `[]string{...}` 也用来装角色名
   （`isInRoom`/`isRoomHost`/`isRoomModerator`），所以只有在字面量后 4 行内出现 `.On(`
   时才当作事件列表。修好后 **Node 65 / Go 65 精确相等，零多余零缺失**。

### 删除 `backend/` 的影响面（删之前必须处理的引用点）

按「会不会直接坏」排序，删 `backend/` 时逐条处理：

| 引用点 | 现状 | 处理 |
|---|---|---|
| `backend-go/scripts/` 下 **20 个**脚本（13 个 `http-*-parity.sh` + `sio-rooms-parity.sh` + `config-roundtrip.sh` + 4 个 fixture/dump 生成器 + `route-audit.js`） | 起 Node 后端做参照 | 迁移期工具，随 `backend/` 下线；`route-parity.sh` / `events-parity.sh` 已改为会自动退回契约快照，可以留作长期回归 |
| 根 `package.json` 的 `workspaces: ["frontend","backend"]` | 引用 backend workspace | 改成 `["frontend"]`，同时改 `dev`（→ `go run ./cmd/zviewer-server` 或前端 dev + Go dev）、`build`/`lint`（`-ws` 只剩前端）、`dev:backend`、删 `test:server` |
| `scripts/server-regression/*`（7 个文件，`npm run test:server`） | 直接 spawn `backend/dist/index.js` 做 Node 服务级回归 | 与 backend 一起删除（Go 侧对应覆盖是 `go test ./...` + smoke 脚本） |
| `scripts/prune-pkg-bloat.js`（postinstall） | 为 pkg 打包瘦身 | pkg 已不用（构建默认 `go build`），postinstall 可删 |
| `build-all.js` / `scripts/build-exe.js` | 已默认 `--backend=go` | 删掉 `--backend=node` 分支与 `pkg` 配置块 |
| `node_modules/`（含 ts-node、express、typeorm、sql.js…） | 只有对拍脚本与 server-regression 需要 | 随上面两项一起删；前端仍需要 `npm install`，但依赖会大幅缩减 |

**推荐顺序**：真机 24h → `config-roundtrip.sh` 通过 → 冻结快照（已完成）→ 改根 `package.json`
与构建脚本 → 删 `scripts/server-regression` 与 Node 对拍脚本 → 最后 `git rm -r backend`
与 `node_modules`。每一步之后都能 `gofmt/vet/test` + `regression-sweep.sh` 复验。

### 关于「同进程内嵌」的取舍（第 5 项的决策点）

现状：壳把后端当**受管子进程**（`ProcessHost.exe` + Job Object），退出时整棵进程树回收。
把它改成同进程要动的地方很多：start/stop/restart 状态机、日志按行转发、端口占用检查、
HTTPS 证书装配、以及「网页端版本更新」那条 409 守卫（同进程后这条守卫仍然需要，
因为整包更新归 GUI 管，除非把更新链路也搬进壳里）。

而现在 Go 产物在壳注入的环境下**行为已经与 Node 一致**（上面 8 项），所以有两条路：

| 方案 | 改动 | 风险 | 收益 |
|---|---|---|---|
| A. 保持子进程，只换二进制 | 打包脚本把 `zviewer-backend.exe` 换成 Go 构建产物 | 低（沿用 Job Object、崩溃隔离、重启按钮） | 迁移完成，且保留崩溃隔离 |
| B. 真·同进程内嵌 | controller 生命周期重写 + 删 ProcessHost 后端托管 + 分发包只出 1 个 exe | 高（端口/证书/重启/日志/更新全要重做） | 少一个进程、单文件分发 |

清单原文写的是 B，但 A 已经能达成「切到 Go」的目标，B 更像后续的产品化优化。

**最终决定（2026-10-25）：走 A。** 主进程是 Wails 壳，后端是它托管的另一个进程；
`ZVIEWER_DESKTOP=1` 与更新端点的 409 守卫保留。切换点只在构建链路：
`build-all.js` / `build:exe` 默认用 `go build` 产出 `zviewer-backend(.exe)`，
产物体积从 56 MB（pkg）降到 19 MB。


### 前端冒烟抓到的 bug：站点根路径 404

`spaHandler` 的目录穿越防护写的是 `strings.HasPrefix(full, dist+separator)`，
而 `path.Clean("/") + filepath.Join` 得到的是 `full == dist`（没有尾分隔符），
于是**访问 `/` 直接回 404 JSON**——用户打开域名看到的是
`{"success":false,"message":"资源不存在"}`。子路由（`/login`、`/room/x`）反而正常，
所以静态检查、API 对拍、`https-smoke` 全都没发现，只有真浏览器打开首页才暴露。

修法：单独放行 `full == dist`（根目录本身），其余仍按前缀校验；
补 `internal/api/static_test.go` 把边界钉住：`/` 回 index.html、前端路由回退、
`/api/*` 未被回退吃掉、`POST /` 405、目录穿越读不到 dist 外文件、产物缺失时明确 404。

### 为什么这条回归必须用浏览器

API 对拍能证明「接口对不对」，但证明不了「页面能不能用」：这次两个问题都在
浏览器侧——根路径 404（服务端返回 JSON 而不是 HTML），以及**明文 HTTP 下不写 cookie**
（两侧刻意一致：SameSite=None 必须配 Secure）。前端在 HTTP 模式把 token 放
localStorage、由 `authTransport` 附加 `Authorization` / socket `auth.token`；
冒烟脚本必须按这个真实链路注入 token，否则会误判成「登录无效」。


### config/ 兼容性实测（第 3 项的细节）

`config/` 里只有四类东西，每类都有自己的兼容风险：

| 文件 | 风险 | 实测结论 |
|---|---|---|
| `dev.sqlite` | Node 用 sql.js **整库导出**写盘，Go 用 SQLite 页写 | 双向可读：Go 写的用户/设置/根目录 Node 全看得到，Node 写的 Go 也看得到（含 bcrypt 口令哈希、system_settings 列、server_folder 行） |
| `jwt-secrets.json` | 键名/结构不一致会让另一侧重新生成，**回滚瞬间所有已签发 token 失效** | 两侧同为 `{"access","refresh"}`；Node 启动后文件 sha256 不变（说明是解析复用而非重写） |
| `ssl/` | 私钥形态：Node 用 node-forge 的 **PKCS#1**（`BEGIN RSA PRIVATE KEY`） | 双向可加载：仓库里现成的 node-forge 证书能被 Go 起 HTTPS；Go `--gen-cert` 的证书 Node 也能起 HTTPS |
| `uploads/` `media/` | 纯文件，没有格式 | 只做「服务启动后目录仍可用」的间接验证 |

验证方式刻意做成**三轮快照对比**而不是单点断言：Go 第一次写入标记（41/41/dash=true），
Node 启动后的 before 快照必须逐字段等于 Go 的 after；Node 再写自己的标记（52/52/dash=false），
Go 第三次启动的 before 快照又必须等于 Node 的 after。任何一侧「写得进去、另一侧读不出来」
都会在这里断掉，包括最容易漏的「读出来但类型变了」（比如布尔被写成 0/1）。

## 十、Node 后端下线（阶段 5 收尾，2026-10-25）

`backend/` 已物理删除，Node 版不再作为回滚路径存在。删之前的验收口径与删之后的
可验证性见第九节；这一节只记录「删了什么、还留了什么、怎么复验」。

### 10.1 删除清单

| 对象 | 规模 | 说明 |
|---|---|---|
| `backend/` | 234 个文件（含 `dist/`、`src/`、`package.json`） | Node/Express 后端整体下线 |
| `backend/dev-bin/livekit-server.exe` | 56 MB | **未删**，`git mv` 到 `backend-go/dev-bin/`，Go 包起伴生进程仍需要它 |
| `backend-go/scripts/` 下的对拍工具 | 65 个（13 组 `http-*-parity.sh` + driver、`sio-rooms-parity.sh`、`config-roundtrip.sh`、4 个 fixture 生成器、mock） | 参照实现已不存在，留着只会一直红 |
| `scripts/server-regression/` | 7 个（`npm run test:server`） | 直接 spawn `backend/dist/index.js`，必然失效 |
| `scripts/{generate-cert,acme-client,prune-pkg-bloat,analyze-pkg-log}.js` | 4 个 | 证书签发与 pkg 瘦身都已在 Go 侧/构建链实现 |
| `release-zip.ps1` | 1 个 | 与 `npm run package` 重复的旧打包脚本 |
| 根 `node_modules/` | 重装 | `workspaces` 改成只剩 `frontend`，express/typeorm/ts-node/sql.js 等全部移除 |

`.tmp-parity/`、`.tmp-movie-parity/` 两个对拍工作目录（合计约 1.7 MB）也一并删掉，
`.gitignore` 里对应的两条规则同时移除。

### 10.2 留下的东西（不是漏删）

- **契约快照** `backend-go/testdata/contract/{routes,events}.json`（189 端点 / 65 事件）：
  `route-parity.sh --fixture` 与 `events-parity.sh` 在 `backend/` 不存在时**自动退回快照模式**，
  「端点/事件全覆盖」这条验收在 Node 退场后仍然可跑，不依赖 ts-node。
- **`regression-sweep.sh` 收敛到 13 个纯 Go 脚本**：所有 Node 参照脚本已从清单里摘掉，
  跑完仍是 7 分半左右，全绿。
- **`scripts/dev-backend.js` / `scripts/build-backend.js`**：Go 热重载与产物编译的唯一入口，
  不含任何 Node 后端逻辑。

### 10.3 复验口径

```bash
npm run test:go          # go test ./...（含 livekit 包单测）
npm run lint:go          # gofmt -l + go vet
npm run test:regression  # 13 个纯 Go 脚本，约 2 分钟
npm run build            # 前端 + Go 后端产物
```

任何一条红了都不算收尾完成。删除后首次全量回归的结果记录在本节末尾（见 10.4）。

### 10.4 删除后的实测结果

删除 `backend/`、`node_modules/` 重装之后再跑一遍，口径不变：

| 检查 | 结果 |
|---|---|
| `gofmt -l .` | 无输出 |
| `go vet ./...` | 通过 |
| `go test ./...` | 全部 ok（含 `internal/livekit` 0.119s） |
| `npm run test:regression` | **通过 13 / 失败 0 / 跳过 0，1m43s** |

13 项分别是：`route-parity`、`events-parity`、`profile-smoke`、`movie-smoke`、
`proxy-smoke`、`openlist-stream-smoke`、`bilibili-smoke`、`compat-smoke`、`https-smoke`、
`desktop-env-smoke`、`frontend-smoke`、`soak`、`spike-sio`。

有两点值得记下来：

1. **耗时从 7m26s 掉到 1m43s**：33 项里那 20 个起 Node 参照实现的对拍脚本占了绝大部分时间，
   删掉之后只剩纯 Go 冒烟。这不是覆盖度缩水——端点/事件的「全覆盖」已经由契约快照承接
   （189 端点 / 65 事件），`route-parity.sh --fixture` 与 `events-parity.sh` 每次都跑。
2. **`npm install` 之后仍有少量 extraneous 包**（`@babel/*`、`@types/babel__*`），
   是前端工具链的传递依赖残留在根 `node_modules` 里；`npm prune` 一次即可清掉，
   不影响构建与回归。

### 10.5 升级收尾：自动清理 v4（Node）遗留文件

Node 版用户点「一键更新」升到 5.0 时，**执行更新的还是 v4 的更新脚本**——它只会解压覆盖，
不认识 Go 版的新布局。所以清理不能放在更新脚本里（改不了已发布的旧脚本），
而是放在 **Go 后端首次启动**：`internal/updater/legacy.go#CleanLegacyArtifacts`，
幂等，每次启动跑一遍，没东西可删时静默。

删什么（只有确定不属于 Go 布局的）：

| 目标 | 条件 | 理由 |
|---|---|---|
| `zviewer-frontend.exe` / `zviewer-frontend` | 任何布局 | v5 由后端托管前端静态文件，不再有独立前端进程 |
| `zviewer-cert.exe` / `zviewer-cert` | 任何布局 | 证书签发已内置到 `zviewer-server --gen-cert` |
| `node_modules/` / `backend/` | 仅发布包布局 | Node 时代的依赖与源码目录；Go 版不需要 |
| `config/media` 下的 `.ts`/`.m3u8`/`.flv`/`.m4s` | 仅发布包布局 | node-media-server 的 HLS 切片；Go 推流是内存转封装，不落盘 |

「发布包布局」= 有 `frontend/dist/index.html`、**没有** `frontend/src`、**没有** `.git`。
源码树（含 `.git` 或 `frontend/src`）只删那两个可执行文件，绝不删目录——那里的
`node_modules`/`backend` 是开发者的东西。

`config/` 下的数据库、证书、上传文件、头像一律不碰；清理失败只记日志，不影响启动。
启动时会打一行：`[cleanup] 已清理 v4 遗留文件 N 项（约 X MB）：…`。

验收：`go test ./internal/updater -run Legacy` 覆盖发布包布局（全部清理 + 幂等）、
源码树（只删可执行文件）、空 root 三种场景；另用真实二进制在临时目录实测过一次
（删 5 项、保留 `keep.txt`、随后正常启动并监听）。

## 十一、数据库选型与调优（2026-10-25）

### 11.1 结论：不换库，继续 SQLite

Node 下线后重新评估过一次「换 PostgreSQL / MySQL」，结论是**不换**。判断依据是
实测负载，不是偏好：

| 维度 | 实测值 | 含义 |
|---|---|---|
| 库大小 | 148 KB（开发库），16 表 69 行 | 距离需要独立数据库服务的量级差 3-4 个数量级 |
| 写入模式 | 心跳**不落库**；播放状态是脏标记 + 显式 flush；弹幕追加 JSON；评论/审计低频 | 没有高频写热点，单写者完全够 |
| 压测 | 60s 7.4 万请求、0 超时 0 5xx，**只用了 2 条连接** | 当前 `MaxOpenConns=2` 还有余量 |
| 部署形态 | 单进程 Go：桌面壳子进程 / Docker 单文件 / 单机 `npm start` | 没有多实例、没有第二台机器共享库 |

PG / MySQL 唯一强于 SQLite 的是**多写者并发 + 多实例共享**，而这两点本项目都用不到；
换过去要多付独立进程（60~400 MB 常驻）、一套服务运维，以及一次真正的移植工程
（11 处 `LastInsertId` 改 `RETURNING`、16 张表 DDL 重写、`?` 占位符全量重绑、
20 多个测试文件的建表语句、数据迁移），换回的却是**更慢的单机读延迟**（多一次 TCP 往返）。

> 什么时候才真的该换：多机共享同一个库 / 多实例水平扩展 / 需要外部（CLI、BI、另一台机器）
> 直连数据库 / 单表千万行以上且持续高并发写。四条占一条再谈换库。

### 11.2 开启 WAL（默认）

`SQLITE_WAL` 从「显式 `1` 才开」改成「**默认开，`0` 显式关**」。当初默认关是因为要跟
Node 版共用同一个库、怕改写文件头的 journal 模式；`backend/` 删除后这个前提不存在了。

收益：读不被写阻塞（WAL 下读者看快照，写者追加 `-wal`），崩溃恢复只需重放 `-wal`，
并且可以不停服做一致性快照。

代价与配套（都已处理）：

- 库里会出现 `dev.sqlite-wal`、`dev.sqlite-shm` 两个旁文件。**直接复制主文件会丢最近
  提交的事务且看起来完全正常**，所以备份必须走 `VACUUM INTO`。
- Docker / 桌面壳挂载的是整个 `config/` 目录，旁文件跟着走，无需额外配置。
- 需要退回旧模式时设 `SQLITE_WAL=0`，`journalLabel` 会在启动日志里标明当前模式。

### 11.3 补三条索引

`VerifySchema` 只校验表与列，索引从来没被管过，而 TypeORM 建库时漏了两处高频查询：

| 索引 | 目标查询 | 依据 |
|---|---|---|
| `idx_danmaku_track_room` | `WHERE "roomId" = ? ORDER BY "id"` | 弹幕取数全按房间；二级索引隐含 rowid，单列即可同时满足过滤与排序 |
| `idx_session_active_room` | `roomId + role/socketId/userId + endedAt IS NULL` | 五个查询都以 `roomId` 起头且都带 `endedAt IS NULL` |
| `idx_session_active_socket` | `socketId + endedAt IS NULL` | 断线重连时按 socket 反查会话 |

后两条用**部分索引**（`WHERE "endedAt" IS NULL`）：只索引活跃行，索引更小、写放大更低，
且谓词与查询完全一致才会被查询计划采用。`indexes_test.go` 里用 `EXPLAIN QUERY PLAN`
钉住「必须真的用上」，避免建了等于没建。

与「绝不自动建表」的边界：**表/列的增删改仍然一律拒绝**（`VerifySchema` 缺表缺列直接
退出）；索引是纯性能结构，`CREATE INDEX IF NOT EXISTS` 幂等，建与不建都不改变任何一行
的可读性。启动时 `EnsureIndexes` 跑一次，连跑三次也只会是空操作（有测试覆盖）。

### 11.4 热备份入口

```bash
zviewer-server --backup-db <目标文件>      # 或 --backup-db=<目标文件>
```

走 `VACUUM INTO`：在单个读事务里把整库重写成新文件，WAL 下也一致，**不需要停服**。
目标文件已存在时直接报错而不是覆盖（避免把上一份备份冲掉）。实测：
`config/dev.sqlite` 副本 → 备份 156 KB，`room_danmaku_meta` 11 行完全一致，
新库的 `journal_mode` 回到 `delete`（新文件本来就没有 WAL）。

### 11.5 README 的一处旧描述

`DATABASE_URL` 在 README 里一直被写成「SQLite 路径或 PostgreSQL 连接串」，但
`resolveDatabasePath` 只把它当文件路径用（相对 `CONFIG_DIR` 或绝对路径），
从来没有任何 PG 代码路径。已按实际行为改正，避免再被当成「支持换库」。

## 十二、新库自举：`--init-db`（2026-10-25）

写开发文档时撞上一个硬问题：`config/` 在 `.gitignore` 里、代码又「绝不自动建表」，
于是**新克隆的仓库根本起不来**。更糟的是 `db.Open` 的报错还写着「请先用 Node 版完成
初始化」——Node 已经删了，这条提示指向一个不存在的东西。

补上了唯一一条建表入口：

```bash
npm run db:init        # 等价于 zviewer-server --init-db
```

它做四件事，顺序不能换：

1. `db.OpenForInit` 打开（不存在则创建）库文件，**跳过 VerifySchema**——此时库里还没有表，
   走正常 `Open` 必然失败；
2. `db.InitSchema` 执行 `internal/db/schema.sql`（16 张表，从线上库逐字导出，`go:embed` 内嵌）。
   **库里有任何一张表就拒绝**，避免在半初始化的库上盖结构；
3. `db.EnsureIndexes` 补三条索引；
4. `db.SeedAdmin` 在 user 表为空时建 `root`，初始密码固定为 `root`，仅以 bcrypt 哈希存入数据库；已有账号密码不变。命令行显示登录信息，桌面壳仅在本机窗口提示，不将明文密码写入运行日志。登录后沿用 `mustChangePassword` 提示修改初始密码。
   这一步不可省：注册接口永远只创建 `role=user / status=pending` 的角色（审批模式默认开启），
   新库没有任何人能审批——自举路径只能在这里。

最后再跑一次 `VerifySchema` 自检，把 `schema.sql` 与校验口径钉在一起（`init_test.go` 里也有
同样的断言，任何一方改动对不上就会红）。

实测：空目录 → `npm run db:init` → 输出 16 张表 + root 密码 → 起服务 → `/health` 200 →
用该密码 `POST /api/auth/login` 拿到 accessToken。整条链路可走通。

顺带清掉的东西：

- 根目录孤立的 `go.mod`（`module zviewer-cli`、go 1.22.5，没有任何 .go 文件引用它；
  CLI 是独立仓库且自带 go.mod）。留着会让 `go build ./...` 在根目录报「no Go files」。
- `.env.example` 里 Node 时代的段落：`NODE_ENV`（Go 不读）、「PostgreSQL 配置（可选）」
  整段（含「修改后端 data-source.ts」这种已经不存在的指引）。补了 `SQLITE_WAL` 与
  `db:init` 的说明。

## 十三、一起听的 NCM API：进程内实现（阶段 34）

`internal/ncm` **不实现**网易云协议：`/api/music/ncm/*` 一律转发到
`NCM_API_BASE`，路径方言沿用 NeteaseCloudMusicApi。这意味着「换掉 Node」不需要
动这一层——只要在同一个 HTTP 边界换上游实现，凭证注入、cookie 落库、音质降级链、
直链缓存、音频 Range 代理全部原样复用，前端 44 处调用一处都不改。

阶段 34 新增 `internal/ncmapi`：把那个 npm 包的协议翻译成 Go，在进程内提供同方言
的 HTTP 服务。**默认交付形态里不再有 Node 运行时。**

### 13.1 三种来源与优先级

| 优先级 | 触发条件 | 上游 |
|---|---|---|
| 1 | 显式 `NCM_API_BASE` | 该地址，不启动任何内置组件 |
| 2 | 默认 | `internal/ncmapi`，基地址是哨兵 `http://ncm.internal`（进程内直连，不监听端口） |
| 3 | `NCM_LOOPBACK=1` | 同一份实现改挂回环 TCP 随机端口，只为能用 curl 看原始响应 |
| 4 | `NCM_UPSTREAM=node` | 随包 `ncm/` 里的 Node 组件（历史路径，保留回退） |

**为什么是「HTTP 语义 + 进程内传输」而不是直接函数调用**：`internal/ncm` 依赖的
不是 HTTP 本身，而是这层方言的四项语义——状态码、`Set-Cookie` 原样回传（登录态落库
靠它）、3xx `Location` 透传（`/song/url/v1_302` 这类端点）、请求体流式透传（云盘上传
把 `r.Body` 直接转出去）。自定义 `RoundTripper` 直接 `ServeHTTP` 就能全部保留，
同时省掉内核往返和监听端口：`netstat` 里看不到音乐服务，安全软件也不会把它当成
一个本机服务。

外部服务语义完全保留——compose 的 `--profile music`、自建 NeteaseCloudMusicApi、
GUI 的随包 Node 都还能用，`NCM_API_BASE` 一设就退回原路径。

### 13.2 实现范围

- **46 条路由**：前端实际调用 44 条 + `/song/url`（音质降级回退）+ `/song/url/v1`（直链）
- **四种通道**：weapi（双层 AES-CBC + RSA 无填充）、eapi（AES-ECB + md5 摘要，
  Enhanced 版的默认通道）、linuxapi（`/song/url` 老接口）、明文 api
- **两个本地实现**：扫码二维码（`go-qrcode` 生成 PNG data URL，无需上游）、
  `/playlist/track/all`（两段式：先取歌单 trackIds 再批量 song/detail）
- **零新增网易云依赖**：只用标准库 + `skip2/go-qrcode`（后端本就在用），
  没有引入任何网易云 SDK，加密与协议全部自己实现

### 13.3 验收口径

- `internal/ncmapi` 单测 17 项：加密往返（eapi/linuxapi 可解密回原文并校验摘要）、
  44 条路径全覆盖、参数映射快照、二维码本地生成、两段式取数
- `NCM_LIVE=1 go test ./internal/ncmapi -run TestLiveUpstream`：匿名打真实上游
  12 个端点，全部返回预期 code（200 / 未登录的 301）
- 端到端（真实后端 + curl）：`banner`、`search`、`song/detail`、`lyric`、
  `song/url/v1`、`playlist/detail`、`comment/new`、`toplist`、`personalized`
  与扫码三步（unikey → qrimg → 801）全部通过
- `regression-sweep.sh` 13 个验收脚本全绿

### 13.4 已知边界（改这块之前必须知道）

- **密钥轮换是长期负债**：`presetKey`、RSA 公钥、`eapiKey` 一换这里就要跟。
  出处是 Node 版 `util/crypto.js`，两边同源，改时照抄即可。
- **没有 anonymous_token / realIP / 解灰**：Enhanced 版用匿名 token 兜底未登录
  场景、随机国内 IP 绕地域限制、unblockmusic 解灰。这里都没做，后果是海外 IP
  更容易吃到 460、未登录时部分接口权限更低。需要这些能力时指向外部服务。
- **xeapi / neapi 未实现**：Enhanced 版给 `/song/url/v1` 用 xeapi（x25519），
  这里用 weapi。实测 VIP 账号能拿到真 FLAC（798–1508 kbps，`type=flac`），
  所以没有跟进的必要；哪天 weapi 被关掉，这是第一个要补的地方。
- **`os` 必须显式注入 pc**：SDK 默认 `os=ios`，网页通道必须 `os=pc`，否则
  `personal_fm` 这类接口行为会漂（匿名只给 1 首而不是 3 首）。`profileFor()` 负责这件事。





