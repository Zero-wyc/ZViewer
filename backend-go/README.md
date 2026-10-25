# ZViewer Go 后端

ZViewer 后端的**唯一实现**（module `zviewer/backend`，Go 1.26）。历史上的 Node 后端
（`backend/`）已于 2026-10-25 物理删除——没有第二份实现，也没有回滚路径。

数据库与 `config/` 由本进程独占。`testdata/contract/{routes,events}.json` 是删除前冻结的
端点/事件契约快照，`scripts/route-parity.sh --fixture` 与 `scripts/events-parity.sh`
靠它继续保证「历史端点与事件一个都没丢」。

迁移台账（阶段、验收口径、刻意保留的差异、外部依赖）在 [MIGRATION.md](./MIGRATION.md)；
日常开发、构建、排错入口在仓库根目录的 `DEVELOPMENT.md`。

Go 重构后的并发、播放落盘与会话边界专项检查见 [2026-10-25 检查与修复记录](./AUDIT-2026-10-25.md)。

## 快速开始

```bash
# 依赖代理（国内网络必需）
export GOPROXY=https://goproxy.cn,direct

cd backend-go
go build -o bin/zviewer-server.exe ./cmd/zviewer-server
./bin/zviewer-server.exe
```

首次运行前先建库（只需要一次）：`npm run db:init`（即 `--init-db`，建 16 张表并打印
初始管理员登录信息，默认账号和密码为 `root` / `root`）。登录后请修改初始密码；已有账号不会被重置。默认监听 `:3333`，读取 `<项目根>/config/dev.sqlite`。

日常开发用 `npm run dev`（前端 Vite + 本目录热重载）；端口被占时用 `PORT=3401`。
**不要手动 `go run`**：它 fork 出真正的服务进程，父进程被 kill 后子进程会占住端口。

跑测试：

```bash
go test ./...
```

## 能力清单

