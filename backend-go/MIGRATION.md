# 迁移清单

> 基线：`backend/src` 共 220 个 `.ts` / 42,653 行 / 约 300 个 HTTP 端点 / 16 张表。
> 本文件是执行台账：每完成一个单元就在状态列打勾，并写一句验收口径。

## 一、总体进度

| 维度 | 已完成 | 总量 | 覆盖率 |
|---|---:|---:|---:|
| 代码行 | ~13,400（含测试 2,820） | 42,653 | 31.4% |
| HTTP 端点 | 26 | ~300 | 8.7% |
| 数据库表 | 8（user / movie 已可写；system_settings / audit_logs / room / session / user_mount 读写齐备） | 16 | 50% |

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
| 房间 / 权限 / 成员 | ~2,300 | ⏳ | |
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
| WebDAV / FTP 流代理 | ~800 | ⏳ 读取层已就绪，缺协议客户端 |
| Emby / Jellyfin 协议仿真 | ~1,250 | ⏳ |
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
| 字幕接口失败也是 `200 + success:true + lines:[] + message` | `routes/stream/bilibili-videos.routes.ts` | 改成 4xx/5xx 会让前端当成请求失败去重试，只会继续掷骰子 |

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
