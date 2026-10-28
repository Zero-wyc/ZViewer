# GitCode 发版：从「GitHub 推」改成「GitCode 拉」

## 为什么改

原来的做法是 GitHub 的 `build.yml` 在发版后，用 `space-ast/action-git-release` 把 130MB 附件跨境直传到 GitCode 的 OBS。实测问题集中在两点：

- 平台回调按体积线性变慢（约 110s/MB），一个 37MB 的包要一个多小时才回包，GitHub 的 job 只能干等，`timeout-minutes` 被迫给到 90 分钟；
- 一旦 GitCode 侧卡住，GitHub 的发版流程被拖长，而失败重试也只能从 GitHub runner 再跨境跑一遍。

改成 Pull 之后，GitHub 只负责产出 Release，跨境下载 + 境内上传都发生在 GitCode 的机房里，失败重试也只是 GitCode 再跑一轮，互不牵连。

## 现在的链路

```
GitHub build.yml（不再随提交自动构建，全部手动触发）
  ├─ 手动触发、不填版本号 → 构建测试版 → 发布 GitHub prerelease（tag: latest）
  ├─ 手动触发、填了版本号 → 构建正式版 → 建 v* tag 并发布 GitHub Release
  ├─ 或直接 push v* tag → 同上，走正式版发版
  └─ 只推代码：main 分支、v* tag  →  git push 到 GitCode
                                        │
                                        ▼
GitCode .gitcode/workflows/sync-release.yml（每小时 17 分）
  ├─ 列 GitHub Releases，筛出 v* 正式版（跳过 draft / prerelease）
  ├─ 对照 GitCode 已有 Release，附件齐全就跳过
  ├─ 缺的附件从 GitHub 下载（可走 GH_PROXY 加速）
  └─ 调 scripts/sync-gitcode-release.mjs 建 Release + 上传附件（自带 sha256 去重、停滞检测、回读校验）
```

GitHub 侧不再调用任何 GitCode 发版接口，`build.yml` 里只剩两段 `git push`。

### 发版怎么操作

| 目的 | 操作 |
| --- | --- |
| 出一个测试版 | Actions → Build → Run workflow，`release_tag` 留空。产物进 `latest` 预发布 |
| 发正式版 | 同上，`release_tag` 填 `v5.1.0`。构建完成后自动建 tag、发 Release，GitCode 侧一小时内跟上 |
| 只构建不发布 | 目前没有单独入口；需要排查时看 `build` job 上传的 artifact（保留 30 天） |

版本号有保护：格式必须是 `vX.Y.Z`，且该版本如果已经有 Release 会直接失败，不会覆盖历史版本。要重发只能先手动删掉那个 Release。

## 一次性配置

在 GitCode 仓库（`Zero-wyc/ZViewer`）完成三件事：

| 项 | 位置 | 说明 |
| --- | --- | --- |
| `GITCODE_TOKEN` | 仓库 → 设置 → 密钥 | 个人令牌，需本仓库 releases / 附件写权限。**必填**，没有会直接报错退出 |
| `GITHUB_TOKEN` | 同上 | 选填。公开仓库不配也能跑，配了只是提高 GitHub API 限流额度（未认证 60 次/小时/IP） |
| 关闭 Pull 镜像 | 项目设置 → 仓库镜像 | Pull 镜像仓是只读的，建 Release 会被拒（`provider=image repository`）。代码同步已由 `build.yml` 的 `git push` 负责，不需要镜像 |

工作流引用的仓库名写死在 `.gitcode/workflows/sync-release.yml` 的 `env` 里（`GITHUB_REPO` / `GITCODE_OWNER` / `GITCODE_REPO`），改名或换账号时改这三行。

## 日常行为

- **频率**：`cron: '17 * * * *'`，即每小时第 17 分。GitCode 的 cron 走 **UTC**，整点偏移是为了避开调度高峰；实际触发有数分钟延迟，属正常。
- **每轮最多补 1 个版本**（`MAX_SYNC=1`）：一个版本三个包约 130MB，一次拉多个容易把 job 拖到超时。积压较多时会按「最新优先」逐小时补齐。
- **幂等**：GitCode 上已有该 tag 且附件名齐全 → 直接跳过，不下载、不上传。只缺部分附件时只补缺的那几个。
- **正文改写**：`sync-gitcode-release.mjs` 会把说明里的 `github.com/.../releases/download/...` 直链换成 GitCode 直链。
- **不同步 `latest`**：main 分支的预发布每推一次就重建，按小时轮询没有意义，故意排除。

## 手动补发 / 重试

| 场景 | 做法 |
| --- | --- |
| 补某个历史版本 | GitCode 流水线 → 该 workflow → 运行 → `tag` 填 `v5.0.8` |
| 强制重传 | 同上，`force` 填 `true` |
| 本地先验证 | `DRY_RUN=1 GITCODE_TOKEN=x node scripts/pull-github-release.mjs`（只打印计划） |
| 本地真跑 | `GITCODE_TOKEN=... MAX_SYNC=1 node scripts/pull-github-release.mjs` |

`scripts/pull-github-release.mjs` 支持的环境变量：`GITHUB_REPO`、`GITCODE_OWNER`、`GITCODE_REPO`、`GITCODE_TOKEN`、`GITHUB_TOKEN`、`TAG`、`FORCE`、`MAX_SYNC`、`GH_PROXY`、`DRY_RUN`、`BUDGET_MINUTES`。

## 故障排查

| 现象 | 原因 / 处理 |
| --- | --- |
| `缺少 GITCODE_TOKEN` | 没配密钥，或名字不是 `GITCODE_TOKEN`（不能以 `ATOMGIT_` 开头） |
| `provider=image repository` | 仓库仍是 Pull 镜像（只读），按上表关掉 |
| `GitHub API 限流` | 配 `GITHUB_TOKEN`，或调大轮询间隔 |
| 创建 Release 400 / tag 不存在 | GitCode 上还没有这个 tag：确认 GitHub 的 `build.yml` 那次 `Push tag to GitCode` 成功了 |
| 附件一直转圈、页面上看不到文件 | 平台回调慢。脚本会按 30s 回读附件列表判定是否已登记，不必等 OBS 回包；下一轮会自动补缺 |
| 正文还是旧的 | 已知限制：GitCode 的 PATCH 只接受 formData，脚本只在**创建** Release 时写正文。要更新正文只能删掉该 Release 后重跑 |

## 已知限制

1. 同一 tag 重复发布时正文不会更新（见上表），附件会按 sha256 覆盖。
2. 定时轮询最坏滞后约 1 小时；要更快就把 cron 改密（最短 5 分钟），但注意 GitHub API 限流。
3. GitCode 侧 `dev` 这个旧的历史镜像 Release 不再维护，可在页面上手动删除，避免用户下到过期包。
