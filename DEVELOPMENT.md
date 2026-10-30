# 开发指南

面向改这个仓库代码的人。安装与部署看 [README.md](README.md) / [DEPLOYMENT.md](DEPLOYMENT.md)，桌面壳看 [desktop/README.md](desktop/README.md)。

## 1. 结构

- **两个 Go 模块，根目录没有模块**：`backend-go/`（`zviewer/backend`）与 `desktop/`（`zviewer/desktop`），独立编译，不共享 internal 包。
- 前端 SPA 生产时由 Go 托管；开发时 Vite 跑 5174 并把 `/api`、`/socket.io`、`/live` 反代到 3333。
- 语音是内嵌的 LiveKit 伴生进程，推流与一起听都在后端进程内（不依赖外部服务）。

## 2. 环境要求

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Go | **1.26+** | 桌面壳要求 1.25+ |
| Node.js | **22+** | 前端单测用了 `--experimental-strip-types` |
| npm | 10+ | 用 workspaces |
| Git Bash | 任意 | Windows 下 `backend-go/scripts/*.sh` 需要 bash |

可选：OBS（调推流）、`sqlite3` CLI、WebView2（开发桌面壳时才要）。

## 3. 仓库结构

| 路径 | 内容 |
| --- | --- |
| `frontend/` | React 18 + Vite SPA，别名 `@/` → `src/` |
| `backend-go/internal/api` | HTTP 层；`internal/<域>` 业务；`internal/store` SQL |
| `backend-go/internal/db` | 打开、结构校验、索引、DDL、备份（改要慎重） |
| `backend-go/scripts` | 13 个冒烟 / 回归脚本 |
| `backend-go/testdata/contract` | 端点与事件契约快照（189 端点 / 65 事件） |
| `desktop/` | Wails 桌面壳，`controller/` 管进程与证书 |
| `scripts/` | 热重载、产物编译、启动器 |
| `config/` | **不入库**：数据库、证书、上传、推流切片 |

`config/` 在 `.gitignore` 里，新克隆的仓库没有数据库，必须跑 `db:init`。

## 4. 首次搭建

```bash
git clone <repo> && cd ZViewer
npm install
cp .env.example .env      # 按需改端口与密钥
npm run db:init           # 建 16 张表 + 索引，打印初始管理员 root / root
npm run dev               # 打开 http://localhost:5174
```

登录后先改密码。已有数据的机器不用 `db:init`，整份拷 `config/` 即可（`db:init` 对非空库会拒绝）。

`.env` 常改的只有 `PORT`、`HOST`、`CORS_ORIGIN`、`JWT_*_SECRET`，完整清单见 [DEPLOYMENT.md](DEPLOYMENT.md)。
`JWT_*_SECRET` 不填时用 `config/jwt-secrets.json` 的随机值，改密钥会让所有已签发 token 失效。

## 5. 日常开发

```bash
npm run dev              # 前后端一起
npm run dev:backend      # 只起后端（保存即重启，编译成功才换进程）
npm run dev:backend:once # 编译运行一次
npm run dev:frontend     # 只起前端
```

后端换端口用 `PORT`，前端指过去用 `VITE_API_TARGET=http://localhost:<port>`。

| 端口 | 用途 |
| --- | --- |
| 3333 | 后端 HTTP/HTTPS（生产也托管前端） |
| 5174 | Vite dev server |
| 3334 / 3335 | RTMP 推流 / HTTP-FLV 拉流（进程内，经 `/live` 反代） |
| 3336 / 3337 / 3338 | LiveKit 信令 / ICE-TCP / TURN-TLS |

两个实例并存时，第二个会因 3334/3335 被占用而自动降级（日志 `内置媒体服务启动失败…降级`，该实例不能推流）。
需要两边都推流就改 `RTMP_PORT=4334 HTTP_FLV_PORT=4335 PORT=4333`。

日志打 stdout，前缀是模块名（`[db]`、`[voice]`、`[req]`、`[livekit]`、`[ncm]`）。语音起不来先看 `[livekit]`。

## 6. 构建

```bash
npm run build           # 后端 → dist/zviewer-backend(.exe)，前端 → dist/
npm run build:backend   # 只编后端
npm run build:frontend  # 只编前端
npm run build:all       # 交互式选平台，产出 dist/win 或 dist/linux
npm run build:exe       # 只出可执行文件
```

桌面壳（Windows）：

```bash
cd desktop
npm run shell:build     # 输出 build/bin/（加 --console 看日志）
npm run shell:dist      # 输出 dist-gui/
npm run package         # 出 ZIP + SHA256
```

> 别直接 `cd desktop && go build -tags production .`，那会覆盖已入库的 `desktop/desktop.exe`。

