# ZViewer Windows 桌面控制台

原生桌面壳（Go + 系统 WebView2 / Wails v2），用来管理 Windows 上的 ZViewer 运行包，业务仍在网页端。

支持系统托盘、端口配置持久化、localhost HTTPS、自建 FRP、EasyTier 虚拟组网（免 TUN）与 ZViewerCLI 高画质代理。
分发目录里只有一个 `ZViewerDesktop.exe`，不需要安装运行时，也没有 Electron 与 Node。

隧道与 IPv6 的实现约定和验收方式见 [IMPLEMENTATION-CLOUDFLARE-TUNNEL.md](IMPLEMENTATION-CLOUDFLARE-TUNNEL.md)。

## 目录与启动

双击 `ZViewerDesktop.exe` 打开控制台，服务和代理由界面按钮启动（也可沿用已保存的自动启动偏好）。
首次启动服务时若数据库不存在，会先调后端 `--init-db` 建库，初始管理员 `root` / `root`，登录后立即修改。
同一 Windows 用户只运行一个实例，再次双击会唤回已有窗口。

| 内容 | 位置 |
| --- | --- |
| GUI 入口 | `ZViewerDesktop.exe` |
| 进程监管宿主 | `assets/ZViewer.ProcessHost.exe` |
| 后端、LiveKit、FRP、CLI 与网页 | `runtime/` |
| EasyTier 组件 | `runtime/mesh/`（首次组网时下载） |
| Cloudflare 组件 | `runtime/cloudflared.exe`（首次启动隧道时下载） |
| 后端环境与业务数据 | `runtime/.env`、`runtime/config` |
| GUI 设置、证书、FRP 凭据、日志 | `%APPDATA%/ZViewerDesktop` |
| ZViewerCLI 登录配置 | `%USERPROFILE%/.zviewer/config.json` |

整个文件夹可直接复制移动，无需安装。更新前退出控制台并备份 `.env`、`config` 与用户配置目录。
当前 EXE 未做代码签名，普通用户权限即可运行，不创建系统服务、不改防火墙。

## 高画质代理（ZViewerCLI）