| 能力 | 状态 | 说明 |
|---|---|---|
| 环境与路径解析 | ✅ | `PROJECT_ROOT` / `CONFIG_DIR` / `DATABASE_URL` 规则与 `paths.ts` 一致 |
| `.env` 加载 | ✅ | 不覆盖已存在的环境变量，支持三种候选路径 |
| SQLite 打开 | ✅ | `modernc.org/sqlite`（纯 Go、无 CGO），**默认 WAL**（`SQLITE_WAL=0` 退回 delete） |
| Schema 守卫 | ✅ | 校验 16 张表与 `user` 关键列，不符即拒绝启动（不自行建表） |
| JWT 签发/校验 | ✅ | HS256，密钥复用 `config/jwt-secrets.json` |
| 跨语言互通 | ✅ | Node 签发的 token Go 能验，反之亦然（已实测） |
| bcrypt | ✅ | 兼容 bcryptjs 的 `$2b$` 哈希（已实测） |
| Cookie 语义 | ✅ | HTTP 不写 cookie、HTTPS 按同站/跨站动态 SameSite |
| 审计日志写入 | ✅ | `login` / `login_failed` / `password_changed` / `username_changed` |
| 鉴权接口 | ✅ | login / register / guest / refresh / logout / me / registration-mode / public-settings |
| 账号维护 | ✅ | PATCH `/password`、PATCH `/username`（root）、POST/DELETE `/avatar` |
| 敏感端点限流 | ✅ | 改密每用户 1 分钟 3 次（进程内固定窗口） |
| 头像上传 | ✅ | multipart、5MB、JPG/PNG/GIF/WEBP，落盘 `<id>-<毫秒>.<ext>` 并清理旧文件 |
| 防盗链媒体代理 | ✅ | `/api/stream/{anime,anisubs,kazumi,cms}/proxy`，Range 收敛 8MiB、SSRF 拦截、通配 CORS |
| Range 与流式输出 | ✅ | 单段解析、206/416、`Content-Range`，客户端断连即停上游 |
| 健康检查 | ✅ | 字段与旧版一致（`startedAt` 为毫秒时间戳） |
| 静态资源 + SPA 回退 | ✅ | 头像强缓存 7d、`/ffmpeg/` 强缓存 1y |
| CORS | ✅ | 任意来源反射 / 关闭 / 白名单三态 |
| B 站解析（UGC） | ✅ | WBI 签名、DASH 选轨、qn 降级、MP4 直连；与 Node 逐字段对拍一致 |
| B 站解析（PGC 番剧） | ✅ | 分集列表、按 ep 切集、试看判定（`durl[0].length` 作时长） |
| `resolve-bilibili` NDJSON | ✅ | 逐行推进度，结果行含全部字段；前端可直接替换 |
| B 站弹幕 | ✅ | `/api/stream/bilibili/danmaku`（cid 或 bvid），自行解压裸 deflate |
| B 站字幕 | ✅ | `/api/stream/bilibili/ai-subtitle`，oid 带外校验 + 时长带内校验 + 一致性投票 |
| 影片库 CRUD | ✅ | 6 个 `/api/rooms/{roomId}/movies` 端点，含 order 自增、重排序、清空 |
| 影片凭证加密 | ✅ | AES-256-CBC，与 Node 的 `encryptMovieField` 逐字节互通（双向实测） |
| 房间准入 | ✅ | `canReadRoom`：root/owner 直通，其余要求房间 active + 未结束会话（游客按 guestId） |
| 挂载凭证回填 | ✅ | 按 `sourceMountId` 优先、`serverUrl` 兜底，影片自身凭证优先于挂载 |
| OpenList 影片流 | ✅ | `/api/openlist/stream`，token(12h)/raw_url(5min)/单飞三层缓存，Range 透传 |
| 房间 REST | ✅ | 列表（含在线观众/sharer 聚合）、改名、弹幕轨道 CRUD/批量替换、弹幕辅助数据 |
| 房间事件契约 | ✅ | `internal/realtime` 定义事件名与载荷，生产实现是 `SocketHub`（REST 与 socket 事件同一条广播路径） |
| WebDAV 挂载 | ✅ | 挂载 CRUD、连接测试、目录浏览、文件解析，全部按 `id + userId + type` 限定归属 |
| WebDAV 流代理 | ✅ | `/api/webdav/proxy` 与 `/api/webdav/stream`，Range 收敛、stat(30s)/dir(60s) 缓存 |
| 直链与 HTTPS 升级 | ✅ | `/api/webdav/direct-url`，内网拒绝、AList 优先、现场活性校验防陈旧升级 |
| FTP 挂载 | ✅ | 挂载 CRUD、连接测试、目录浏览（MLSD / LIST 双格式）、SIZE/MDTM stat |
| FTP 流代理 | ✅ | `/api/ftp/proxy` 与 `/api/ftp/stream`，REST 分段 + stat(30s)/dir(60s) 缓存 |
| FTP 临时连接 | ✅ | `/api/stream/resolve-ftp` + `proxy-ftp`，凭证走服务端票据（30min 滑动续期） |
| Emby / Jellyfin 挂载 | ✅ | 前缀参数化的一套 handler 注册两次：挂载 CRUD、连接测试、目录浏览、搜索 |
| Emby / Jellyfin 播放 | ✅ | `/resolve` + `/movie-source` + `/proxy` + `/stream`，多版本选择、DTS 等不兼容音轨自动转 HLS |
| Emby / Jellyfin 海报 | ✅ | `/mounts/{id}/image` 免认证，复刻 Express 弱 ETag + 304（瀑布流不重复拉图） |
| Emby 登录缓存 | ✅ | `sha256(服务器+账号+密码)` 键、24h TTL、500 上限、并发单飞；401 时先丢陈旧缓存再重登 |
| Socket.IO 协议层 | ✅ | Engine.IO v4（polling + WebSocket，自动升级）+ Socket.IO v5（事件/双向 ack/房间）；手写 RFC 6455 |
| 实时层接入 | ✅ | `/socket.io/` 挂在与 REST 同一中间件链上；握手鉴权（cookie → auth.token → query.token）+ 逐包重校验 + 到期断开 |
| 房间生命周期 | ✅ | `create-room` / `host-leave` / `close-room` / `admin-close-room`，含 8 位房间号、bcrypt 密码、旧房间收尾 |
| 房主与观众会话 | ✅ | `register-host`（重连复用会话）/ `request-join`（免审批、白名单、审批三条路径）/ `disconnect`；人数上限串行准入 |
| 房间运行时状态 | ✅ | 影片列表 / 当前影片 / 播放状态 / 字幕缓存 + 房主重连宽限定时器（10 分钟） |
| 播放记忆 | ✅ | 按 `lastUpdatedAt + isPlaying × playbackRate` 推算进度、超时长钉住；关闭房间时清理 |
| 房间设置 | ✅ | `update-room-name`（root 或 owner）/ `update-room-mode` / `update-room-settings`（密码·人数·审批）/ `p2p-mode-change`（发送者不收） |
| 成员管理 | ✅ | 审批（`approve-join` / `reject-join`）、踢人、禁言/解禁、房管任命/撤销、转交房主（事务 + 房管名单清理） |
| 权限矩阵与防篡权 | ✅ | `roomPermissionMatrix` 缺省值对齐（房管/admin 允许、user 拒绝）；房管不可操作房主/其他房管/root |
| 播放控制 | ✅ | `watch-together-state` / `request-state`（无状态时 `data:null` + 零参广播）/ `control`（play·pause·seek·rate）/ `check-status`（容差 10s）；写入带传输延迟补偿与 2s 节流落盘 |
| 房主心跳 | ✅ | `host-heartbeat` 双发（老事件 + `sync-heartbeat`）、不校验房间模式、落盘 10s 节流 |
| 影片列表（socket 侧） | ✅ | `add-movie` / `remove-movie` / `play-movie` / `request-movie-list` / `request-current-movie`，走 `canViewerPerform` 矩阵 |
| 字幕与轨道 | ✅ | `subtitle-update`（整份透传 + 缓存）/ `subtitle-request`（补发，无 ack）/ `track-change`（区分缺失与 null） |
| 观众申请与回应 | ✅ | `seek-request` / `pause-request` / `play-request` 转给在线房主（附申请者身份），`*-response` 定向回发 |
| 服务器周期心跳 | ✅ | 每 2s 遍历有播放状态的房间推 `server-heartbeat` + `sync-heartbeat(source:'server')`；房主掉线后观众端靠它继续推进；顺带每 30s 清理陈旧缓存 |
| 评论 / 弹幕 / 批注 | ✅ | `send-comment` / `comment-history` / `join-room-panel`（独立窗口，无 session）/ `send-danmaku`（落实时日志 + meta 广播）/ `annotation-stroke` / `clear-annotations`（零参事件） |
| 一起听（listen-together） | ✅ | 队列 CRUD（含 `afterCurrent` 插入与 order 压实）/ `sync-state` / `host-heartbeat` / `check-status` / `get-state` / 观众申请制控制；播放基线走「写侧补偿 + 2s 服务器心跳」 |
| WebRTC 信令 | ✅ | `signal-offer` / `signal-answer` / `signal-ice-candidate` 同房间中继；`viewer-ready` / `sharer-ready` / `sharer-error` |
| CLI 代理 / 预览源 / 子模式 | ✅ | `cli-register` / `cli-list-agents`（+ 断线全局广播）/ `play-preview-source` / `update-share-method` / `query-stream-push-availability` |
| 实时事件（业务） | ✅ | **65 / 65 个上行事件全部接完**；仅「推流（NMS）」未迁，见 MIGRATION 3.7 |
| 服务器文件管理 | ✅ | `/api/server-files/*` 12 端点：根目录注册（`uploads:` / `custom:<id>:` 前缀协议）、浏览、系统盘符、流式上传（10GB，重名不覆盖）、新建/重命名/删除、只读根保护、B 站下载（NDJSON 四阶段） |
| 服务器文件播放 | ✅ | `/api/server-files/resolve` + `/proxy`（GET/HEAD/Range/206/416），**普通登录用户即可**——观众要能播房主推的本地视频 |
| 直链解析缓存 | ✅ | `/api/direct-resolve/movie`：TTL 缓存 + 并发单飞，key 不含 userId（同源文件跨影片共享） |
| 流量统计 | ✅ | `/api/stats/traffic`：Windows/Linux/macOS 三平台采样，取不到时回 501 而非 0 |
| 客户端日志 | ✅ | `/api/client-logs`：不鉴权（游客报错最需要收集）、4MB 上限、异步落盘即返 204 |
| CLI 本地解析代理 | ✅ | `/api/cli/resolve`：调用方是用户本机 CLI，B 站 Cookie 原样透传，跳过 CDN 检查 |
| 管理端用户 | ✅ | 列表（7 列 DTO，不含 passwordHash）/ 改角色（吊销令牌）/ 审核（guest→user）/ 删除 |
| 管理端房间 | ✅ | 列表（含 closed + 在线人数批量聚合）/ 物理删除（级联 7 张关联表）/ 重开（清权限缓存）/ 批量删 / 全删 / 清理无人 |
| 管理端设置 | ✅ | 18 个字段逐项校验（枚举·范围·矩阵结构·ws 前缀），全部通过才整行保存 |
| 字幕搜索与加载 | ✅ | `/api/subtitles/*` 5 端点：四源（server-files / ftp / openlist / webdav）同目录同名搜索、目录浏览、按路径读内容 |
| Emby 内嵌字幕 | ✅ | 读 PlaybackInfo 的 `MediaStreams` 列轨道，按轨道 index 调 Emby 转封装接口取内容；`index=1.5` 必须查不到（数字相等而非截断） |

