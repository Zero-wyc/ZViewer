# 开发指南

面向改这个仓库的人。安装与部署见 [README.md](README.md) / [DEPLOYMENT.md](DEPLOYMENT.md)，桌面壳见 [desktop/README.md](desktop/README.md)。

## 组成

- **两个独立 Go module，根目录没有 module**：`backend-go/`（`zviewer/backend`）与 `desktop/`（`zviewer/desktop`），各自编译，不共享 internal 包。
- 前端 SPA 生产由 Go 托管；开发时 Vite 跑 5174，把 `/api`、`/socket.io`、`/live` 反代到 3333。
- 语音是内嵌的 LiveKit 伴生进程，推流与一起听都在后端进程内，不依赖外部服务。
- `config/` 不入库（数据库、证书、上传、推流切片），新克隆必须跑 `npm run db:init`。

## 环境

| 依赖 | 版本 |
| --- | --- |
| Go | 1.26+（桌面壳 1.25+） |
| Node.js | 22+ |
| npm | 10+ |
| Git Bash | 仅 Windows，跑 `backend-go/scripts/*.sh` 用 |

可选：OBS（调推流）、`sqlite3`、WebView2（开发桌面壳）。

## 结构

| 路径 | 内容 |
| --- | --- |
| `frontend/` | React 18 + Vite SPA，别名 `@/` → `src/` |
| `backend-go/internal/api` | HTTP 层；业务在同级 `<域>` 包；SQL 在 `internal/store` |
| `backend-go/internal/db` | 打开、结构校验、索引、DDL、备份 |
| `backend-go/scripts` | 冒烟 / 回归脚本 |
| `backend-go/testdata/contract` | 端点与事件契约快照（189 端点 / 65 事件） |
| `desktop/` | Wails 桌面壳，`controller/` 管进程与证书 |
| `scripts/` | 热重载、产物编译、启动器 |

## 命令

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

后端换端口用 `PORT`，前端指过去用 `VITE_API_TARGET`。端口分工：3333 后端与网页、5174 Vite、3334/3335 RTMP 与 HTTP-FLV、3336/3337/3338 LiveKit。

回归脚本各自覆盖一块（`route-parity`、`events-parity`、`bilibili-smoke`、`frontend-smoke`、`soak` 等），都用库副本，不动 `config/dev.sqlite`。单个跑：`bash backend-go/scripts/profile-smoke.sh`。

## 数据库

1. **启动绝不建表、绝不加列**。`VerifySchema` 缺表或缺关键列直接退出。
2. **`internal/db/schema.sql` 是唯一事实源**，只被 `--init-db` 使用；索引写在 `internal/db/indexes.go`，启动时幂等补建。
3. **加字段要改四处**：`schema.sql` → store 的 `columns` + `scanXxx` + `INSERT/UPDATE` → 老库迁移语句（无迁移框架）→ 跑回归。
4. **备份不能用 `cp`**：WAL 下最近事务在 `-wal` 里，单拷主文件会静默丢数据。

## 约定

- **后端**：`internal/api` → `internal/<域>` → `internal/store` 单向依赖；响应统一走 `httpx.OK / Fail`；表列名是带引号的 camelCase；时间比较用 `datetime('now')`。
- **前端**：一律 `@/` 别名；UI 走 `@/components/ui`，弹窗用 `ui/Modal`，时长用 `formatDuration(Ms)`；`components/` 不依赖 `modules/room`。
- **不做**：ORM / 查询构建器、启动路径自动 DDL。

## 发布

`.github/workflows/build.yml` 不跟 main 自动构建：手动触发填 `vX.Y.Z` 出正式版（建 tag + Release + 推产物仓库 + 同步 GitCode），留空只出 `latest` 预发布。

| Secret | 用途 |
| --- | --- |
| `RELEASE_REPO_TOKEN` | 对 `ZviewerRelease` 有 `contents:write` 的 PAT |
| `GITCODE_TOKEN` | 对 `ZViewer` 与 `ZviewerRelease` 有写权限 |

可选组件（cloudflared、frpc、EasyTier、LiveKit）放在 `ZviewerRelease` 的 **`components` 分支**：`main` 每次发版被孤儿提交整体替换，组件会被清掉。

更新源：网页端与 GUI 都有「使用镜像更新源」开关（默认开）。清单与安装包走 GitCode raw，偏好存 `config/update-source.json` / GUI 的 `settings.json`；运维可用 `ZVIEWER_UPDATE_SOURCE=github|gitcode|mirror` 覆盖。**不做自动回退**——选镜像就只走镜像，失败直接报错提示关开关。
