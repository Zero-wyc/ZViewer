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

只有这几个变量常改：`PORT`、`HOST`、`CORS_ORIGIN`、`JWT_*_SECRET`。数据库相关默认值都能用，完整清单见 [docs/deployment.md](docs/deployment.md) 的环境变量表。

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

### 5.2.1 推流与一起听都不需要外部进程

**推流（3334/3335）是后端进程内实现的**，源码运行、单容器、桌面壳都自带，不用装 SRS
也不用装 node-media-server：RTMP 收流后按 FLV 转封装（不转码）从 `/live/{推流码}.flv`
吐出去。只有想用外部媒体服务时才设 `NMS_HTTP_FLV_URL` 指过去，此时不再监听本地端口。

**一起听（网易云）同样是后端自带的**：`internal/ncm` 自己实现 weapi / eapi / linuxapi
加密与 46 条接口（含扫码登录、云盘上传、音质降级）。前端一次 `/api/music/ncm/*`
请求就是一次函数调用——**没有外部服务、没有回环端口、没有子进程、没有 Node 运行时**，
也没有任何 `NCM_*` 环境变量可配（历史变量已全部移除，设了也不生效）。

拿不到数据只有两种可能：网易云拒绝（风控 / 地区 / 版权，日志前缀 `[ncm]`），或者
网络本身不通。没有「音乐服务未启动」这个状态，也不需要为它做部署。

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

#### 桌面可选组件（ZviewerRelease 的 components 分支）

桌面 GUI **不再随包**带 cloudflared 与 EasyTier：两者放在产物仓库
`Zero-wyc/ZviewerRelease` 的 **`components` 分支**（组件库），随镜像同步到 GitCode，
GUI 第一次用到时下载（`desktop/controller/components.go`）。

| 组件 | 分支内文件 | 下载端点 |
| --- | --- | --- |
| Cloudflare Tunnel | `cloudflared-windows-amd64.exe` | `https://api.gitcode.com/api/v5/repos/Zero-wyc/ZviewerRelease/raw/<文件>?ref=components` |
| EasyTier 组网 | `easytier-windows-x86_64-v2.6.4.zip` | 同上 |

> 2026-10-30 前这些文件在主仓库根目录的 `public/`（84 MB，每次 clone 都要拖）。迁到独立分支后
> 主仓库只剩代码。**不要放回 `main`**：`main` 每次发版都用孤儿提交整体替换，会被清掉。

**`raw.gitcode.com/.../raw/<branch>/<path>` 不能用**：那是预览通道，exe/zip 一律 `403 暂不支持预览`；
`api.gitcode.com` 的 `raw` 端点才是按字节返回（支持 Range，55 MB 实测可下）。

升级组件：`desktop/scripts/fetch-components.ps1` 把新文件拉到 `desktop/.components/`（已 gitignore）
→ 覆盖到 `ZviewerRelease` 的 `components` 分支并同步 `components.json` → 改 `components.go` 的
`Version`（`Size` 只影响进度显示，可顺手改）→ `cd desktop && go test ./controller -run Component`
（只校验地址拼法，**不比对摘要**）。打包只下载 FRP（`scripts/prepare-tools.ps1` 已只剩 FRP）；
EasyTier 的 LGPL 许可证副本留在 `desktop/assets/LICENSE-EasyTier.txt` 供打包。

### 6.1 发版与大陆镜像（GitHub → GitCode）

`.github/workflows/build.yml` **不跟随 main 自动构建**：手动触发时填了 `vX.Y.Z` 才出正式版
（自动建 tag 并发 GitHub Release），留空则只出测试版（GitHub 的 `latest` 预发布）。

正式版走完四个 job：

```
prepare → build / build-gui → release（GitHub Release）
                            → publish-branch（更新产物仓库：GitHub + GitCode）
                            → sync-gitcode（代码与 tag 推到 GitCode 主仓库）
```