## 剩余边界

迁移已收尾：HTTP **182 组端点 / 189 条历史路由全命中**、实时事件 **65 / 65**、
数据库 **16 / 16** 表可读写，口径见 [MIGRATION.md](./MIGRATION.md)（第一节 + 第十节实测）。

真正不属于「Go 重写范围」的只剩三处，且都不影响主链路：

- **NCM 音乐 API 是外部服务**：`/api/music/ncm/*` 只做转发，`NCM_API_BASE` 指向
  外部网易云 API（`docker compose --profile music` 可一并拉起）。
  不可达时音乐接口返回 503 `NCM_UNAVAILABLE`，其余功能不受影响。
- **Redis 存储适配器**（多实例共享播放状态）未迁——单实例部署用不到。
- 媒体服务（RTMP/HTTP-FLV）**已内嵌**（`internal/nms`）：RTMP 收流 3334、
  HTTP-FLV 出流 3335，`/live` 反代到本地这个端口；`NMS_HTTP_FLV_URL` 可指向外部
  SRS/node-media-server，此时不再内嵌。

刻意与旧实现不同的地方（都是修缺陷，不是没迁完）见 MIGRATION 第七之二。

## 目录结构

```
backend-go/
├── cmd/zviewer-server/     入口：装配依赖、监听、优雅退出
├── internal/
│   ├── anime/           动漫源：B 站番剧 + 第三方 URL 模板（encodeURIComponent 等价编码）
│   ├── anisubs/         ani-subs 订阅源：regexp2 规则（负向先行断言）+ 抓站
│   ├── api/             路由与处理器（唯一的 HTTP 层）
│   ├── auth/            JWT、cookie、鉴权中间件
│   ├── bilibili/        B 站解析链（wbi/playurl/pgc/resolver/弹幕/字幕/CDN/账号与浏览）
│   ├── clientlog/       客户端日志落盘（一次 Open 写完一批，不并发抢文件）
│   ├── cms/             苹果CMS / TVBox 采集源（配置 10min 缓存 + 播放地址解析）
│   ├── config/          环境变量与数据路径
│   ├── danmaku/         多源弹幕（B 站 / 弹弹play / 本地）；danmaku/chinese 为简繁词典与转换
│   ├── db/              连接、DSN、schema 守卫、索引与热备份
│   ├── emby/            Emby/Jellyfin 客户端（登录缓存单飞 / 多版本选择 / 版本标签）
│   ├── ftp/             FTP/FTPS 客户端（被动模式 / REST 分段 / MLSD·LIST·DOS 解析）
│   ├── httpx/           统一 JSON 响应与错误
│   ├── kazumi/          Kazumi JSON 规则引擎（受限 JSONPath + @var 模板 + 章节解析）
│   ├── livekit/         LiveKit 伴生进程托管（查找 / 下载 / 拉起 / 探活）
│   ├── mountutil/       挂载共用：HTTPS 能力探测、直链升级、内网强制中转
│   ├── ncm/             网易云音乐转发（外部 NCM_API_BASE + 登录态 / 扫码 / 直链域名白名单）
│   ├── netutil/         内网判定与 URL 规范化（SSRF 唯一事实源）、encodeURIComponent 唯一实现
│   ├── nms/             内置媒体服务：RTMP 收流 + HTTP-FLV 分发（AMF0 / chunk 重组 / GOP 缓存 / 流注册）
│   ├── openlist/        AList 客户端（登录 / fs-get / 三层缓存）
│   ├── proxy/           上游媒体代理、Range 解析、影片流凭证解析、/live 专用反代
│   ├── ratelimit/       进程内固定窗口限流
│   ├── realtime/        房间事件广播契约 + SocketHub（`*sio.Server` 适配器）
│   ├── room/            房间业务：生命周期、准入、运行时状态、播放记忆、权限、设置与成员、播放控制、字幕轨道、评论弹幕批注、一起听、WebRTC 信令、CLI 代理（65 事件）
│   ├── serverfiles/     服务器文件域：前缀路径协议、越权拦截、流式上传、直链下载、中文排序（汉字优先）
│   ├── sio/             Socket.IO 协议层（Engine.IO v4 双传输 / Socket.IO v5 编解码 / RFC 6455）
│   ├── ssl/             证书：自签 + ACME（RFC 8555）+ `--gen-cert` CLI
│   ├── store/           SQLite 表读写（user / movie / room / session / mount / 弹幕 / 评论 / 音乐 / 凭证）
│   ├── subtitle/        字幕域：四源同名搜索 / 目录浏览 / 内容加载 / Emby 内嵌轨道
│   ├── traffic/         网络流量采样（Windows netstat / Linux /proc/net/dev / macOS netstat）
│   ├── ttlcache/        TTL 缓存 + 单飞 + 容量淘汰（cms / anisubs / kazumi 共用）
│   ├── updater/         更新器（检查 / 下载 / 校验 / 解压 / 生成脚本）
│   ├── voice/           语音：LiveKit token 与成员管理（禁言 / 踢人）
│   ├── webdav/          WebDAV 客户端（PROPFIND / Range GET / stat 与目录缓存）
│   └── webfetch/        抓站共用：charset 嗅探、剥 Accept-Encoding、CF 判定、GitHub 加速改写
└── scripts/
    ├── bilibili-smoke.sh          B 站解析 / 弹幕 / 字幕冒烟（真库副本 + 真接口，15 用例）
    ├── compat-smoke.sh            跨语言互通冒烟（token / bcrypt / 配置 / 证书）
    ├── desktop-env-smoke.sh       桌面托管环境冒烟（ZVIEWER_DESKTOP=1 / 端口注入）
    ├── event-audit.js             事件覆盖审计（--snapshot 冻结 / --fixture 复用快照）
    ├── events-parity.sh           65 个上游事件逐条探测是否落到实现
    ├── frontend-smoke.js          浏览器断言脚本（由 frontend-smoke.sh 调用）
    ├── frontend-smoke.sh          前端全链路冒烟（Chromium，12 项）
    ├── gen-opencc-data.js         从 opencc-js 导出简繁词典（danmaku/chinese 用）
    ├── https-smoke.sh             HTTPS / ACME / 自签证书冒烟（19 项，openssl 复核）
    ├── lib-proc.sh                测试进程的启动/探活/回收（随机端口 + WINPID 树强杀）
    ├── mock-alist.js              最小 AList 模拟服务器
    ├── movie-smoke.sh             影片 REST 冒烟（真库副本，14 用例）
    ├── openlist-stream-smoke.sh   OpenList 影片流冒烟（mock AList，9 用例）
    ├── profile-smoke.sh           账号维护端点冒烟（真实库副本）
    ├── proxy-smoke.sh             代理端点冒烟（真实公网源）
    ├── regression-sweep.sh        全量回归：串行跑完其余脚本，失败即停
    ├── route-audit.js             路由覆盖审计（静态预检 / --snapshot 冻结清单）
    ├── route-parity.sh            189 条历史路由逐条探测（--fixture 不依赖 Node）
    ├── soak-driver.js             soak 压测驱动器
    ├── soak.sh                    并发压测（默认 60s 压缩版，SOAK_SECONDS=86400 真机）
    ├── spike-sio.js               socket.io-client 驱动的协议层验证器
    └── spike-sio.sh               Socket.IO 协议层验证（cmd/sio-spike + 真实客户端，17 项）
```

