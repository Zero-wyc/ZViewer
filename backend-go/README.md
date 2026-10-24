# ZViewer Go 后端

Node 后端（`backend/`）的 Go 重写。当前处于**迁移进行中**：基础层与鉴权已可用，业务模块逐个接续。

## 与 Node 版的关系

两者**共用同一个数据库文件和同一份 `config/`**，不做数据迁移、不改表结构。

由此产生一条硬约束：

> **两个进程不能同时运行。** 端口都是 3333，且 Node 版用 sql.js（整库进内存 + 全量重写文件），
> 同时写会互相覆盖且不留痕迹。切换时务必停一个再起另一个。

## 快速开始

```bash
# 依赖代理（国内网络必需）
export GOPROXY=https://goproxy.cn,direct

cd backend-go
go build -o bin/zviewer-server.exe ./cmd/zviewer-server
./bin/zviewer-server.exe
```

默认监听 `:3333`，行为与 Node 版一致（读取 `<项目根>/config/dev.sqlite`）。

开发期想避开与 Node 版抢端口：

```bash
PORT=3401 ./bin/zviewer-server.exe
```

跑测试：

```bash
go test ./...
```

## 已实现（本轮）

| 能力 | 状态 | 说明 |
|---|---|---|
| 环境与路径解析 | ✅ | `PROJECT_ROOT` / `CONFIG_DIR` / `DATABASE_URL` 规则与 `paths.ts` 一致 |
| `.env` 加载 | ✅ | 不覆盖已存在的环境变量，支持三种候选路径 |
| SQLite 打开 | ✅ | `modernc.org/sqlite`（纯 Go、无 CGO），默认保持 `journal_mode=delete` |
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
| 健康检查 | ✅ | 字段与 Node 版一致（`startedAt` 为毫秒时间戳） |
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
| 房间事件契约 | ✅ | `internal/realtime` 定义事件名与载荷；实时层未迁移前用 `NoopBus` 丢弃（接口行为不变） |
| WebDAV 挂载 | ✅ | 挂载 CRUD、连接测试、目录浏览、文件解析，全部按 `id + userId + type` 限定归属 |
| WebDAV 流代理 | ✅ | `/api/webdav/proxy` 与 `/api/webdav/stream`，Range 收敛、stat(30s)/dir(60s) 缓存 |
| 直链与 HTTPS 升级 | ✅ | `/api/webdav/direct-url`，内网拒绝、AList 优先、现场活性校验防陈旧升级 |
| FTP 挂载 | ✅ | 挂载 CRUD、连接测试、目录浏览（MLSD / LIST 双格式）、SIZE/MDTM stat |
| FTP 流代理 | ✅ | `/api/ftp/proxy` 与 `/api/ftp/stream`，REST 分段 + stat(30s)/dir(60s) 缓存 |
| FTP 临时连接 | ✅ | `/api/stream/resolve-ftp` + `proxy-ftp`，凭证走服务端票据（30min 滑动续期） |

## 尚未实现

见 [MIGRATION.md](./MIGRATION.md)。当前 HTTP 端点覆盖率约 **56 / 300**。

**实时层（Socket.IO）尚未迁移**：房间的创建/进房/准入审批/成员管理/播放同步都在
那层，所以现在只有「房间列表 + 弹幕数据」能跑；`/api/*` 里凡是 REST 未覆盖的路径
仍会落到 SPA 回退。

除鉴权、代理与 B 站解析链外的所有 `/api/*` 都会落到 SPA 回退并返回 `404 接口不存在`——
迁移期这是刻意的：宁可明确失败，也不要返回半个可用但语义错误的响应。

## 目录结构

