# 开发指南

面向要改这个仓库代码的人。用户安装与部署看 [README.md](README.md)，后端迁移台账与验收口径看 [backend-go/MIGRATION.md](backend-go/MIGRATION.md)，桌面壳看 [desktop/README.md](desktop/README.md)。

---

## 1. 这个仓库是什么

一个服务端渲染的观影平台，运行形态是**两个进程**：

```
浏览器 ──► Go 后端 (3333) ──► SQLite (config/dev.sqlite)
                │
                ├─► 内嵌 LiveKit 伴生进程 (语音)
                └─► NMS (OBS 推流，可选)

前端 SPA 由 Go 后端直接托管（生产），开发时由 Vite 单独跑（5174）并反代 /api 到 3333。
```

**Go 模块有两个，根目录没有 Go 模块**：`backend-go/`（后端，module `zviewer/backend`）和 `desktop/`（Wails 桌面壳，module `zviewer/desktop`）。两者独立编译，不共享 internal 包。

---

## 2. 环境要求

| 依赖 | 版本 | 说明 |
|---|---|---|
| Go | **1.26+** | `backend-go/go.mod` 要求；桌面壳要求 1.25+ |
| Node.js | **22+** | 前端单测用了 `--experimental-strip-types` |
| npm | 10+ | 仓库用 npm workspaces |
| Git Bash | 任意 | Windows 下 `backend-go/scripts/*.sh` 全是 bash，验证跑不了 cmd |
| WebView2 | 系统自带 | 只有开发桌面壳时需要 |

可选：OBS（调推流）、`sqlite3` CLI（不想用 npm 脚本时手动查库）。

---

## 3. 仓库结构

| 路径 | 内容 | 改这里的频率 |
|---|---|---|
| `frontend/` | React 18 + Vite 8 SPA，别名 `@/` → `src/` | 高 |
| `backend-go/` | Go 后端；`internal/api` 是 HTTP 层，`internal/<域>` 是业务，`internal/store` 是 SQL | 高 |
| `backend-go/internal/db/` | 数据库打开、结构校验、索引、建表 DDL、备份 | 低（改要慎重） |
| `backend-go/scripts/` | 13 个冒烟/回归脚本 | 中 |
| `backend-go/testdata/contract/` | 端点与事件的契约快照（189 端点 / 65 事件） | 只在显式增删接口时 |
| `desktop/` | Wails 桌面壳，`controller/` 管进程与证书 | 中 |
| `scripts/` | 开发热重载、产物编译、启动器 | 中 |
| `config/` | **不入库**：数据库、证书、上传、推流切片 | 不提交 |
| `docs/` | 专题设计文档（HDR、一起听响度、数据源等） | — |

`config/` 在 `.gitignore` 里。这意味着新克隆的仓库**没有数据库**，必须执行第 4 步。

---

## 4. 首次搭建

```bash
git clone <repo> && cd ZViewer
npm install                    # 装前端依赖（workspaces 只有 frontend）
cp .env.example .env           # 按需改端口与密钥

npm run db:init                # 建 16 张表 + 索引，并打印初始管理员密码
```

`db:init` 的输出像这样，初始管理员账号和密码固定为 **`root` / `root`**：

```
  [完成] 数据库已初始化: <repo>/config/dev.sqlite
         表 16 张，日志模式 WAL（默认）

  初始管理员: root / root
```

然后：

```bash
npm run dev
```

打开 http://localhost:5174 ，用 `root` / `root` 登录，第一件事是去「个人设置」改密码。已有账号的密码不会被初始化流程重置。

> 已有数据的机器不需要 `db:init`，把旧 `config/` 目录整份拷过来即可。`db:init` 对非空库会直接拒绝，不会覆盖。

### 关于 `.env`

只有这几个变量常改：`PORT`、`HOST`、`CORS_ORIGIN`、`JWT_*_SECRET`。数据库相关默认值都能用，完整清单见 README 的环境变量表。

`JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` 不填时会用 `config/jwt-secrets.json` 里的随机值（首次启动自动生成）。**改了密钥等于让所有已签发的 token 失效**，本地随意，线上别乱动。

