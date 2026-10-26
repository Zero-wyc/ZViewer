# 组件库（public/）

这里放桌面 GUI 的**可选组件**，不是网页静态资源。仓库同步到 GitCode 后，桌面端直接按下面的
仓库直链下载，图省事也顺便解决了国内访问 GitHub 慢的问题。

| 文件 | 版本 | 用途 |
| --- | --- | --- |
| `cloudflared-windows-amd64.exe` | 2026.10.3 | Cloudflare Tunnel（`一键启动隧道`） |
| `easytier-windows-x86_64-v2.6.4.zip` | 2.6.4 | EasyTier 虚拟组网（官方原包，安装时只解出 core/cli 与两个驱动） |
| `LICENSE-EasyTier.txt` | — | EasyTier 是 LGPL-3.0，随二进制一起分发 |

## 下载地址

桌面端用的是 **api/v5 的 raw 端点**：

```
https://api.gitcode.com/api/v5/repos/Zero-wyc/ZViewer/raw/public/<文件名>?ref=main
```

**不要**换成 `https://raw.gitcode.com/Zero-wyc/ZViewer/raw/main/<文件名>`：那是站点的「预览」通道，
除 README/LICENSE 一类被预览过的文档外一律返回 `403 暂不支持预览`，exe/zip 永远下不到。
api/v5 这个端点按字节返回（`application/octet-stream`，支持 Range），55 MB 的 cloudflared 实测可下。

## 为什么不打进分发包

GUI 运行包只带壳、后端、网页、FRP 与 CLI。Cloudflare 与 EasyTier 都属于「很多人用不到」的组件，
放进包里会让每个用户都多下 88 MB。现在它们在首次使用对应功能时下载，装好后保存在运行包里：

- `cloudflared.exe` → 运行包根目录
- `easytier-core.exe` / `easytier-cli.exe` / `Packet.dll` / `WinDivert64.sys` / `wintun.dll` → `runtime/mesh/`

## 升级组件

1. 跑 `desktop/scripts/fetch-components.ps1`（按脚本里钉死的版本与 SHA-256 下载到本目录）；
   升版本时先改脚本里的版本号和摘要。
2. 同步 `desktop/controller/components.go` 里的 `Version` / `Size` / `SHA256`。
3. 跑 `cd desktop && go test ./controller -run Component`：常量与真实文件不一致会直接失败。
4. 提交后等仓库同步到 GitCode，`ref=main` 的直链即刻生效。

桌面端会校验 SHA-256，不认识的文件不会被装进运行包；镜像不可达时逐个回退到上游官方地址。