分层原则沿用旧版：`api` 只做 HTTP 解析与响应，`store` 只管数据，`auth` 不感知业务。
新增模块一律按这个方向依赖，**不允许 `api` 之外的层 import `api`**。

## 关键设计决定

**为什么默认 WAL**：Node 下线后不再有第二个进程按 `delete` 模式打开同一个库，
WAL 的读不阻塞写、崩溃只需重放 `-wal` 的收益就能拿到。代价是多两个旁文件
（`-wal` / `-shm`），所以**备份必须走 `--backup-db`（VACUUM INTO），不能直接复制 .sqlite**。

**为什么不自动建表**：结构唯一事实源是 `internal/db/schema.sql`，启动时对不上就拒绝服务。
"顺手补建"的 DDL 只要有一处差异（CHECK、DEFAULT、COLLATE），老库与新库就会静默分叉，
是最容易丢数据的一条路径。唯一允许的自动 DDL 是幂等的 `db.EnsureIndexes`；
建表只有一个入口：`npm run db:init`。

**为什么开放式 Range 要截断、显式 Range 不截断**：浏览器 `<video>` 的探测请求是
`bytes=0-`（开放式），直接透传会让上游把整个文件推过来，而播放器拿到元数据就断开，
已传部分全部作废——这是代理场景最大的无效流量来源，所以收敛到 8 MiB 分片。
但 `bytes=start-end`（显式）必须原样透传：dash.js 的虚拟 MPD 按单个完整 segment
发起显式 Range，4K 下单个 m4s 常有 8–15 MB，截断会让它拿到不完整 fragment、
反复重试，表现为"只有 4K 卡顿、1080P 正常"。这两条规则在 `ClampRangeHeader`
的注释里也写了，改动前请先读。