---

## 5. 日常开发

### 5.1 一条命令起前后端

```bash
npm run dev
```

它并发跑两件事：

- `npm run dev:backend` → `scripts/dev-backend.js`：监听 `backend-go/**/*.{go,mod,sum}`，**先 `go build` 到临时 exe，编译成功才换进程**，所以写到一半的文件不会让服务消失，语法错误时旧进程继续服务。
- `npm run dev:frontend` → `frontend` 的 `vite`，5174 端口，`/api`、`/socket.io`、`/live` 都反代到 3333。

单独跑：

```bash
npm run dev:backend        # 只起后端（改 .go 保存即重启）
npm run dev:backend:once   # 只编译运行一次，不监听
npm run dev:frontend       # 只起前端
```

后端不想连 3333（被占用、或要和别的实例并存）时设 `PORT`；前端指过去用 `VITE_API_TARGET=http://localhost:<port>`。

### 5.2 端口

| 端口 | 用途 | 谁监听 |
|---|---|---|
| 3333 | 后端 HTTP/HTTPS（生产也托管前端） | Go |
| 5174 | Vite dev server | 前端 |
| 3334 | RTMP 推流（OBS 连这个） | Go（进程内 `internal/nms`） |
| 3335 | HTTP-FLV 拉流（内部，经 `/live` 反代） | Go（进程内 `internal/nms`） |
| 3336 | LiveKit 信令 | LiveKit 伴生进程 |
| 3337 | LiveKit ICE/TCP（可 `=0` 关闭） | LiveKit 伴生进程 |
| 3338 | LiveKit TURN/TLS | LiveKit 伴生进程 |
| 36530 | 网易云 API（外部服务，一起听用） | 外部容器/进程（见 5.2.1） |

### 5.2.1 两个「不是 Go 写的东西」

**推流（3334/3335）是后端进程内实现的**，源码运行、单容器、桌面壳都自带，不用装 SRS
也不用装 node-media-server：RTMP 收流后按 FLV 转封装（不转码）从 `/live/{推流码}.flv`
吐出去。只有想用外部媒体服务时才设 `NMS_HTTP_FLV_URL` 指过去，此时不再监听本地端口。

**一起听（网易云）必须有一个外部 NCM API 服务**——本仓库不含网易云协议实现
（weapi/eapi 加密、几十个接口），`/api/music/ncm/*` 只是转发。三种起法：

```bash
# 1) docker compose（推荐，和 zviewer 同一个网络）
docker compose -f docker-compose.linux-single.yml --profile music up -d

# 2) 单独跑社区镜像（等价于 Node 时代的 127.0.0.1:36530）
docker run -d --name zviewer-ncm -p 127.0.0.1:36530:3000 \
  binaryify/netease_cloud_music_api:latest

# 3) 指向任何已部署的 NCM API（含增强版）
NCM_API_BASE=http://192.168.1.20:36530 npm run dev
```

拿不到服务时只有音乐相关接口返回 503 `NCM_UNAVAILABLE`，播放/房间/推流都不受影响；
后端启动日志会打印当前 `NCM_API_BASE`，容器入口脚本在没配时也会提示。

同时跑两个后端实例（比如 dev 和 prod 并存）时，第二个会因 3334/3335 被占用而
**自动降级成外部探测模式**（日志里有一行 `内置媒体服务启动失败…降级`，推流在第二个实例上不可用）。
需要两边都能推流就改端口：`RTMP_PORT=4334 HTTP_FLV_PORT=4335 PORT=4333`。

### 5.3 日志

后端日志直接打 stdout，`npm run dev` 时就在终端里，前缀是模块名（`[db]`、`[config]`、`[voice]`、`[req]`）。生产由 `npm start` 写到 `log/backend.log`。

LiveKit 伴生进程的日志也混在同一条流里，前缀 `[livekit]`。语音起不来时先看这几行。

---

## 6. 构建