`publish-branch` 把三个包 + `latest.json` + `README.md` 用**孤儿提交整体替换**到独立仓库
[`Zero-wyc/ZviewerRelease`](https://github.com/Zero-wyc/ZviewerRelease) 的 `main` 分支，
然后 force push。仓库里永远只有当前版本，旧包随旧提交一起消失，历史不膨胀。
同一份提交紧接着再推一次到 GitCode 的 `Zero-wyc/ZviewerRelease`——客户端读的就是那边。

`sync-gitcode` 把本次发布的提交与 tag 推到 GitCode 的 `Zero-wyc/ZViewer`。

> 为什么要显式推：GitCode 没有开放「立刻同步一次」的接口（`POST /repos/{owner}/{repo}/mirror/pull`
> 这类路由实测 `404 Route Not Found`，官方 API 文档里也没有镜像相关条目），仓库侧只按平台自己的
> 节奏拉取，发版后往往要等上一段时间。v5.1.1 发版时实测 GitCode 的 `main` 落后 GitHub 好几个提交，
> 产物仓库的 `latest.json` 也停在上一版。
> 推送用 `scripts/sync-gitcode-code.sh`，推完 `ls-remote` 回读校验；分支分叉时按镜像语义
> `--force-with-lease` 对齐并打警告，tag 一定指向本次构建的提交。

> **前提：GitCode 上这两个仓库不能是「镜像仓」**。GitCode 的 Pull 镜像仓是只读的，推送会被平台
> 拒绝（`<CH.00905403> ... repository is an image repository`）。两个仓库现在都是这种状态，所以
> 脚本遇到这个报错只打 `::warning::` 跳过，不把已经成功的发版判成失败——GitCode 会自己慢慢追上。
> 想让「发版即同步」真正生效，需要去 GitCode **项目设置 → 仓库镜像** 关掉 Pull 镜像（每个仓库各一次），
> 让它们变成普通仓库，之后 CI 的推送就能直接落库。

单文件最大 52MB，低于 git 的 100MB 硬限制，所以走分支是安全的。

补发（不必重新构建）：

> `Actions → 补发产物仓库 (publish-release-repo)` → 填原构建的 `run_id` + `tag` + `version`。
> `prepare` 会以「该版本已有 Release」拦下重复发版，所以修产物仓库只能走这个入口。
> 它同样会推 GitCode 产物仓库；代码与 tag 若也丢了，手动重跑一次 `sync-gitcode` 的步骤即可
> （`scripts/sync-gitcode-code.sh` 幂等，重复执行不会产生多余提交）。

一次性配置：

| 位置 | 名称 | 用途 |
| --- | --- | --- |
| 本仓库 Settings → Secrets | `RELEASE_REPO_TOKEN` | 对 GitHub 的 `ZviewerRelease` 有 `contents:write` 的 PAT（跨仓库推送 `GITHUB_TOKEN` 无效） |
| 本仓库 Settings → Secrets | `GITCODE_TOKEN` | GitCode 私人令牌，需对 `Zero-wyc/ZViewer` 与 `Zero-wyc/ZviewerRelease` 有写权限 |

> 没配 `RELEASE_REPO_TOKEN` 时 `publish-branch` 只打警告并跳过，不影响 GitHub Release 正常发布；
> 没配 `GITCODE_TOKEN` 时 GitHub 侧照常发布，只打警告说 GitCode 没更新——国内用户会一直看到旧版本，
> 出现这条警告要当成故障处理。

排查要点：

- 日志里先看 `== 产物目录` 那几行（脚本会 `ls -la` + 递归列出所有压缩包），
  产物到底落在哪一层一目了然。脚本按名字找、找不到递归 3 层兜底，不用 `cd`/`..` 相对路径。
- `latest.json` 里每个 asset 都带 `url`；客户端优先用它，缺失才按镜像前缀自己拼。
- `publish-branch` 推完 GitCode 会回读清单并抽查一个包的 HTTP 状态与总字节数，日志里是
  `== 回读 GitCode 清单：tag=vX.Y.Z ✅` + 三行 `HTTP 206 总字节 …/期望 …`。不是这个形状就说明没落地。
- `sync-gitcode` 报 `::warning::… 是镜像仓（只读）`：去 GitCode 关掉 Pull 镜像（见上），仓库变普通仓库后重跑该 job 即可。
- `sync-gitcode` 报「认证失败」：检查 `GITCODE_TOKEN` 是否过期、有没有这两个仓库的写权限。

- Docker 镜像不在此同步范围（Docker Hub 在大陆同样慢，需要时另配国内镜像仓库）。

### 6.2 应用内的「更新源」开关

网页端（管理页 → 设置 → 版本更新）与桌面 GUI（检查更新弹窗）都有「使用镜像更新源」，**默认开启**；
关掉回到 GitHub Release。两个实现各自独立，但读的是同一份清单：

| 端 | 实现 | 偏好存放 |
| --- | --- | --- |
| 网页端一键更新 | `internal/updater/source.go` | `config/update-source.json`（`{"useGitCode": true}`） |
| 桌面 GUI 自动更新 | `desktop/controller/update.go` | `settings.json` 的 `updateGitCode` |

镜像侧读的是独立产物仓库 **`Zero-wyc/ZviewerRelease`**（每次正式发版由 `build.yml` 的
`publish-branch` job 用孤儿提交整体替换 `main`，GitHub 与 GitCode 两边各推一次）：

```
latest.json          # 版本清单：tag / version / commit / publishedAt / assets[name,size,sha256]
zviewer-*.zip|tar.gz # 三个平台包
```

- 客户端请求 `https://api.gitcode.com/api/v5/repos/Zero-wyc/ZviewerRelease/raw/latest.json?ref=main`
  取清单，安装包走同一接口（`.../raw/<文件名>?ref=main`），境内直连、不需要代理。
- **下载通道为什么是 api.gitcode.com 的 `/raw/` 接口**（实测过每一个候选）：

  | 通道 | 结果 |
  | --- | --- |
  | `api.gitcode.com/.../raw/<文件>?ref=main` | ✅ 200/206，52MB 包 **8.8MB/s**，sha256 对得上 |
  | `raw.gitcode.com/.../blobs/<sha>/<文件>` | ❌ **418**，CloudWAF「疑似攻击行为」，伪装 UA/Referer/HTTP2 都无效 |
  | `gitcode.com/.../raw/...` | ❌ 200 但返回 SPA 页面的 HTML，不是文件内容 |
  | `gitee.com/.../raw/main/<文件>` | ❌ 大文件 **403**「large file require login for access」（清单这种小文件才可匿名取） |
  | `api.gitcode.com/.../contents/<文件>` | ⚠️ 可用但返回 base64，52MB 包会撑到上百 MB 内存，不采用 |

  注意 418 是 WAF 按 TLS 指纹拦的，不是仓库没同步——产物同步之后照样 418。
- 清单里每个 asset 都带 `url`，客户端**优先用清单的 url**，缺失才按镜像前缀自己拼。
  这样换通道只改 CI（`scripts/publish-release-repo.sh`），不用等客户端发版。
- 偏好**不写数据库**：`system_settings` 是整行表，加列会让存量库的 SELECT 直接失败（本项目「绝不自动改表结构」）。
  `config/` 在自动更新时会被备份还原，所以这个文件不会丢。
- 运维兜底：`ZVIEWER_UPDATE_SOURCE=github|gitcode|mirror` 优先于偏好文件（仅后端），
  后两个别名都归一到镜像源。
- **不做自动回退**：选了镜像就只走镜像，拉取失败或清单还没有产物时直接把错误显示出来
  （文案里带「去设置里关掉这个开关」的指引）。静默换源会让人以为镜像可用、流量却悄悄走了境外。
- 字段名 `useGitCode` / `updateGitCode` 是历史命名，保留是为了不让存量安装的偏好失效。
- 桌面端下载白名单含 `api.gitcode.com` / `gitcode.com` / `raw.gitcode.com`；镜像源的地址是直链，**不套** CDN 前缀。

> 升级断层提醒：老版本（v5.1.x 及以前）的检查更新仍读 GitCode 主仓库的 Release 列表，那条链路
> 已经不再发布。要让老用户升到包含新逻辑的版本，需要在新版本发版时顺带往 GitCode 主仓库补一份
> Release（一次性即可），否则老客户端会一直看到旧版本。

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
