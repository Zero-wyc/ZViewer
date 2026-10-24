# 迁移清单

> 基线：`backend/src` 共 220 个 `.ts` / 42,653 行 / 约 300 个 HTTP 端点 / 16 张表。
> 本文件是执行台账：每完成一个单元就在状态列打勾，并写一句验收口径。

## 一、总体进度

| 维度 | 已完成 | 总量 | 覆盖率 |
|---|---:|---:|---:|
| 代码行 | ~21,575（含测试 3,778） | 42,653 | 50.6% |
| HTTP 端点 | 78 | ~300 | 26.0% |
| 数据库表 | 10（user / movie / room / session / user_mount / danmaku_track / room_danmaku_meta 已可读写；system_settings / audit_logs 读写齐备） | 16 | 62.5% |

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
| 字幕源（多源） | ~1,000 | `internal/subtitle` | ⏳ B站 单源已完成，其余字幕源未做 |
| LiveKit WS 隧道 + 凭证 | ~1,200 | `internal/voice` | ⏳ |

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
| 弹幕 | `danmaku.go` | XML 正则 + 五实体解码；**裸 deflate** 自行解压 |
| 字幕 | `subtitle.go` | oid 带外校验 + 时长带内校验 + 6 次采样一致性投票，未过校验一律返回空 |

**验收脚本**：

- `scripts/bilibili-smoke.sh`：真库副本 + 真 B站 接口，15 个用例（解析 / 弹幕 / 字幕）。
- `scripts/bilibili-parity.sh`：Node 与 Go 双进程**逐字段对拍**，6 个用例
  （UGC 默认 / 降清晰度 / MP4、PGC 免费集 / 会员专享集 / 切集），目前差异总数 **0**。
  比对器独立成 `scripts/parity-compare.js`，进程管理抽到 `scripts/lib-proc.sh`。

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
| Socket.IO 兼容层 | （基础，非业务） | ⏳ | **Go 侧 v4 协议需先做 spike 验证** |
| 房间 REST（列表/改名/弹幕轨道/弹幕辅助数据） | ~450 | ✅ 见 4.3（实时部分仍 ⏳） |
| 房间 / 权限 / 成员（socket.io 部分） | ~2,300 | ⏳ | |
| 影片列表 / 当前播放 | ~1,100 | ⏳ | |
| 观众端同步状态机 | ~1,800 | ⏳ | 必须走 `resolveViewerEffectiveState` |
| 评论 / 弹幕广播 | ~1,200 | ⏳ | |
| 共享播放记忆 | ~1,550 | ⏳ | |
| WebRTC 信令 | ~280 | ⏳ | |
| 推流（NMS → mediamtx/lal） | ~580 | ⏳ | 需复刻推流鉴权与 `stream-status` |

## 六、阶段 4：挂载源与系统（约 50 人日）

| 单元 | TS 行数（估） | 状态 |
|---|---:|---|
| 影片库 CRUD + 挂载流（OpenList） | ~1,500 | ✅ 见 4.1 |
| WebDAV 挂载 + 流代理 | ~800 | ✅ 见 4.2 |
| FTP 挂载 + 流代理 | ~660 | ✅ 见 4.4 |
| Emby / Jellyfin 协议仿真 | ~1,600 | ✅ 见 4.5 |
| 服务器文件浏览 | ~1,200 | ⏳ |
| 一起听音乐（含 NCM） | ~3,170 | ⏳ |
| 管理端 / 统计 / 客户端日志 | ~900 | ⏳ |
| 更新器（下载/解压/sha256） | ~1,400 | ⏳ |
| ACME / 自签证书 | ~1,020 | ⏳ |
| CLI 代理端点 | ~280 | ⏳ |

### 4.1 影片库与挂载流（已完成部分）

