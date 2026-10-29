# GitCode Release 只有 source code 的定位与修复

## 现象

`https://gitcode.com/Zero-wyc/ZViewer/releases` 里 v5.0.2 ~ v5.0.6 每个版本都只有 4 个自动生成的
源码包（`*.zip` / `*.tar.gz` / `*.tar.bz2` / `*.tar`），构建产物一个都没有；而对应的 GitHub Actions
运行是**绿色**的，脚本自己回读也认为「3 个附件都传上去了」。

## 定位过程

### 1. 先确认「附件」在 GitCode 上长什么样

拿一个正常发布附件的仓库对照（`hust-open-atom-club/atomgit-cli`）：

```bash
curl -s "https://api.gitcode.com/api/v5/repos/hust-open-atom-club/atomgit-cli/releases/tags/v0.3"
```

```json
{ "type": "source", "name": "v0.3.zip", "browser_download_url": "https://raw.gitcode.com/.../-/archive/..." }
{ "type": "attach", "name": "ag_linux_amd64.tar.gz", "id": 115455,
  "size": 3166908, "browser_download_url": "https://gitcode.com/.../releases/download/v0.3/..." }
```

结论：**真正挂上的附件一定带 `type=attach` + 数字 `id` + `size`**；源码包没有 `id`、没有 `size`。

再查本仓库：

```bash
curl -s "https://api.gitcode.com/api/v5/repos/Zero-wyc/ZViewer/releases/v5.0.6"
```

`assets` 里 4 条全是 `type=source`，没有任何 `type=attach` —— 说明产物确实没留在 Release 里。

### 2. 旧脚本为什么判断错了

旧的 `scripts/sync-gitcode-release.mjs` 判定成功的条件是：

```js
const attachmentsOf = (release) => (release?.assets || []).filter((a) => a.type !== 'source');
const isAttached = async (name) => attachmentsOf(await getRelease()).some((a) => a.name === name);
```

即「列表里出现同名条目」就算成功。但 GitCode 的上传是两步：

1. `GET /releases/{tag}/upload_url?file_name=x` 拿华为云 OBS 预签名地址；
2. `PUT` 到该地址，**由 OBS 回调 `api.gitcode.com` 把附件登记进 Release**。

第 2 步的对象存储写入和第 1 步签发的记录都可能先出现，而回调落库（写 `id` / `size`）是最后一步。
旧判据把「记录已出现、回调未完成」的**中间态**当成了成功，于是 job 变绿；这类半登记记录随后被平台回收，
用户看到的就是「只剩 source code」。这也解释了 v5.0.5 那次「绿了、几小时后附件没了」。

### 3. 顺带排除的几种猜测

| 猜测 | 结论 |
| --- | --- |
| 文件太大被拒 | 官方口径是**单文件上限 2 GB、总量不限**，37 MB 的包不触发 |
| `attach_files` 直传接口 | `POST /releases/{tag}/attach_files` 返回 `404 Route Not Found`，只有 `DELETE`/`GET` 存在，必须走 OBS 两步上传 |
| `temp_download_url=false` 把附件藏起来 | 对同一仓库加不加这个参数返回值一致，无影响 |
| tag 叫 `latest` 撞上「最新版本」别名 | 旧脚本已规避（GitCode 侧 main 分支用 `dev`） |

## 改了什么

### `scripts/sync-gitcode-release.mjs`

上传后的判定从「名字在列表里」升级为**三重核验**，任一条不过就换一张新的预签名地址重传：

1. Release 里出现同名 `type=attach` 条目，且带数字 `id`；
2. 该条目 `size` 与本地文件字节数**完全一致**（缺失或为 0 视为未登记）；
3. 走一遍 `GET /releases/{tag}/attach_files/{name}/download`（`Range: bytes=0-64KB`）拿到真实响应，
   `Content-Range` / `Content-Length` 的总字节数要对得上。

配套改动（参考 `space-ast/action-git-release` 的实现）：

- 单次上传不设 socket 空闲超时，只保留「10 分钟无进展」的停滞检测（内置 fetch 的 300 s `headersTimeout`
  会在跨境慢链路上把 37 MB 的包掐断）；
- `PUT` 返回 400/405 时回退成 multipart `POST` 再试一次；
- 读 Release 时先试官方文档形式 `/releases/tags/{tag}`，404 再回退 `/releases/{tag}`；
- `NO_RECREATE=1` 时先核验，**已在且可用**的附件直接跳过，不重复消耗跨境带宽（修复场景用）；
- 只有「本次新建 + 一个附件都没核验通过」才删空壳 Release（旧的判断用「列表里有几条」，会把半登记记录算进去）；
- 修掉 `VERIFY_MINUTES` 空值被 `Number('')` 变成 0、凭空多跑一次回读的小问题。

### `.github/workflows/gitcode-repair.yml`（新增）

一键补附件，不重新构建：从 GitHub 同名 Release 下载 `zviewer-*` 产物，用 `NO_RECREATE=1`
补传到 GitCode 并核验。历史上那 5 个版本可以用它补，以后哪个 Release 又只剩源码包也用它。

## 怎么用

本次改动只新增文件、不碰 `build.yml`（当前主线已经切到 Gitee 方案，GitCode 同步不再
跟着发版自动跑）。历史版本和今后的 GitCode Release 一律用修复 workflow 补：

1. 在仓库 secrets 里配置 `GITCODE_TOKEN`（GitCode → 设置 → 私人令牌，需要 releases 写权限）；
2. Actions → **GitCode Release 附件修复** → Run workflow：
   - `tag` 填 `v5.0.6` 这类 GitCode 上的 tag（`dev` 对应 GitHub 的 `latest`）；
   - `github_tag` 留空表示与 `tag` 相同；`prerelease` 填 `1` 表示 GitCode 侧标预发布；
3. job 会从 GitHub 同名 Release 下载 `zviewer-*` 产物 → `NO_RECREATE=1` 补传缺失附件 →
   三重核验，任何一个附件没核验通过 job 就变红。

以后发新版想让 GitCode 跟着出 Release，同样跑一次这个 workflow 即可（产物取自刚发布的
GitHub Release，不重新构建）；或者把脚本一行接入 `release` job：

```yaml
- name: Publish to GitCode
  if: env.GITCODE_TOKEN != ''
  env:
    TAG: ${{ needs.prepare.outputs.tag }}
    RELEASE_NAME: ${{ needs.prepare.outputs.tag }}
    RELEASE_BODY_FILE: release_body.md
    VERIFY_DOWNLOAD: '1'
    UPLOAD_ATTEMPTS: '3'
    ASSETS: >-
      zviewer-linux-x64.tar.gz
      zviewer-windows-x64.zip
      zviewer-windows-x64-GUI.zip
  run: node scripts/sync-gitcode-release.mjs
```

## 怎么确认

```bash
curl -s "https://api.gitcode.com/api/v5/repos/Zero-wyc/ZViewer/releases/v5.0.6" \
  | python3 -c "import json,sys; [print(a['type'], a['name'], a.get('size')) for a in json.load(sys.stdin)['assets']]"
```

要看到 3 条 `attach`（带 size），才是真的修好了；只有 `source` 说明核验环节会拦下并让 job 变红，
不会再出现「绿着但页面只有源码」。
