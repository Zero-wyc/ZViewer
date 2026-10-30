# GitCode Release 附件为什么只剩 source code（归档）

> **现状**：正式发版已改走独立产物仓库 `Zero-wyc/ZviewerRelease`（`build.yml` 的 `publish-branch` job），
> 客户端从 `api.gitcode.com/.../raw/<文件>?ref=main` 取清单与安装包，不再依赖 GitCode Release 附件。
> `scripts/sync-gitcode-release.mjs` 与 `gitcode-repair.yml` 均已移除。本页只留当年的结论，供排查历史版本时参考。

## 结论

v5.0.2 ~ v5.0.6 在 GitCode 上只剩 4 个源码包，但 Actions 是绿的。原因是旧脚本把「列表里出现同名条目」
当成上传成功，而 GitCode 的附件上传是两步：

1. `GET /releases/{tag}/upload_url?file_name=x` 拿华为云 OBS 预签名地址；
2. `PUT` 到该地址，**由 OBS 回调 `api.gitcode.com` 把附件登记进 Release**。

对象存储写入和第 1 步的记录会先出现，回调落库（写 `id` / `size`）是最后一步。旧判据把中间态当成成功，
job 变绿，半登记记录随后被平台回收——用户看到的就是「绿着但只有源码」。

## 判据

真正挂上的附件一定带 `type=attach` + 数字 `id` + `size`；源码包三者都没有。

```bash
curl -s "https://api.gitcode.com/api/v5/repos/Zero-wyc/ZViewer/releases/<tag>" \
  | python3 -c "import json,sys; [print(a['type'], a['name'], a.get('size')) for a in json.load(sys.stdin)['assets']]"
```

要看到 3 条带 size 的 `attach` 才算数。

## 顺带排除

| 猜测 | 结论 |
| --- | --- |
| 文件太大被拒 | 官方口径单文件 2 GB，37 MB 的包不触发 |
| `attach_files` 直传 | `POST` 返回 404，只有 `DELETE` / `GET` 存在，必须走 OBS 两步 |
| `temp_download_url=false` 藏附件 | 加不加返回值一致 |
| tag 用 `latest` 撞别名 | 已在 GitCode 侧改用 `dev` 规避 |