**为什么影片时间列按 UTC 解释、tokenInvalidBefore 却要带 Z**：两者走的是不同路径。
`tokenInvalidBefore` 是代码手写的字符串交给 TypeORM，它按 `new Date(str)` 语义处理，
无时区标记时 JS 取本地时区；而 `movie.createdAt` 是 sql.js 驱动从 DATE 列解出来的
`Date` 对象，已经是 UTC 解释好的。曾按前者类推给影片时间加了 +8h，对拍立刻差 8 小时——
**这类跨实现的语义只能实测，读一两个函数推断必错**。

**为什么播放事件转发的是原始 JSON 字节**：`watch-together-state` 的 `state` 字段是
客户端上报的 `SyncStateDto`，而 Go 解析用的 `Playback` 结构体多了
`hostSocketId` / `updatedAt` / `currentMovieId` 三个字段。反序列化再序列化会把它们
「顺手补出来」，前端拿到的 state 形状就与旧版不同。所以转发一律走
`json.RawMessage`，只有「写进播放记忆」那一步才解析。

**为什么延迟补偿只能做一次**：`watch-together-control` 已经按动作显式补偿过
（play 补在途推进、seek 按当前 isPlaying 决定补不补），随后调 `setPlayback` 时
必须不传 `clientTs`——传了就是同一段 RTT 被补两次，进度凭空多走最多 1.5s。
这条规则在 `transport_delay.go` 与 `playback_handlers.go` 里各写了一遍注释，
因为它属于「读代码看不出来、只在长连接上体现」的隐性约定。