内置 [ZViewerCLI](https://github.com/Zero-wyc/ZViewerCLI) 0.2.1，落在 `runtime/zviewer-cli-windows-amd64.exe`。

1. 侧栏「高画质代理」→ 后端地址自动跟随本地服务，可填网页账号（可选），代理端口默认 `9333`，仅监听 `127.0.0.1`。
2. 点「启动代理」，右侧打开 CLI 内置设置，后端地址与账号已带入。
3. 用官方二维码登录 → 连接服务器 → 回网页端使用高画质代理。

可单独启停、保存端口、勾选「随服务启动」（默认关闭）。扫码与 Cookie 都由内置 CLI 处理，控制层不接触 Cookie。

## 连接方式

侧栏「连接方式」列出五种外网访问方式，按需选一种。

| 方式 | 要点 |
| --- | --- |
| IPv6 直连 | 需监听「所有地址 · IPv4 + IPv6」，用 HTTPS 还要按 IPv6 签发证书；外部检测只验证出口，不保证入站可达 |
| 服务商 FRP | 樱花、OpenFrp、cpolar、ngrok，把服务器地址 / 端口 / 密钥填进「高级 → FRP 穿透」 |
| 自建 FRP | 自己的 VPS 跑 frps，控制台生成并导出 `frpc.toml` |
| EasyTier 虚拟组网 | 本机加入虚拟网络，其他设备按虚拟 IP 访问 |
| Cloudflare Tunnel | 一键启动快速隧道，无需账号与配置；固定域名需命名隧道 |

## Cloudflare Tunnel

点蓝色「一键启动隧道」：先检查本机 `/health`，再按需下载 `cloudflared`，用 HTTP/2 建立到 Cloudflare 的连接，
等地址分配与连接注册完成后做公网健康检查，连续两次命中同一服务才显示地址。

- 「获取源」可选 GitCode 镜像（默认，`ZviewerRelease` 的 `components` 分支）、GitHub 官方、GitHub 前置反代。
  镜像不可用时自动回退官方，原因记在 `tunnel` 日志；改动下次启动或刷新隧道生效，与软件更新源互不影响。
- 失败最多自动刷新 5 次（共 6 个候选），期间可随时中断。成功后保持地址，断线交给 cloudflared 在原地址重连。
- 组件下载只在连续 1 分钟无响应时中断，超时会提示检查网络或换源。

## EasyTier 虚拟组网

侧栏「高级 → EasyTier 虚拟组网」，首次进入点「下载组网组件」获取 EasyTier 2.6.4（约 33 MB，落在 `runtime/mesh/`）。
运行时用 `no_tun`，不需要管理员权限、不建虚拟网卡。

1. 需要一组网络名 + 网络密钥，点「生成新的网络名与密钥」自动填好，把「入网说明」发给对方。
2. 双方都在 NAT 后时需要中转节点，在「对端地址」填一台双方都能连的（如 `tcp://1.2.3.4:11010`）；
   也可以点「测试可用性」→「填入最快节点」用社区公共节点。局域网内直连可留空或填对方局域网地址。
3. 对方装官方 EasyTier 客户端，填同样的网络名与密钥，访问 `http://<虚拟IP>:3333/`。

已有 TOML 配置时切到「配置文件」粘贴或导入，保存在 `<数据目录>\mesh\mesh.custom.toml`。
组网密钥由 DPAPI 加密存 `settings.json`。组网节点独立于主服务，只停主服务不会让它退出。

## 自建 FRP

包内只带客户端 `frpc` 0.71.1，不含 `frps`。填 VPS 地址、控制端口、密钥，在 VPS 上部署同版本 frps 并导入导出的 TOML。

- 外网语音要填 VPS 公网 IPv4 作为公布地址并重启服务；远端 UDP / TCP 端口需与本地语音端口一致。
- 「FRP 穿透」页支持「图形配置」与「配置文件」两种，后者可粘贴任意 frpc 配置或导入 `.toml` / `.yaml` / `.json`，
  连接前会跑一次 `frpc verify -c`。

## 软件更新

侧栏「检查更新」，启动 6 秒后自动检查一次，此后每 6 小时，可在弹窗里关闭。

- 读 GitHub Release 的最新正式版，预发布不参与；可开「使用前置反代」（默认 `https://gh-proxy.com`）。
- 下载流式写入 `updates/<版本>/`，完成后核对大小与 ZIP 结构；点「重启并安装」由脚本解压覆盖运行目录并重启。
- 运行目录必须可写，放 `Program Files` 会覆盖失败。

日志在用户配置目录 `logs`，按来源（`voice` / `tunnel` / `cli` / `update`）、级别、关键字过滤，界面保留最近 500 条。

## 从源码构建

需要 Go 1.26+、Node.js 22+、Python 3.11+（打包）、系统自带 C# 编译器（编进程监管宿主）。

```powershell
node build-all.js --win               # 先生成 Windows 运行包
npm --prefix desktop run shell:build  # 输出 build/bin/ZViewerDesktop.exe
npm --prefix desktop run dev          # 开发：编译 + 独立配置目录 + 带日志启动（F12 开 DevTools）
npm --prefix desktop run preview      # 只调界面，浏览器预览 http://127.0.0.1:17839
npm --prefix desktop run shell:dist   # 输出 dist-gui/
npm --prefix desktop run package      # 出 ZIP
```

界面文件由 `go:embed` 编进 EXE，改 `ui/` 后要重新编译；`preview` 可刷新即见。
`.github/workflows/build.yml` 的 `build-gui` job 走的正是这条链路。

产物结构（分发时保留整个文件夹）：

```text
zviewer-windows-x64-GUI/
  ZViewerDesktop.exe                # 唯一用户启动 EXE
  assets/ZViewer.ProcessHost.exe    # 进程监管宿主
  runtime/                          # 后端、LiveKit、FRP、CLI 与网页
  许可证、BUILD-MANIFEST.json
```

输出已存在时拒绝覆盖。在分发包里跑过之后再打包，会因为出现 `runtime/.env` 或 `runtime/config` 被拒——清理运行数据或重新 `shell:dist` 即可。

源码检查：

```powershell
cd desktop; go vet ./...; go test ./...
npm --prefix desktop run check
```

## 第三方组件

| 组件 | 版本 | 许可证 | 位置 |
| --- | --- | --- | --- |
| [frp](https://github.com/fatedier/frp) 客户端 | 0.71.1 | Apache-2.0 | `runtime/frpc.exe` |
| [EasyTier](https://github.com/EasyTier/EasyTier) | 2.6.4 | LGPL-3.0 | 可选组件，下载到 `runtime/mesh/`，源码见上游 `v2.6.4` |
| [ZViewerCLI](https://github.com/Zero-wyc/ZViewerCLI) | 0.2.1 | MIT | `runtime/zviewer-cli-windows-amd64.exe` |
| [LiveKit](https://github.com/livekit/livekit) server | 见运行包 | Apache-2.0 | `runtime/livekit-server.exe` |

均为原样分发的未修改二进制，各自保留许可证文件。

贡献内容只包含源码、图标、构建脚本与文档；不要提交本机配置、登录资料、数据库、证书私钥、运行时与分发二进制。