| 文件 | 行数 | 内容 |
|---|---:|---|
| `internal/store/movie.go` | ~640 | 影片 CRUD、order 自增、`sourceMountId` 锚定、JSON 列规范化、时间解析 |
| `internal/store/movie_crypto.go` | ~130 | 凭证列的 AES-256-CBC（与 Node 的 `encryptMovieField` 逐字节兼容） |
| `internal/store/room.go` / `mount.go` | ~190 | 房间存在性、会话准入、挂载读取（含凭证解密） |
| `internal/api/movie.go` | ~430 | 6 个影片 REST 端点 + DTO 序列化 |
| `internal/proxy/moviestream.go` | ~230 | `resolveMovieStream`（熔断 + 30s 缓存 + 凭证回退） |
| `internal/openlist/openlist.go` | ~480 | AList 客户端：token(12h) / raw_url(5min) / 单飞 |
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

验证脚本：
- `scripts/mock-emby.js`——最小 Emby（登录校验客户端标识头、`/Users/Me` 对特定账号返 500、
  缺 Path / 缺海报的条目、多版本、DTS 音轨、空 MediaSources、Range 流、带 api_key 的 m3u8、
  `POST /__invalidate` 清会话）；
- `scripts/emby-parity.sh`——**52 步**逐步骤对拍，m3u8 **按全文**比对。

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
| Socket.IO 未迁移期间，房间的**创建/进房/准入审批/在线成员**一律不可用 | `modules/room` | REST 只覆盖列表/改名/弹幕数据；把 REST 通过当成"房间可用"会导致误判进度 |
| 字幕接口失败也是 `200 + success:true + lines:[] + message` | `routes/stream/bilibili-videos.routes.ts` | 改成 4xx/5xx 会让前端当成请求失败去重试，只会继续掷骰子 |

## 七之二、刻意与 Node 不同的地方

这些是「对拍里对不上、但 Go 侧认为自己对」的点。改回去之前请先读原因——
每一条都对应一个会让用户看见的故障。

| 位置 | Node 的行为 | Go 的行为 | 为什么改 |
|---|---|---|---|
| FTP 流代理的响应体 | REST 只定起点、服务端发到文件尾，但 `Content-Length` 只声明请求区间 → 实际字节数**多于**声明，curl 报 `Excess found in a read`，部分播放器直接判定流损坏 | 按声明长度截断（`io.LimitReader`） | HTTP/1.1 要求响应体长度必须等于 `Content-Length`；多出来的字节会被当成下一个响应。对拍脚本因此只比较「声明长度内的字节」 |
| FTP `serverUrl` 的主机解析 | `serverUrl.replace(/^ftp/i, '')` 把 `ftp.example.com` 变成 `example.com` | 按 scheme 前缀或裸主机正确处理，完整保留 `ftp.example.com` | 前者是笔误级别的正则（想剥 `ftp://` 协议头），实际结果是「主机名以 ftp 开头就必然连不上」 |
| FTP 裸主机里的端口 | `host:2121` 会被整段当主机名交给 `net.connect`，端口参数被忽略 | `host:port` 形态直接采用其中的端口 | 同一个函数里既然已经从 URL 取 `hostname`，裸主机形态也该认端口 |
| Emby m3u8 里的非法子资源 | 改写回调抛错，整个请求 500（已吐出的分片作废） | 该条 URI 置空，其余条目照常输出 | 抛错会让「一个坏分片」拖垮整段播放列表；置空既不影响其余分片，也绝不把带 `api_key` 的原始地址回退给客户端 |

## 八、每个单元的完成定义（DoD）

1. `go build ./...` 与 `go vet ./...` 干净；
2. 有单元测试覆盖核心分支（尤其是错误分支）；
3. 与 Node 版对同一输入的响应**逐字段相等**（含错误文案）；
4. 涉及的库表读写不改变 schema；
5. 在 `MIGRATION.md` 的状态列打勾，并补一句验收口径。

## 九、切换检查单（阶段 5）

- [ ] 全部端点覆盖，Go 侧 `/api/*` 无 404 兜底命中
- [ ] 停 Node 进程 → 仅 Go 运行 24h 无告警
- [ ] `config/` 目录双向兼容验证：Go 写入后 Node 仍能读（回滚保障）
- [ ] 前端全链路回归（首页 / 房间 / 一起听 / 管理端）
- [ ] 桌面壳改为同进程内嵌，删除 `ZVIEWER_DESKTOP` 注入与 409 分支
- [ ] 删除 `backend/` 与 `node_modules`
