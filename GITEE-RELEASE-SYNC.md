# Gitee 发版：GitHub 构建，Gitee 侧拉取发行版

## 链路

```
GitHub build.yml（手动触发构建，见下）
  ├─ 手动不填版本号 → 测试版 → GitHub prerelease（tag: latest）
  ├─ 手动填 vX.Y.Z  → 正式版 → 建 tag → GitHub Release
  ├─ 或直接 push v* tag → 同上
  └─ 只推代码：main 分支、v* tag → git push 到 gitee.com/Zero-wyc/ZViewer

Gitee .workflow/sync-release.yml（v* tag 触发，另有 12 小时兜底）
  └─ node scripts/sync-release-to-gitee.mjs
       ├─ 列 GitHub Release，筛 v* 正式版
       ├─ 对照 Gitee 发行版，附件齐全就跳过
       ├─ 缺的附件从 GitHub 下载（直连失败自动走 GH_PROXY）
       ├─ 建/更新 Gitee 发行版（正文里的 GitHub 直链换成本站直链）
       └─ multipart 上传附件，回读校验
```

和 GitCode 那套的区别：Gitee 的附件是普通 multipart 直传、同步返回结果，不需要等平台回调；
发行版支持 PATCH / DELETE，正文能改、附件能重传；同一 tag 重复发版也不会报错。

## 一次性配置

| 事项 | 位置 | 说明 |
| --- | --- | --- |
| 生成私人令牌 | gitee.com → 头像 → 设置 → 私人令牌 | 勾选 `projects`（仓库读写）即可 |
| 配 `GITEE_TOKEN` | 仓库 → 管理 → 环境变量 | 名称必须是 `GITEE_TOKEN`，勾选「敏感信息」 |
| 开通 Gitee Go | 仓库 → DevOps → Gitee Go | 每个仓库单独开通；免费额度 1000 核分/月（2C4G ≈ 500 分钟） |
| GitHub 侧配 `GITEE_TOKEN` | GitHub 仓库 → Settings → Secrets | 同名同值，`build.yml` 推代码/tag 时用 |

Gitee 侧可选环境变量：`GITHUB_TOKEN`（提高 GitHub API 限流额度）、`GH_PROXY`（如 `https://ghfast.top/`，GitHub 直连慢时用）、`MAX_SYNC`（单轮补几个版本，默认 1）。

## 发版流程

1. GitHub → Actions → **Build** → Run workflow：
   - `release_tag` 留空 = 测试版（只更新 GitHub 的 `latest`，不同步到 Gitee）
   - `release_tag` 填 `v5.1.0` = 正式版
2. 构建约 20 分钟，产物进 GitHub Release，随后把 tag 推到 Gitee。
3. Gitee 收到 v* tag 自动跑同步流水线，约 5–10 分钟把发行版和三个附件放上去。
4. 失败就在 Gitee Go 页面点「运行」重跑，已上传的附件会按体积跳过，只补缺的。

## 限额（重要）

| 限制 | 数值 | 影响 |
| --- | --- | --- |
| 单个附件 | 100MB | GUI 包约 70MB，安全；脚本上传前会先检查，超了直接报错 |
| 仓库附件总量 | 1GB | 每个版本约 130MB，大约 7 个版本就满，旧版本需要手动删 |
| 构建额度 | 1000 核分/月 | 按 tag 触发时一个月几次，消耗可忽略；别改成每小时轮询 |

## 故障排查

| 现象 | 原因 / 处理 |
| --- | --- |
| 流水线没被触发 | 确认 `.workflow/sync-release.yml` 在默认分支上；Gitee Go 是否已开通；也可以直接在页面点「运行」 |
| `缺少 GITEE_TOKEN` | 环境变量没配或名字不对（区分大小写） |
| `推送到 Gitee 失败`（GitHub 侧） | GitHub Secrets 里的 `GITEE_TOKEN` 无效或没有该仓库写权限 |
| 上传 403 / 401 | 令牌权限不足，重新生成时勾上 `projects` |
| 上传报超过 100MB | 包体超限，需要瘦身或分卷；脚本已在上传前拦截 |
| 附件页看不到文件但日志成功 | 刷新页面；脚本上传后会回读 `/releases/tags/{tag}` 校验，日志里会打印实际附件数 |
| 正文还是旧的 | 现在支持 PATCH，重跑就会更新正文 |

## 已知限制

- 只同步正式版（`v*`、非 draft、非 prerelease），`latest` 测试版只留在 GitHub。
- Gitee 上需要已有该 tag：由 `build.yml` 推送；如果 Gitee 上缺 tag 可以设 `GITEE_TARGET_BRANCH` 让接口建 tag。
- 仓库附件总量 1GB 是硬上限，长期要定期清理旧版本。
