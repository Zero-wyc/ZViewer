# Gitee 发版：GitHub 构建并推送，Gitee 侧托管下载

## 链路

```
GitHub build.yml（手动触发构建）
  ├─ 手动不填版本号 → 测试版 → GitHub prerelease（tag: latest）
  ├─ 手动填 vX.Y.Z  → 正式版 → 建 tag → GitHub Release
  ├─ 或直接 push v* tag → 同上
  ├─ 只推代码：main 分支、v* tag → git push 到 gitee.com/Zero-wyc/ZViewer
  └─ Publish to Gitee：node scripts/sync-release-to-gitee.mjs（附件直接用本地构建产物）
                          ↓ 建/更新发行版 + multipart 上传 + 回读校验
                     gitee.com/Zero-wyc/ZViewer/releases
```

> 为什么不用 Gitee Go：它的插件标识跟公开文档对不上（`npmbuild@1` 被判「不支持的任务类型」），
> 流水线起不来；而 Gitee 的附件上传是同步 multipart，不存在 GitCode 那种「PUT 成功但平台没登记」
> 的坑，从 GitHub 直接推最省事。仓库里因此**没有** `.workflow/` 目录。

## 一次性配置

| 事项 | 位置 | 说明 |
| --- | --- | --- |
| 生成私人令牌 | gitee.com → 头像 → 设置 → 私人令牌 | 勾选 `projects`（仓库读写）即可 |
| 配 `GITEE_TOKEN` | GitHub 仓库 → Settings → Secrets | 名称必须是 `GITEE_TOKEN`，供推代码、推 tag、建发行版用 |
| `GITEE_TOKEN`（本机补发用） | 本机环境变量 | 想手动补历史版本时才需要；不必配到 Gitee 仓库里 |

CI 里可选：`GH_PROXY`（如 `https://ghfast.top/`，GitHub 直连慢时用）、`MAX_SYNC`（单轮补几个版本，默认 1）。本机补发时还可以只给 `TAG` 指定版本、`FORCE=1` 强制重传。

## 发版流程

1. GitHub → Actions → **Build** → Run workflow：
   - `release_tag` 留空 = 测试版（只更新 GitHub 的 `latest`，不同步到 Gitee）
   - `release_tag` 填 `v5.1.0` = 正式版
2. 构建约 20 分钟，产物进 GitHub Release，随后同一个 job 里把 tag 推到 Gitee、
   再建 Gitee 发行版并上传三个附件（合计约 130MB，境内上行通常 1–3 分钟）。
3. 失败只会在 job 上打一条 warning，不影响 GitHub 发版；补发用下面两条命令之一：

```bash
# 本机补发（推荐，不占 CI 时间）
GITEE_TOKEN=<令牌> TAG=v5.1.0 node scripts/sync-release-to-gitee.mjs

# 或者重跑一遍 Build（版本号必须换成新的，已发布的版本会被拦下）
```

## 限额（重要）

| 限制 | 数值 | 影响 |
| --- | --- | --- |
| 单个附件 | 100MB | GUI 包约 70MB，安全；脚本上传前会先检查，超了直接报错 |
| 仓库附件总量 | 1GB | 每个版本约 130MB，大约 7 个版本就满，旧版本需要手动删 |
| 构建额度 | 不涉及 | 不在 Gitee 上跑流水线，只用它的存储 |

## 故障排查

| 现象 | 原因 / 处理 |
| --- | --- |
| Build 里 Gitee 步骤被跳过 | 没配 `GITEE_TOKEN`；步骤条件是 `if: env.GITEE_TOKEN != ''` |
| `缺少 GITEE_TOKEN` | 密钥没配或名字不对（区分大小写） |
| `推送到 Gitee 失败`（GitHub 侧） | GitHub Secrets 里的 `GITEE_TOKEN` 无效或没有该仓库写权限 |
| 上传 403 / 401 | 令牌权限不足，重新生成时勾上 `projects` |
| 上传报超过 100MB | 包体超限，需要瘦身或分卷；脚本已在上传前拦截 |
| 附件页看不到文件但日志成功 | 刷新页面；脚本上传后会回读 `/releases/tags/{tag}` 校验，日志里会打印实际附件数 |
| 正文还是旧的 | 现在支持 PATCH，重跑就会更新正文 |

## 已知限制

- 只同步正式版（`v*`、非 draft、非 prerelease），`latest` 测试版只留在 GitHub。
- Gitee 上需要已有该 tag：由 `build.yml` 推送；如果 Gitee 上缺 tag，可设 `GITEE_TARGET_BRANCH` 让接口建 tag（默认不建）。
- 仓库附件总量 1GB 是硬上限，长期要定期清理旧版本。