```
backend-go/
├── cmd/zviewer-server/     入口：装配依赖、监听、优雅退出
├── internal/
│   ├── config/             环境变量与数据路径
│   ├── db/                 连接、DSN、schema 守卫
│   ├── store/              既有 SQLite 表的读写（user / settings / audit / movie / room / mount / 弹幕）
│   ├── auth/               JWT、cookie、鉴权中间件
│   ├── ratelimit/          进程内固定窗口限流
│   ├── netutil/            内网判定与 URL 规范化（SSRF 唯一事实源）
│   ├── proxy/              上游媒体代理、Range 解析、影片流凭证解析与流式输出
│   ├── bilibili/           B 站解析链（wbi/playurl/pgc/resolver/弹幕/字幕/CDN）
│   ├── openlist/           AList 客户端（登录 / fs-get / 三层缓存）
│   ├── webdav/             WebDAV 客户端（PROPFIND / Range GET / stat 与目录缓存）
│   ├── ftp/                FTP/FTPS 客户端（被动模式 / REST 分段 / MLSD·LIST·DOS 解析）
│   ├── mountutil/          挂载共用：HTTPS 能力探测、直链升级、内网强制中转
│   ├── realtime/           房间事件广播契约（socket.io 未迁移前为 Noop）
│   ├── httpx/              统一 JSON 响应与错误
│   └── api/                路由与处理器
└── scripts/
    ├── compat-smoke.sh         跨语言互通冒烟
    ├── profile-smoke.sh        账号维护端点冒烟（真实库副本）
    ├── proxy-smoke.sh          代理端点冒烟（真实公网源）
    ├── bilibili-smoke.sh       B 站解析 / 弹幕 / 字幕冒烟（真库副本 + 真接口，15 用例）
    ├── bilibili-parity.sh      Node 与 Go 逐字段对拍（6 用例，差异数作为退出码）
    ├── parity-compare.js       B 站解析对拍比对器
    ├── movie-smoke.sh          影片 REST 冒烟（真库副本，14 用例）
    ├── movie-parity.sh         影片列表与 Node 逐字段对拍 + 双向密码加解密
    ├── parity-compare-movies.js 影片列表比对器
    ├── parity-node-movies.js   直接用 Node 的 TypeORM 层读写（绕开完整服务启动）
    ├── openlist-stream-smoke.sh OpenList 影片流冒烟（mock AList，9 用例）
    ├── mock-alist.js           最小 AList 模拟服务器
    ├── rooms-parity.sh         房间 REST 与 Node 逐字节对拍（28 步）
    ├── parity-node-rooms.js    Node 侧最小应用（只挂 rooms Router）
    ├── parity-rooms-run.js     房间对拍驱动器
    ├── webdav-parity.sh        WebDAV 端点与 Node 逐字节对拍（25 步）
    ├── parity-node-webdav.js   Node 侧最小应用（只挂 webdav Router）
    ├── parity-webdav-run.js    WebDAV 对拍驱动器
    ├── mock-webdav.js          最小 WebDAV 模拟服务器
    ├── ftp-parity.sh           FTP 端点与 Node 逐字节对拍（34 步 × MLSD/LIST 两种模式）
    ├── parity-node-ftp.js      Node 侧最小应用（只挂 ftp 两个 Router）
    ├── parity-ftp-run.js       FTP 对拍驱动器
    ├── mock-ftp.js             最小 FTP 模拟服务器（MLSD/LIST 双形态）
    └── lib-proc.sh             测试进程的启动/探活/回收（见下方"为什么需要它"）
```

分层原则与 Node 版一致：`api` 只做 HTTP 解析与响应，`store` 只管数据，`auth` 不感知业务。
新增模块一律按这个方向依赖，**不允许 `api` 之外的层 import `api`**。

## 关键设计决定

**为什么不用 WAL**：WAL 会改写库文件头的 journal 模式并生成 `-wal`/`-shm` 旁文件，属于持久化变更。
迁移期 Node 版可能仍会打开同一个库，保持 `delete` 模式最安全。
确认 Node 版彻底下线后，设 `SQLITE_WAL=1` 即可开启。

**为什么不自动建表**：TypeORM 的 `synchronize` 会持续比对 schema。
Go 侧"顺手补建"的 DDL 只要有一处差异（CHECK、DEFAULT、COLLATE），
下次 Node 启动就会静默重建表——那是最容易丢数据的一条路径。宁可启动失败。

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

**为什么 OpenList 要做三层缓存**：token（12h）避免每次 /stream 都登录（AList 登录有限流）；
raw_url（5min）避免每个 Range 请求都打 `/api/fs/get`（一次播放几十个 Range）；
单飞让并发进房的多个请求共用一个上游调用。少了任一层，一次正常播放就会把上游打成热点。

**为什么凭证解密失败要返回 nil 而不是空串**：调用方用 `!= nil` 判断"有没有凭证"，
空串指针会被当成"有凭证但为空"，进而覆盖挂载表里的真实密码。表现是"配了密码却提示未授权"，
而且日志里什么都看不到——排查成本极高。

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
