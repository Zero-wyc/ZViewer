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

## 尚未实现

见 [MIGRATION.md](./MIGRATION.md)。当前 HTTP 端点覆盖率约 **16 / 300**。

除鉴权与代理外的所有 `/api/*` 都会落到 SPA 回退并返回 `404 接口不存在`——
迁移期这是刻意的：宁可明确失败，也不要返回半个可用但语义错误的响应。

## 目录结构

```
backend-go/
├── cmd/zviewer-server/     入口：装配依赖、监听、优雅退出
├── internal/
│   ├── config/             环境变量与数据路径
│   ├── db/                 连接、DSN、schema 守卫
│   ├── store/              既有 SQLite 表的读写（user / settings / audit）
│   ├── auth/               JWT、cookie、鉴权中间件
│   ├── ratelimit/          进程内固定窗口限流
│   ├── netutil/            内网判定与 URL 规范化（SSRF 唯一事实源）
│   ├── proxy/              上游媒体代理、Range 解析与流式输出
│   ├── httpx/              统一 JSON 响应与错误
│   └── api/                路由与处理器
└── scripts/
    ├── compat-smoke.sh     跨语言互通冒烟
    ├── profile-smoke.sh    账号维护端点冒烟（真实库副本）
    └── proxy-smoke.sh      代理端点冒烟（真实公网源）
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