**为什么对拍里周期心跳只比「形状」不比条数**：服务器心跳是 2s 定时器推的，
两侧相位必然不同，逐条比只会得到随机噪声（阶段 10 就是靠过滤这一路才稳定）。
但「过滤掉」等于放弃验证，所以改成收集心跳的**形状集合**——payload 的键、`state`
的键、`source` 的值、`hostOnline` 的类型——去重后比较。键的**存在性**正是语义
（`server-heartbeat` 有 `roomId`、`sync-heartbeat` 没有），而时刻和条数不是。
另外配两条确定性断言（等一轮心跳 / 房主断线后等 `hostOnline:false`），
因为「定时器到底有没有在跑」只能靠等，不能靠算。

**为什么清理要用「连接存活」而不是「session 里的房主」**：`playback_states.hostSocketId`
是脏数据的高发区——后端重启、房主换了设备、socket 重连都会留下失效的旧值。
按 session 判在场会把这些陈旧缓存一直留着（session 表里房主仍然是 sharer），
按连接存活判才能清掉。反过来说，**没有连接信息时按在线处理**：宁可留着，不要误删。

**为什么「评论独立窗口」不走完整进房流程**：`join-room-panel` 只往
`socket.data.panelRoomIds` 写一个标记再 `socket.join`，不建 session、不占人数位、
不走审批。它要的是「能读这个房间的评论/弹幕」，而不是「进入这个房间」——建 session
会把房间人数顶满，连带影响别人的准入。代价是「在房判定」必须多一条分支：
先看 `panelRoomIds`，命中就改判 `canReadRoom`（而不是查 session），再回落正常路径。
这条分支漏了不会报错，只会让独立窗口「发出去没有任何反应」——所以放在
`Service.IsInRoom` 里统一处理，而不是在六个 handler 里各写一遍。