```bash
npm run build          # Go 后端 → dist/zviewer-backend.exe，然后前端 → dist/
npm run build:backend  # 只编后端
npm run build:frontend # 只编前端
```

产物：`dist/zviewer-backend(.exe)`（约 19 MB）+ `dist/index.html` 与 `dist/assets/`。

打包分发：

```bash
npm run build:all      # 交互式选平台，产出 dist/win/ 或 dist/linux/
npm run build:exe      # 只出可执行文件
```

桌面壳（Windows）：

```bash
cd desktop
npm run shell:build    # 开发构建，输出 build/bin/（带 --console 可看日志）
npm run shell:dist     # 分发构建，输出 dist-gui/
npm run package        # 出 ZIP + SHA256
```

> `cd desktop && go build -tags production .` 会覆盖**已入库**的 `desktop/desktop.exe`，日常别这么编；用 `npm run shell:build`。

### 6.1 发版与大陆镜像（GitHub → GitCode）

`.github/workflows/build.yml` 推 `main` 出 `latest` 预发布、推 `v*` 出正式版。两个 release job 末尾都会把
**同一份 Release 与附件**再发一份到 [GitCode](https://gitcode.com)（CSDN 与华为云 CodeArts 联合运营的平台，
与 AtomGit 已合并同站），大陆用户直接走 `gitcode.com` 下载。

> GitCode 侧 main 分支镜像的 tag 是 **`dev`**，不是 `latest`：GitCode API 把 `/releases/latest`
> 当作「仓库最新 Release」的别名，tag 叫 `latest` 时 `GET` 会返回正式版、`DELETE` 又 404，
> 整步静默失败。脚本对 `TAG=latest` 会直接报错退出。

**为什么不能只靠 GitCode 的「仓库镜像」**（两个理由，都会踩坑）：

1. 镜像只同步分支 / 标签 / 提交，**不搬 Release 和附件**；
2. 更硬的限制：项目一旦开启「仓库镜像 → Pull」，GitCode 会**禁用所有写操作**（推代码、建 Tag、建 Release
   全部 403，报 `This operation is not allowed because the repository is an image repository`）。
   ——官方文档写明这是为了避免双写。

所以流程是「代码和 Release 都由 CI 推」：

1. `git push gitcode HEAD:refs/heads/main` + `git push gitcode refs/tags/<tag> --force`
   —— 主线与标签直接推过去，替代 Pull 镜像的定时同步（Pull 镜像每天才拉一次，本来就慢）。
   main 分支那次推的是 `dev` 这个移动 tag。
2. `node scripts/sync-gitcode-release.mjs`
   —— 同名 Release 已存在则先删再建 → `GET /releases/{tag}/upload_url` 取华为云 OBS 预签名地址 →
   `node:https` 直连 `PUT` 原始字节 → **回读 Release 确认附件真的挂上了** → 把说明里的 GitHub 直链
   改成本站直链 → 下载地址写进 Job Summary。

> 推 tag 失败时脚本会用 `TARGET_COMMITISH` 让 GitCode 自建 tag（只读镜像仓会先被拦下并给出指引）。

「Push tag」仍是 `continue-on-error: true`（GitCode 出问题不影响 GitHub 发版）；
**「Publish to GitCode Release」不再吞异常**——附件没传上去就让这一步标红，并在 Job Summary 里给出
每个附件的重试次数、耗时与失败原因（历史教训：旧版把失败吞掉，连续 3 个版本都只有 source code）。

一次性配置：

1. gitcode.com「导入项目」从 GitHub 导入 `Zero-wyc/ZViewer`，仓库**必须公开**（私有则下载要登录，失去意义）。
2. **不要开「仓库镜像 → Pull」**。已经开了的，去 项目设置 → 仓库镜像 把它删掉/关掉，否则仓库只读，
   推 tag 与建 Release 一律 403。代码同步由 workflow 的 `git push` 承担。
3. 头像 → 设置 → 私人令牌 → 生成（勾仓库读写），只显示一次。
4. GitHub 仓库 → Settings → Secrets → Actions，新增 `GITCODE_TOKEN`。

> 没配 `GITCODE_TOKEN` 时同步步骤整体跳过（`if: env.GITCODE_TOKEN != ''`），发版行为与未接入时一致。

手工补历史版本：

```bash
GITCODE_TOKEN=<令牌> TAG=v5.0.0 RELEASE_NAME=v5.0.0 \
RELEASE_BODY_FILE=release_body.md \
ASSETS="zviewer-linux-x64.tar.gz zviewer-windows-x64.zip zviewer-windows-x64-GUI.zip" \
node scripts/sync-gitcode-release.mjs      # 加 DRY_RUN=1 只打印计划

# 已有 Release 只缺附件（不删不重建、保留原说明）
GITCODE_TOKEN=<令牌> TAG=v5.0.4 NO_RECREATE=1 \
ASSETS="zviewer-linux-x64.tar.gz zviewer-windows-x64.zip zviewer-windows-x64-GUI.zip" \
node scripts/sync-gitcode-release.mjs
```

排查要点：

- 单附件上限 **2 GB**（当前产物 37～65 MB）；`GITCODE_API_BASE` 默认 `https://api.gitcode.com/api/v5`。
- **附件上传不能用内置 `fetch`**：undici 的 `headersTimeout` 默认 300s，从请求发出就开始计时，
  **不等请求体发完**；GitHub runner → 华为云 OBS 这条链路慢，37MB 的包会在 ~301s 被掐断
  （`TypeError: fetch failed`）。脚本因此改用 `node:https` 直连 PUT，只保留「10 分钟无进展」的停滞检测。
  这一条是 2026-10-26 之前「Release 里只有 source code」的真正原因。
- **`GET /releases/latest` 是别名**，指向仓库最新 Release，不是 tag 叫 latest 的 Release；
  按 tag 寻址时 tag 不能取 `latest`（main 分支镜像改用 `dev`）。
- **上传成功 ≠ 附件挂上**：`PUT` 返回 203 表示对象写进 OBS 但平台回调没登记，附件不会出现在 Release 里。
  脚本每个附件传完都回读 `assets` 校验，缺失就重传，最终仍缺失则整步失败（`UPLOAD_ATTEMPTS` 默认 3，
  workflow 里设 2 以控制耗时）。
- Release 主键**就是 tag 名**：`GET|PATCH|DELETE /repos/{owner}/{repo}/releases/{tag}`；附件删除是
  `DELETE /releases/{tag}/attach_files/{attach_file_id}`（脚本直接删 Release，更省事）。
- 日志出现 `访问仓库失败：HTTP 401` = 令牌过期或没权限；`HTTP 404` = GitCode 上还没有该仓库。
- 只想排障不想写远端：`DIAG=1` 只读诊断（仓库可读性 / Release 是否存在 / 上传地址与 header 键）；
  `NO_RECREATE=1` 原地补传缺失附件，不删不重建；`REWRITE_GITHUB_LINKS=0` 关掉正文直链改写。
- 日志出现 `This operation is not allowed because the repository is an image repository` /
  `error_code_name":"UN_KNOW` 且提到 image repository = 项目还开着「仓库镜像 → Pull」，
  仓库处于只读态：去 项目设置 → 仓库镜像 关掉后重跑（脚本与 workflow 都会直接给出这句指引）。
- 若 GitCode 侧无法取消 Pull 镜像，就新建一个**空仓库**（不要用「导入」），把 `build.yml` 里的
  `GITCODE_REPO` 指向它，再推一次 main / tag —— 代码、标签、Release 都由 CI 推上去。
- 下载直链 `https://gitcode.com/<owner>/<repo>/releases/download/<tag>/<file>` 匿名可下且永久有效。
- Docker 镜像不在此同步范围（Docker Hub 在大陆同样慢，需要时另配国内镜像仓库）。

### 6.2 应用内的「更新源」开关

网页端（管理页 → 设置 → 版本更新）与桌面 GUI（检查更新弹窗）都有「使用 GitCode 更新源」，**默认开启**；
关掉回到 GitHub。两个实现各自独立：

| 端 | 实现 | 偏好存放 |
| --- | --- | --- |
| 网页端一键更新 | `internal/updater/source.go` | `config/update-source.json`（`{"useGitCode": true}`） |
| 桌面 GUI 自动更新 | `desktop/controller/update.go` | `settings.json` 的 `updateGitCode` |

- 偏好**不写数据库**：`system_settings` 是整行表，加列会让存量库的 SELECT 直接失败（本项目「绝不自动改表结构」）。
  `config/` 在自动更新时会被备份还原，所以这个文件不会丢。
- 运维兜底：`ZVIEWER_UPDATE_SOURCE=github|gitcode` 优先于偏好文件（仅后端）。
- **不做自动回退**：选了 GitCode 就只走 GitCode，拉取失败或镜像还没有 Release 时直接把错误显示出来
  （文案里带「去设置里关掉这个开关」的指引）。静默换源会让人以为镜像可用、流量却悄悄走了境外。
- GitCode 的 Release 列表没有 `html_url` / `published_at`、assets 里混着源码包，差异在
  `normalizeGitCodeReleases`（后端）与 `normalizeGitCodeRelease`（桌面端）里抹平。
- 桌面端下载白名单已加入 `gitcode.com` / `raw.gitcode.com`；GitCode 源的附件**不套** CDN 前缀
  （附件 id 是 GitCode 自己的编号，套 GitHub 资产端点会 404）。

---

## 7. 质量门禁

改完代码，按改动范围跑：

```bash
# 后端
npm run lint:go                       # gofmt -l + go vet
npm run test:go                       # go test ./...

# 前端
cd frontend && node ../node_modules/typescript/bin/tsc
npm run lint                          # eslint，要求 0 error 0 warning
npm test -w frontend                  # 前端单测
```

改了后端的行为，再跑一次全量回归（约 1 分 45 秒）：

```bash
npm run test:regression
```

13 个脚本各自覆盖一块，全绿才算没退化：

| 脚本 | 覆盖 |
|---|---|
| `route-parity.sh` | 189 个端点的存在性与鉴权边界（契约快照模式，不依赖旧实现） |
| `events-parity.sh` | 65 个 Socket 事件的注册与参数形状 |
| `profile-smoke.sh` | 改密 / 改名 / 头像上传删除 |
| `movie-smoke.sh` | 影片 REST |
| `proxy-smoke.sh` | 防盗链代理 |
| `openlist-stream-smoke.sh` | OpenList 影片流代理 |
| `bilibili-smoke.sh` | B站解析（走真实接口） |
| `compat-smoke.sh` | 兼容性 |
| `https-smoke.sh` | `--gen-cert` 与 HTTPS 启动 |
| `desktop-env-smoke.sh` | 桌面壳托管环境（`ZVIEWER_DESKTOP=1`） |
| `frontend-smoke.sh` | 真浏览器 12 项全链路 |
| `soak.sh` | 短时压测（默认 60s，`SOAK_SECONDS=86400` 可跑真机 24h） |
| `spike-sio.sh` | Socket.IO 协议层 |

单独跑某一个：`bash backend-go/scripts/profile-smoke.sh`。它们都会用库副本，不会动 `config/dev.sqlite`。

---

## 8. 数据库

### 8.1 三条铁律

1. **启动时绝不建表、绝不加列**。`VerifySchema` 缺表或少 `user` 表关键列就直接退出。这样两套代码不会各自「顺手补一下 schema」把结构改漂。
2. **结构唯一事实源是 `internal/db/schema.sql`**。它和线上库逐字一致，只被 `--init-db` 使用。
3. **备份不能用 `cp`**。WAL 模式下最近提交的事务在 `-wal` 旁文件里，单拷主文件会静默丢数据，而且文件看起来完全正常。

```bash
npm run db:backup -- ../config/db-backups/zviewer-20261025.sqlite
# 等价于 zviewer-server --backup-db <目标文件>（内部 VACUUM INTO，热备、不覆盖）
```

路径是相对 `backend-go/` 的（脚本会先 `cd backend-go`），也可以直接给绝对路径。
注意 npm 脚本在 Windows 下由 cmd 执行，**`$(date)` 这类写法不可用**，日期自己填。

### 8.2 加字段要动哪几处

没有 ORM，手写 SQL，所以加一列至少要改四处：

1. `internal/db/schema.sql` 加列（新库要能建出来）
2. `internal/store/xxx.go` 的 `columns` 常量 + `scanXxx` + `INSERT/UPDATE`
3. 老库需要一条迁移（目前没有迁移框架，靠一次性语句或兼容缺列）
4. `VerifySchema` 只在 `user` 表做列抽查，其它表加列不会失败——**这正是容易漏的地方**，改完跑一遍回归

### 8.3 索引

`internal/db/indexes.go` 里的三个索引是 TypeORM 时代漏掉的，启动时 `CREATE INDEX IF NOT EXISTS` 幂等补建。加索引走这里，别写进 `schema.sql`（那样只有新库有）。

---

## 9. 代码约定

### 后端

- 分层：`internal/api`（HTTP 解析 + 响应）→ `internal/<域>`（业务）→ `internal/store`（SQL）。**服务层不得 import `internal/api`**。
- 响应一律走 `internal/httpx`：`httpx.OK` / `Fail` / `FailWithCode`。前端大量代码按 `success` 字段分支，形状变了等于接口变了。
- 需要前端分流错误时用 `FailWithCode`（如影片代理的 `AUTH_FAILED` / `NOT_FOUND`），不要靠文案匹配。
- 表名、列名全是带引号的 camelCase（`"roomId"`、`"createdAt"`），照抄现有写法，别改成 snake_case。
- 时间比较统一 `datetime('now')`（SQLite 方言），别在 Go 里格式化时间再拼进 SQL。

### 前端

- 路径别名 `@/`，一律用它而不是相对路径跨层引用。
- UI 组件走 `@/components/ui` barrel；弹窗用 `ui/Modal`；剪贴板用 `hooks/useCopyToClipboard`；时长格式化用 `lib/utils` 的 `formatDuration(Ms)`。
- `components/` 不允许依赖 `modules/room`（保持分层干净）。

### 不要做的事

- 不引入 ORM 或查询构建器（现有 SQL 全部手写，混用会让方言与事务边界变得不可控）。
- 不在启动路径加自动 DDL（见 8.1）。
- 不 `git push`（本地提交即可）。

---

## 10. 排错

| 现象 | 原因与处理 |
|---|---|
| 启动报「数据库不存在」 | 没跑 `npm run db:init`，或 `CONFIG_DIR` / `DATABASE_URL` 指错了 |
| 启动报「缺少 N 张表」 | 同上；或连到了一个半初始化的库 |
| 端口被占用 | 旧进程没退。`netstat -ano \| grep :3333` 找 PID；开发热重载会自己杀旧进程，`go run` 起的不会 |
| 目录里多出 `dev.sqlite-wal` / `-shm` | WAL 的正常现象，别手删。要退回旧模式设 `SQLITE_WAL=0` |
| 语音进不去 | 看 `[livekit]` 日志；`backend-go/dev-bin/livekit-server.exe` 缺失会导致伴生进程起不来 |
| 网页能开但登录后立刻掉线 | 明文 HTTP 下后端不写 cookie（`SameSite=None` 必须配 `Secure`），前端改走 localStorage + `Authorization`。用 HTTPS 或按前端的 `authTransport` 逻辑排查 |
| 前端 401 但接口用 curl 正常 | 多半是没带 token，curl 复现时别忘 `-H "Authorization: Bearer ..."` |
| `gofmt -l .` 有输出 | 直接 `gofmt -w <file>`，CI 会拦 |

---

## 11. 提交约定

- 提交信息中文，一行，前缀 `feat:` / `fix:` / `refactor:` / `perf:` / `docs:`。
- 只本地提交，不 push。
- 提交前至少跑过：`npm run lint:go`、`npm run test:go`；动前端就加 `tsc` + `npm run lint`；动后端行为就加 `npm run test:regression`。