### 6.1 可选组件（ZviewerRelease 的 components 分支）

桌面端**不随包**带 cloudflared、EasyTier 与 frpc，三者放在产物仓库 `Zero-wyc/ZviewerRelease` 的 **`components` 分支**，
GUI 第一次用到时下载（`desktop/controller/components.go`）。地址形如
`https://api.gitcode.com/api/v5/repos/Zero-wyc/ZviewerRelease/raw/<文件>?ref=components`。

- **不要放回 `main`**：`main` 每次发版都被孤儿提交整体替换，组件会被清掉。
- **不要用 `raw.gitcode.com/.../raw/<branch>/<path>`**：那是预览通道，exe / zip 一律 403。
- 升级组件：`desktop/scripts/fetch-components.ps1` 拉到 `desktop/.components/` → 覆盖到 `components` 分支并更新
  `components.json` → 改 `components.go` 的 `Version` / `Size` → `cd desktop && go test ./controller -run Component`。
- 打包不再下载任何第三方二进制；FRP（Apache-2.0）与 EasyTier（LGPL-3.0）的许可证副本在
  `desktop/assets/LICENSE-FRP.txt` 与 `LICENSE-EasyTier.txt`。

### 6.2 发版

`.github/workflows/build.yml` 不跟随 main 自动构建：手动触发时填 `vX.Y.Z` 才出正式版（自动建 tag + GitHub Release），
留空只出测试版（`latest` 预发布）。正式版走四个 job：

```
prepare → build / build-gui → release（GitHub Release）
                            → publish-branch（产物仓库：GitHub + GitCode）
                            → sync-gitcode（代码与 tag → GitCode 主仓库）
```

