# ZViewer Windows 桌面控制台

Go + WebView2 原生壳（Wails v2），用来管理 Windows 上的 ZViewer 运行包，业务仍在网页端。分发包只有一个 `ZViewerDesktop.exe`，无 Electron、不需要装运行时。

## 功能

| 能力 | 说明 |
| --- | --- |
| 托盘与单实例 | 关窗驻留托盘；同一用户再次双击只唤回已有窗口 |
| 进程托管 | 启停后端、LiveKit、ZViewerCLI；首次启动缺库自动 `--init-db`（`root` / `root`，登录后改） |
| 端口与 HTTPS | 端口可改并持久化；可为 localhost 签发证书 |
| 外网访问 | IPv6 直连、服务商 FRP、自建 FRP（导出 `frpc.toml`）、EasyTier 虚拟组网、Cloudflare Tunnel |
| 高画质代理 | 内置 ZViewerCLI，默认 `9333`，仅监听 `127.0.0.1`，扫码登录，可随服务启动 |
| 按需组件 | cloudflared、frpc、EasyTier、LiveKit 首次使用对应功能时下载 |
| 自动更新 | 启动 6 秒后检查一次，此后每 6 小时；流式下载 + 结构校验 + 覆盖重启 |
| 日志 | 按 voice / tunnel / cli / update 分类、级别、关键字过滤，界面留最近 500 条 |

隧道与 IPv6 的实现约定见 [IMPLEMENTATION-CLOUDFLARE-TUNNEL.md](IMPLEMENTATION-CLOUDFLARE-TUNNEL.md)。

## 目录

| 位置 | 内容 |
| --- | --- |
| `ZViewerDesktop.exe` | GUI 入口 |
| `assets/ZViewer.ProcessHost.exe` | 进程监管宿主 |
| `runtime/` | 后端、LiveKit、CLI、网页；组件也下载到这里 |
| `runtime/.env`、`runtime/config` | 后端环境与业务数据 |
| `%APPDATA%/ZViewerDesktop` | GUI 设置、证书、FRP 凭据、日志 |
| `%USERPROFILE%/.zviewer/config.json` | ZViewerCLI 登录配置 |

整个文件夹可直接复制移动，无需安装。更新前退出控制台并备份 `.env`、`config` 与用户配置目录。

## 构建

需要 Go 1.26+、Node.js 22+、Python 3.11+（打包）与系统自带 C# 编译器（编进程监管宿主）。

```powershell
node build-all.js --win               # 先生成 Windows 运行包
npm --prefix desktop run shell:build  # build/bin/ZViewerDesktop.exe（--console 看日志）
npm --prefix desktop run shell:dist   # dist-gui/
npm --prefix desktop run package      # ZIP + SHA256
```

界面文件由 `go:embed` 编进 EXE，改 `ui/` 后需重新编译（调试可用 `npm --prefix desktop run preview`）。检查：`cd desktop && go vet ./... && go test ./...`。

产物结构（分发保留整个文件夹）：

```text
zviewer-windows-x64-GUI/
  ZViewerDesktop.exe                # 唯一启动入口
  assets/ZViewer.ProcessHost.exe    # 进程监管宿主
  runtime/                          # 后端、LiveKit、CLI、网页
  许可证、BUILD-MANIFEST.json
```

别直接 `cd desktop && go build -tags production .`，会覆盖已入库的 `desktop/desktop.exe`。

## 第三方组件

| 组件 | 版本 | 许可证 | 位置 |
| --- | --- | --- | --- |
| [frp](https://github.com/fatedier/frp) 客户端 | 0.71.1 | Apache-2.0 | 按需下载到 `runtime/frpc.exe` |
| [EasyTier](https://github.com/EasyTier/EasyTier) | 2.6.4 | LGPL-3.0 | 按需下载到 `runtime/mesh/` |
| [ZViewerCLI](https://github.com/Zero-wyc/ZViewerCLI) | 0.2.1 | MIT | 随包 `runtime/zviewer-cli-windows-amd64.exe` |
| [LiveKit](https://github.com/livekit/livekit) server | 1.13.7 | Apache-2.0 | 按需下载到 `runtime/livekit-server.exe` |

均为原样分发的未修改二进制，各自保留许可证：frp / EasyTier 在 `assets/LICENSE-*.txt`，LiveKit 与 CLI 随 `runtime/` 分发。贡献内容只含源码、图标、构建脚本与文档。
