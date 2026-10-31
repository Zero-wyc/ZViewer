# ZViewer Go 后端

后端唯一实现（module `zviewer/backend`，Go 1.26）。历史上的 Node 后端已于 2026-10-25 删除，没有回滚路径。
数据库与 `config/` 由本进程独占。

- 迁移台账、验收口径、刻意保留的差异：[MIGRATION.md](./MIGRATION.md)
- 日常开发、构建、发布：[根目录 README 的「开发」一节](../README.md#开发)
- 并发、播放落盘、会话边界的专项检查：[AUDIT-2026-10-25.md](./AUDIT-2026-10-25.md)
- OBS 推流与浏览器后台断线：[OBS-BACKGROUND-2026-10-30.md](./OBS-BACKGROUND-2026-10-30.md)

## 快速开始

```bash
export GOPROXY=https://goproxy.cn,direct   # 国内网络必需

npm run db:init                            # 只需一次：建 16 张表，管理员 root / root
cd backend-go
go build -o bin/zviewer-server.exe ./cmd/zviewer-server
./bin/zviewer-server.exe
```

默认监听 `:3333`，读 `<项目根>/config/dev.sqlite`。日常开发用 `npm run dev`（前端 Vite + 本目录热重载），
端口被占用时 `PORT=3401`。**不要手动 `go run`**：它 fork 出真正的服务进程，父进程被 kill 后子进程会占住端口。

```bash
go test ./...
```

## 能力

HTTP 层 189 条历史路由全命中，实时事件 65 / 65，数据库 16 / 16 表可读写（口径见 MIGRATION.md）。

| 域 | 内容 |
| --- | --- |
| 账号与鉴权 | JWT(HS256) 与 Node 互认、bcrypt `$2b$` 兼容、Cookie 三态、审计日志、改密限流、头像上传 |
| 影片源 | B 站 UGC/PGC（WBI 签名、DASH 选轨、qn 降级）、弹幕（裸 deflate）、AI 字幕、苹果CMS、Kazumi 规则、ani-subs |
| 挂载 | WebDAV / FTP / OpenList / Emby / Jellyfin 的 CRUD、连接测试、目录浏览、流代理（Range 收敛 8 MiB、SSRF 拦截、凭证 AES-256-CBC） |
| 房间 | 生命周期、准入与密码、运行时状态、播放记忆、权限矩阵、成员与审批、播放控制（含延迟补偿）、字幕轨道、评论弹幕批注、一起听、WebRTC 信令、CLI 代理 |
| 实时层 | 自实现 Engine.IO v4 + Socket.IO v5（含手写 RFC 6455），与 REST 同一中间件链，握手鉴权 + 逐包校验 |
| 推流 | 进程内 RTMP 收流（3334）与 HTTP-FLV 分发（3335），`/live` 反代；可指向外部 SRS |
| 语音 | LiveKit 伴生进程托管（查找 / 下载 / 拉起 / 探活），token 与禁言踢人 |
| 一起听 | 自实现网易云 weapi / eapi 加密与 50 个接口，含扫码登录与云盘上传 |
| 服务器文件 | 12 个端点：根目录注册、浏览、10GB 流式上传、增删改、B 站下载；普通用户可播房主推的本地文件 |
| 运维 | 流量采样（三平台）、客户端日志、热备份（VACUUM INTO）、自签与 ACME 证书、更新器 |

不在范围内：Redis 存储适配器（多实例共享播放状态，单实例用不到）。

## 目录结构

```
backend-go/
├── cmd/zviewer-server/     入口：装配依赖、监听、优雅退出
├── internal/
│   ├── api/                路由与处理器（唯一 HTTP 层）
│   ├── auth/               JWT、cookie、鉴权中间件
│   ├── store/              SQLite 表读写
│   ├── db/                 连接、schema 守卫、索引、热备份
│   ├── realtime/           房间事件广播契约 + SocketHub
│   ├── room/               房间业务（65 事件）
│   ├── sio/                Socket.IO 协议层
│   ├── bilibili/ anime/ anisubs/ cms/ kazumi/    内容源解析
│   ├── danmaku/ subtitle/  弹幕与字幕（四源搜索、Emby 内嵌轨道）
│   ├── webdav/ ftp/ openlist/ emby/ mountutil/   挂载客户端
│   ├── nms/ proxy/         媒体服务与上游代理
│   ├── ncm/                网易云音乐
│   ├── livekit/ voice/     语音
│   ├── serverfiles/        服务器文件域
│   ├── ssl/ updater/ traffic/ clientlog/         运维
│   ├── config/ httpx/ netutil/ ratelimit/ ttlcache/ webfetch/   基础设施
└── scripts/                13 个冒烟 / 回归脚本 + 审计工具（见根目录 README 的命令表）
```

分层：`api` 只做 HTTP 解析与响应，`store` 只管数据，`auth` 不感知业务。**`api` 之外的层不得 import `api`**。

## 改动前必须知道的几点

| 约束 | 原因 |
| --- | --- |
| 启动不建表、不加列，对不上就拒绝服务 | 自动 DDL 只要有一处差异（CHECK / DEFAULT / COLLATE）就会让老库与新库静默分叉 |
| 备份只能走 `--backup-db`（VACUUM INTO） | WAL 模式下最近事务在 `-wal` 旁文件，`cp` 主文件会静默丢数据 |
| 开放式 Range（`bytes=0-`）收敛到 8 MiB，显式 Range 原样透传 | 前者防浏览器探测拉全文件，后者防 dash.js 的 4K 分片被截断 |
| 播放事件转发用 `json.RawMessage` | 反序列化再序列化会补出 `hostSocketId` 等字段，前端拿到的 state 形状就变了 |
| `watch-together-control` 补偿后调 `setPlayback` 不传 `clientTs` | 传了就是同一段 RTT 补两次，进度多走最多 1.5s |
| WS 升级用 `http.NewResponseController(w).Hijack()` | 访问日志包装的 `statusRecorder` 不实现 `Hijacker` |
| 弹幕接口自己解裸 deflate | B 站无条件返回 `Content-Encoding: deflate`，Go 只自动解 gzip |
| 凭证解密失败返回 nil，不返回空串 | 调用方用 `!= nil` 判断有无凭证，空串会覆盖挂载表的真实密码 |

更多细节写在对应包注释与 `MIGRATION.md` 第七之二。
