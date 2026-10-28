# Gitee 发版：GitHub 构建并推送，Gitee 侧托管下载

## 链路

```
GitHub build.yml（手动触发构建）
  ├─ 手动不填版本号 → 测试版 → GitHub prerelease（tag: latest）
  ├─ 手动填 vX.Y.Z  → 正式版 → 建 tag → GitHub Release
  ├─ 或直接 push v* tag → 同上
  └─ 只推代码：main 分支、v* tag → git push 到 gitee.com/Zero-wyc/ZViewer
                                       ↓ 触发 v* tag
Gitee .workflow/sync-release.yml（Gitee Go，境内构建机）
  └─ node scripts/sync-release-to-gitee.mjs
        ├─ 从 GitHub 下载附件（走 ghfast.top 加速）
        └─ 建/更新 Gitee 发行版 + multipart 上传 + 回读校验
```

> **为什么不在 GitHub 侧上传**：GitHub 托管 runner 跨境直传 Gitee 会被限速到十几 KB/s，
> 130MB 传 30 分钟都传不完（实测连第一个文件都没落盘）。而从境内机器上传 Gitee 实测 **9.7MB/s**，
> 三个包十几秒传完。所以「传」这一步必须交给 Gitee 自己的构建机。

## 一次性配置

| 事项 | 位置 | 说明 |
| --- | --- | --- |
| 生成私人令牌 | gitee.com → 头像 → 设置 → 私人令牌 | 勾选 `projects`（仓库读写）即可 |
| 配 `GITEE_TOKEN` | GitHub 仓库 → Settings → Secrets | 供 `build.yml` 推代码、推 tag 用 |
| 配 `RELEASE_TOKEN` | Gitee 仓库 → 管理 → 环境变量 | 同一个令牌，勾「敏感信息」。**不能叫 `GITEE_TOKEN`**：`GITEE_` 是 Gitee Go 的系统保留前缀 |
| 开通流水线 | Gitee 仓库 → DevOps → 流水线 → 新建 | 选择 `.workflow/sync-release.yml`，创建后即生效（免费额度 1000 核分/月） |

CI 里可选：`GH_PROXY`（如 `https://ghfast.top/`，配上就优先走加速，境内直连 GitHub 常卡住）、`MAX_SYNC`（单轮补几个版本，默认 1）。本机补发时还可以只给 `TAG` 指定版本、`FORCE=1` 强制重传。

## 发版流程

1. GitHub → Actions → **Build** → Run workflow：
   - `release_tag` 留空 = 测试版（只更新 GitHub 的 `latest`，不同步到 Gitee）
   - `release_tag` 填 `v5.1.0` = 正式版
2. 构建约 20 分钟，产物进 GitHub Release，同时把 tag 推到 Gitee。
   Gitee 侧收到 `v*` tag 后自己启动流水线，约 1–3 分钟把三个附件传完（合计约 130MB）。
3. 发版后 Gitee 侧约 1–3 分钟跟上（tag 触发的流水线）。失败时的补发入口：

| 方式 | 操作 | 适用 |
| --- | --- | --- |
| **Gitee → 流水线 → 运行**（首选） | 主分支上点运行 | 境内机器，最快 |
| 本机跑脚本 | `GITEE_TOKEN=<令牌> TAG=v5.1.0 node scripts/sync-release-to-gitee.mjs` | 想本地看详细日志 |
| Actions → Sync Release to Gitee | `tag` 填 `v5.1.0` | 兜底；**跨境上传很慢**（可能半小时以上） |
| 重跑 Build | 版本号必须换成新的（已发布的会被 prepare 拦下） | 顺带出个新版本 |

> 注意：**同一个版本失败后不能直接重跑 Build** —— `prepare` 会以「该版本已有 Release」失败。
> 这是刻意设计的（Release 可追溯，不许覆盖），补发请走上表前两种。

## 限额（重要）

| 限制 | 数值 | 影响 |
| --- | --- | --- |
| 单个附件 | 100MB | GUI 包约 70MB，安全；脚本上传前会先检查，超了直接报错 |
| 仓库附件总量 | 1GB | 每个版本约 130MB，大约 7 个版本就满，旧版本需要手动删 |
| 构建额度 | 不涉及 | 不在 Gitee 上跑流水线，只用它的存储 |

## 故障排查

| 现象 | 原因 / 处理 |
| --- | --- |
| Build 里没有 Gitee 步骤 | 默认就不跑：发行版交给 Gitee Go。要临时切回 GitHub 侧，把仓库变量 `GITEE_PUSH_FROM_GITHUB` 设为 `true` |
| 流水线报「不支持的任务类型」 | `step` 用了 `npmbuild@1` 之类旧插件；现在是 `build@nodejs` + `nodeVersion`/`commands` |
| 上传一直不结束 | 跨境链路问题；境内流水线正常应在 1–3 分钟内完成。脚本有 180s 空闲超时 + 一次重试 |
| `缺少 GITEE_TOKEN` | 密钥没配或名字不对（区分大小写） |
| `推送到 Gitee 失败`（GitHub 侧） | GitHub Secrets 里的 `GITEE_TOKEN` 无效或没有该仓库写权限 |
| 上传 403 / 401 | 令牌权限不足，重新生成时勾上 `projects` |
| 上传报超过 100MB | 包体超限，需要瘦身或分卷；脚本已在上传前拦截 |
| `HTTP 400 target_commitish is missing` | 老版本脚本的问题，已修：现在会自动带上 tag 的 commit SHA |
| 附件页看不到文件但日志成功 | 刷新页面；脚本上传后会回读 `/releases/tags/{tag}` 校验，日志里会打印实际附件数 |
| 正文还是旧的 | 现在支持 PATCH，重跑就会更新正文 |

## 已知限制

- 只同步正式版（`v*`、非 draft、非 prerelease），`latest` 测试版只留在 GitHub。
- Gitee 上需要已有该 tag：由 `build.yml` 推送。Gitee 创建发行版时**强制要求** `target_commitish`（缺了报
  `400 target_commitish is missing`），脚本会自动解析该 tag 对应的 commit SHA 传进去；只有解析失败时才回退到
  `GITEE_TARGET_BRANCH` 或 `main`。
- 仓库附件总量 1GB 是硬上限，长期要定期清理旧版本。