**为什么对拍驱动器要记「事件参数个数」**：`clear-annotations` 在 Node 里是
`io.to(room).emit('clear-annotations')`，零参数。Go 侧如果按常规写
`EmitRoom(roomID, event, nil)`，线上编码出来是 `["clear-annotations", null]`——
客户端的 `(...args)` 会拿到长度为 1 的数组，payload 是 `null` 而不是 `undefined`。
只比 payload 时两边看起来一样（都没内容），必须把 `argc` 一起比才能暴露。

**为什么 OpenList 要做三层缓存**：token（12h）避免每次 /stream 都登录（AList 登录有限流）；
raw_url（5min）避免每个 Range 请求都打 `/api/fs/get`（一次播放几十个 Range）；
单飞让并发进房的多个请求共用一个上游调用。少了任一层，一次正常播放就会把上游打成热点。

**为什么凭证解密失败要返回 nil 而不是空串**：调用方用 `!= nil` 判断"有没有凭证"，
空串指针会被当成"有凭证但为空"，进而覆盖挂载表里的真实密码。表现是"配了密码却提示未授权"，
而且日志里什么都看不到——排查成本极高。

**为什么 Emby 登录缓存要「单飞 + 401 丢陈旧」**：Emby 对并发 `authenticatebyname` 会限流，
浏览瀑布流时几十个请求同时进来必须共用同一次登录，否则一半请求直接 401。
但只做缓存会踩另一个坑：令牌过期后重登命中 24h 缓存，拿回来的还是同一个失效令牌，
重试必然继续 401——表现是「密码明明是对的，但令牌过期后永远连不上」。
所以 401 分支先把缓存里那条（且仅当它正是当前令牌）删掉再重登，见 `emby/client.go#dropStaleLogin`。