`publish-branch` 把三个包 + `latest.json` + `README.md` 用孤儿提交整体替换 [`ZviewerRelease`](https://github.com/Zero-wyc/ZviewerRelease) 的
`main`，再推一次 GitCode（客户端读那边）。`sync-gitcode` 把本次提交与 tag 推到 GitCode 的 `ZViewer`。

补发（不重新构建）：`Actions → 补发产物仓库` → 填原 `run_id` + `tag` + `version`。代码或 tag 丢了就手动跑
`Actions → Sync to GitCode`（脚本幂等，重复执行不会产生多余提交）。

一次性配置：

| 位置 | 名称 | 用途 |
| --- | --- | --- |
| Settings → Secrets | `RELEASE_REPO_TOKEN` | 对 `ZviewerRelease` 有 `contents:write` 的 PAT（跨仓库 `GITHUB_TOKEN` 无效） |
| Settings → Secrets | `GITCODE_TOKEN` | GitCode 令牌，需对 `ZViewer` 与 `ZviewerRelease` 有写权限 |

没配 `RELEASE_REPO_TOKEN` 只跳过产物仓库；没配 `GITCODE_TOKEN` 国内用户会一直看到旧版本，要当故障处理。

排查：

- 先看日志 `== 产物目录`：脚本 `ls -la` + 递归列出所有压缩包，按名字找、找不到递归 3 层兜底。
- 推完 GitCode 会回读清单并抽查包的 HTTP 状态与总字节，日志形如 `HTTP 206 总字节 …/期望 …`，不是这个形状就是没落地。
- 报「是镜像仓（只读）」：GitCode 的 Pull 镜像仓拒绝写入（`CH.00905403`），要去 **项目设置 → 仓库镜像** 关掉 Pull 镜像。
  GitCode 没开放「立刻同步」接口（`mirror/pull` 等路由实测 404），不关就只按平台节奏追上。
- Docker 镜像不在同步范围。

### 6.3 更新源开关

网页端（设置 → 版本更新）与桌面 GUI（检查更新弹窗）都有「使用镜像更新源」，默认开启，关掉回 GitHub Release。

| 端 | 实现 | 偏好 |
| --- | --- | --- |
| 网页端 | `internal/updater/source.go` | `config/update-source.json` |
| 桌面 GUI | `desktop/controller/update.go` | `settings.json` 的 `updateGitCode` |

- 清单与安装包都走 `https://api.gitcode.com/api/v5/repos/Zero-wyc/ZviewerRelease/raw/<文件>?ref=main`，境内直连。
  其它通道实测不可用：`raw.gitcode.com` 被 CloudWAF 拦（418）、`gitcode.com/raw` 返回 SPA 页面、`gitee.com` 大文件 403、`contents` 接口返回 base64。
- 清单里每个 asset 都带 `url`，客户端优先用它，缺失才按镜像前缀拼——换通道只改 CI。
- 偏好不写数据库（`system_settings` 加列会让存量库 SELECT 失败）。
- 运维兜底 `ZVIEWER_UPDATE_SOURCE=github|gitcode|mirror` 优先于偏好文件。
- **不做自动回退**：选镜像就只走镜像，失败直接报错并提示去关开关。
- 字段名 `useGitCode` / `updateGitCode` 是历史命名，改了会让存量偏好失效。

## 7. 质量门禁

```bash
npm run lint:go                       # gofmt -l + go vet
npm run test:go                       # go test ./...
cd frontend && node ../node_modules/typescript/bin/tsc
npm run lint                          # eslint，要求 0 error 0 warning
npm test -w frontend
npm run test:regression               # 全量回归，约 1 分 45 秒
```

回归脚本各自覆盖一块：`route-parity`（189 端点契约）、`events-parity`（65 事件）、`profile-smoke`、`movie-smoke`、
`proxy-smoke`、`openlist-stream-smoke`、`bilibili-smoke`、`compat-smoke`、`https-smoke`、`desktop-env-smoke`、
`frontend-smoke`（真浏览器）、`soak`、`spike-sio`。单独跑某一个：`bash backend-go/scripts/profile-smoke.sh`。
它们都用库副本，不动 `config/dev.sqlite`。

## 8. 数据库

三条铁律：

1. **启动时绝不建表、绝不加列**。`VerifySchema` 缺表或 `user` 表缺关键列直接退出。
2. **结构唯一事实源是 `internal/db/schema.sql`**，只被 `--init-db` 使用。
3. **备份不能用 `cp`**：WAL 模式下最近事务在 `-wal` 旁文件里，单拷主文件会静默丢数据。

```bash
npm run db:backup -- ../config/db-backups/zviewer-20261025.sqlite   # 内部 VACUUM INTO
```

路径相对 `backend-go/`；Windows 下 npm 脚本由 cmd 执行，`$(date)` 不可用。

加字段至少改四处：`schema.sql` 加列 → `internal/store/xxx.go` 的 `columns` 常量 + `scanXxx` + `INSERT/UPDATE` →
老库迁移语句（没有迁移框架）→ 跑回归。`VerifySchema` 只抽查 `user` 表，别的表加列不会失败，这正是容易漏的地方。

索引写在 `internal/db/indexes.go`（启动时 `CREATE INDEX IF NOT EXISTS` 幂等补建），别写进 `schema.sql`（那样只有新库有）。

## 9. 代码约定

**后端**

- 分层 `internal/api` → `internal/<域>` → `internal/store`，服务层不得 import `internal/api`。
- 响应一律走 `httpx.OK` / `Fail` / `FailWithCode`；前端按 `success` 字段分支，形状变了等于接口变了。
- 表名列名是带引号的 camelCase（`"roomId"`），照抄现有写法。
- 时间比较统一 `datetime('now')`，别在 Go 里格式化再拼 SQL。

**前端**

- 一律用 `@/` 别名，不跨层相对路径。
- UI 组件走 `@/components/ui`，弹窗用 `ui/Modal`，剪贴板用 `hooks/useCopyToClipboard`，时长用 `formatDuration(Ms)`。
- `components/` 不允许依赖 `modules/room`。

**不要做**：引入 ORM / 查询构建器、在启动路径加自动 DDL、`git push`（本地提交即可）。

## 10. 排错

| 现象 | 处理 |
| --- | --- |
| 启动报「数据库不存在」/「缺少 N 张表」 | 没跑 `db:init`，或 `CONFIG_DIR` / `DATABASE_URL` 指错 |
| 端口被占用 | `netstat -ano \| grep :3333` 找 PID；热重载会自己杀旧进程，`go run` 起的不会 |
| 目录多出 `dev.sqlite-wal` / `-shm` | WAL 正常现象，别手删；要退回旧模式设 `SQLITE_WAL=0` |
| 语音进不去 | 看 `[livekit]` 日志；`backend-go/dev-bin/livekit-server.exe` 缺失会导致伴生进程起不来 |
| 登录后立刻掉线 | 明文 HTTP 下不写 cookie，前端改走 localStorage + `Authorization`；用 HTTPS 排查 |
| 前端 401 但 curl 正常 | 没带 token，curl 复现时加 `-H "Authorization: Bearer ..."` |
| `gofmt -l .` 有输出 | `gofmt -w <file>`，CI 会拦 |

## 11. 提交约定

- 提交信息中文、一行，前缀 `feat:` / `fix:` / `refactor:` / `perf:` / `docs:`。
- 只本地提交，不 push。
- 提交前至少跑 `npm run lint:go` + `npm run test:go`；动前端加 `tsc` + `npm run lint`；动后端行为加 `npm run test:regression`。