**为什么 Emby 的 HLS 改写要白名单 + 抹令牌**：`/proxy` 会拿上游地址去请求，
不限定「同源 + 同 `videos/{itemId}/` 前缀」就是一个开放代理，能读内网、能带令牌打任意地址；
而拆分改写时若不删掉 `api_key`/`X-Emby-Token`，整份 playlist 会把令牌发给每个观众。
非法子资源 Go 侧选择「置空该条」而非 Node 的「抛错 500」，理由见 MIGRATION「七之二」。

**为什么 Socket.IO 也要自己写**：现成的 Go 实现大多停在协议 v3/v4 早期，
对 socket.io-client 4.8 的线上格式并不保证兼容；不兼容的表现是「连上了但事件全丢」，
比连不上更难查。协议本身不大（Engine.IO 的包就是单字节前缀 + 载荷，Socket.IO 的包是
`<type><nsp,><id><json>`），真正费事的是几处反直觉的细节——比如 ack id 的 `0` 是合法值，
拿字段零值当「没有 ack id」会把 CONNECT 应答编成 `400{"sid":…}`；再比如收到 `2probe`
时必须主动给挂起的轮询补一个 `noop`，否则升级要等满 25 秒。这些都在
`internal/sio/*_test.go` 里逐条锁死了，验证则直接用仓库里那份 `socket.io-client@4.8.3`
（`scripts/spike-sio.sh`，17 项）——自己写客户端去测自己实现，等于用同一份错误理解对两遍。

**为什么 WS 升级不能用 `w.(http.Hijacker)`**：主服务为了访问日志把 `ResponseWriter`
包成了 `statusRecorder`（记录状态码与字节数）。那层包装不实现 `Hijacker`，直接断言必然失败，
而失败只体现在 socket.io-client 的 `websocket error` 里——REST 接口一切正常，
很容易误判成协议层有问题。改成 `http.NewResponseController(w).Hijack()` 后会顺着
`Unwrap()` 找到真正的写入器。这个坑是双向对拍第一次跑就撞出来的：Go 侧四个客户端全部连不上，
Node 侧 28 步全过。

**为什么每个 socket 要自动加入以自身 ID 命名的房间**：socket.io 的 `Socket` 构造函数
就是这么做的，`io.to(socket.id).emit(...)` 全靠它。少了这一步，所有「只推给某一个人」的事件
（`join-approved` / `viewer-kicked` / `moderators-changed`）都会静默发不出去，
既不报错也没有日志——排查时会先怀疑业务条件没命中。

**为什么弹幕接口要自己解 deflate**：B 站 `x/v1/dm/list.so` **无条件**返回
`Content-Encoding: deflate`（即便请求写 `Accept-Encoding: identity`），且是**裸 deflate**
（无 zlib 头）。Node 的 undici 会自己处理，Go 的 `http.Transport` 只自动解 gzip。
不解压就会把二进制当 XML 去匹配正则，结果是一条都匹配不到——接口 200、
弹幕列表为空、不报任何错。`client.go#decodeBody` 里先按裸 deflate、失败再按 zlib 兜底。

**为什么对拍脚本每轮换端口**：本机 `netstat` 看不到这些服务的监听套接字，
无法预检端口占用；而 Git Bash 里 `cmd &` 的 `$!` 是包装子进程、不是 exe 本身，
`taskkill $!` 杀不掉真正的服务。于是残留进程会占着老端口，新进程 bind 失败退出，
健康检查却被**旧进程**应答——对拍拿到上一版构建的输出，差异看起来像代码 bug
（实际踩过：Node 侧"少了 `videoCodecid`"）。现在端口随机，启动判定先查本轮日志锚点
再查健康检查，进程按 `ps -W` 的 ppid 树逐层强杀，见 `scripts/lib-proc.sh`。
