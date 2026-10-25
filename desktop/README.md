# ZViewer Windows 桌面控制台

原生桌面控制台，管理现有 Windows 运行包，保留服务端网页。壳层是 Go + 系统 WebView2（Wails v2），分发目录只有一个 `ZViewerDesktop.exe`，不需要安装运行时，也没有 Electron。支持系统托盘、端口配置持久化、localhost HTTPS、自建 FRP、EasyTier 虚拟组网（免 TUN）和 ZViewerCLI 哔哩哔哩高画质代理；CLI 设置、扫码登录与连接操作直接在窗口右侧完成。

## 双击打开 GUI

双击运行目录中的 `ZViewerDesktop.exe`，直接显示控制台窗口。默认只打开界面；服务、代理和浏览器由用户在界面内点击按钮启动，也可沿用已保存的自动启动偏好。

首次点击启动服务时，若目标数据库文件不存在，控制台会先调用后端的 `--init-db` 建库并创建管理员，再启动服务。本机窗口会提示初始管理员账号和随机密码；请先保存，登录后修改密码，密码不会写入运行日志。已有数据库（包括空文件或结构异常的文件）不会被初始化或覆盖；从旧版升级时沿用原 `config/`，并核对 `CONFIG_DIR` / `DATABASE_URL`。初始化失败会显示实际错误；后端提前退出也会显示退出码，不再统一提示等待 45 秒。

同一 Windows 用户只运行一个正常实例。再次双击入口会恢复并聚焦已打开的窗口，最小化或收在托盘时也会唤回，不创建第二套受管服务。整个文件夹可复制、可移动，无需安装步骤，也不把运行包搬进用户缓存目录。

侧栏顶部的“ZViewer 运行状态”卡片显示主服务状态：绿点为运行中（并显示监听端口），红点为未启动或启动失败；右侧按钮可直接启动或停止服务，与服务总览使用同一套启停逻辑。

| 内容                     | 位置                                       |
| ---------------------- | ---------------------------------------- |
| GUI 入口                 | 运行目录中的 `ZViewerDesktop.exe`              |
| 进程监管宿主                 | 同目录 `assets/ZViewer.ProcessHost.exe`     |
| 后端、LiveKit、FRP、CLI 与网页 | `runtime/` 内的程序与 `runtime/frontend/dist` |
| EasyTier 虚拟组网组件          | `runtime/mesh/`（easytier-core / easytier-cli） |
| 后端环境与业务数据              | `runtime/.env`、`runtime/config`          |
| GUI 设置、证书、FRP 凭据与日志    | `%APPDATA%/ZViewerDesktop`               |
| ZViewerCLI 自身的登录配置     | `%USERPROFILE%/.zviewer/config.json`     |

更新前先退出控制台并备份运行目录的 `.env`、`config` 和用户配置目录。替换程序时保留这些数据，不要把配置或数据库当作分发文件。当前 EXE 未配置代码签名，普通用户权限即可运行，不创建系统服务或修改系统防火墙。

## 高画质代理 · ZViewerCLI

内置 [Zero-wyc/ZViewerCLI](https://github.com/Zero-wyc/ZViewerCLI) 0.2.1。CLI 二进制跟着单文件运行包走：`build-all` 把 `frontend/public/zviewer-cli-windows-amd64.exe` 复制到 `dist/win/frontend/dist/`，桌面打包直接取这一份复制进 `runtime/`（网页「下载 CLI」与单文件版用的也是它）。只检查文件是否存在，不校验摘要；缺失时 `shell:dist` 直接报错，不会去源码重建。那份是发布版（UPX 压缩），不含桌面专属改动；需要在分发包里启用桌面嵌入式主题与本地配置接口来源保护（`desktop/patches/`）时，先执行 `node scripts/prepare-cli.mjs --publish` 重建并同步回 `frontend/public/`，再 `node build-all.js --win` 刷新运行包。

1. 在侧栏进入“高画质代理”，查看只读的“后端地址 · 自动跟随本地服务”。网页账号为可选项，填写并保存与网页端一致的账号有助于识别代理归属；也可按需调整默认代理端口 `9333`。代理仅监听本机 `127.0.0.1`。
2. 点击“启动代理”，右侧直接显示 CLI 自带的内置设置，自动填写后端地址。如已保存网页账号，也会一同带入；账号留空仍可配置。
3. 在右侧使用官方二维码登录，再点击连接服务器，然后回到 ZViewer 网页端使用高画质代理。

后端运行时使用当前实际协议和端口；尚未运行时使用已保存的服务配置。例如服务正在 `http://localhost:33331/` 运行，内置设置就会填写该地址。只保存了新端口但还没重启服务时，继续使用当前实际运行地址。

GUI 提供独立启动、停止、端口保存和“随 ZViewer 服务启动”滑块；自动启动默认关闭。修改端口后，下次启动代理生效，不能与其他 TCP 服务端口重复。“运行中”表示受管代理进程和本机健康检查就绪。

扫码、Cookie 校验与服务器连接由用户在内置的官方 CLI 设置中完成；如填写了可选归属账号，GUI 将保存值传入。控制层不调用 `/api/config` 获取 Cookie，也不通过进程参数或日志传递 Cookie。`%USERPROFILE%/.zviewer/config.json` 保留，由 CLI 继续管理其登录配置。当前上游 CLI 不持久化服务器地址与网页账号绑定，重启代理后需要在内置设置中重新连接；GUI 会再次带入本机服务器地址和已保存的可选网页账号。

关闭窗口仍可留在托盘运行。选择托盘“退出并停止受管服务”时，控制台会停止自己启动的 CLI、FRP、后端和 LiveKit，不接管用户另行启动的 CLI。

## 从源码构建

Windows x64 需要 Go 1.26 或更新版本、Node.js 22 或更高版本、Python 3.11+（打包用），以及系统 .NET Framework 4.x 自带的 C# 编译器（编译进程监管宿主）。首次准备 CLI 需要联网下载源码、工具链和依赖。在完整上游源码仓库先生成 Windows 运行包，再构建桌面程序：

```powershell
node build-all.js --win
npm --prefix desktop run shell:build
```

产物为 `desktop/build/bin/ZViewerDesktop.exe`。开发期用 `dev` 脚本，一条命令完成「编译 + 独立配置目录 + 带日志启动」：

```powershell
npm --prefix desktop run dev
```

它等价于 `build-shell.mjs --dev --console` 后运行 EXE：`-tags desktop,production,devtools` 保留 Wails 生产运行时但打开 WebView2 DevTools，默认用 `desktop/.runtime/dev-state` 作为配置目录，日志与 panic 输出直接回到当前终端，窗口内按 F12 或右键「检查」打开开发者工具。开关：`--no-build` 跳过编译直接跑已有 EXE，`--state-dir=<目录>`、`--runtime-root=<运行包>` 覆盖默认路径。开发实例与正式版共用单实例锁，正式版在运行时先退出它。

只调界面样式可以不开壳，跑浏览器预览（走演示态，不接 Go）：

```powershell
npm --prefix desktop run preview   # http://127.0.0.1:17839
```

界面文件由 `go:embed` 编进 EXE，改 `ui/` 后必须重新编译才能在壳里看到，浏览器预览可以刷新即见。

生成可分发目录与 ZIP：

```powershell
npm --prefix desktop run shell:dist   # 取运行包（含 dist/win/frontend/dist 里的 CLI）装壳
npm --prefix desktop run package      # 打包成 ZIP
```

CLI 固定落在 `runtime/zviewer-cli-windows-amd64.exe`（壳只从运行包里找它），来源是 `dist/win/frontend/dist/zviewer-cli-windows-amd64.exe`。只检查它是否存在，不校验摘要；缺失时 `shell:dist` 直接报错——先确认 `node build-all.js --win` 生成了完整运行包（CLI 由 `frontend/public/` 随前端产物复制过去）。

`.github/workflows/build.yml` 的 `build-gui` job 跑的就是这条链路：取 Windows 运行包 → `npm run shell:dist` → `npm run package`，产物作为 `zviewer-gui-windows-x64` artifact 与单文件版一起进 Release。

`shell:dist` 输出 `desktop/dist-gui/zviewer-windows-x64-GUI`，与命令行包同名、仅追加 `GUI`；`package` 打出同名的 `zviewer-windows-x64-GUI.zip`。结构如下（分发或移动时保留整个文件夹）：

```text
zviewer-windows-x64-GUI/
  ZViewerDesktop.exe                # 唯一用户启动 EXE
  assets/ZViewer.ProcessHost.exe    # 进程监管宿主（Job Object）
  runtime/                          # 后端、LiveKit、FRP、CLI 与网页
  许可证、BUILD-MANIFEST.json
```

包内不放使用说明，操作引导由 GUI 内的教程页提供；本文件只随源码仓库维护。

输出已存在时拒绝覆盖，避免破坏已有产物。构建只复制指定程序、网页、许可证和来源记录，不复制真实 `.env`、数据库、证书或登录配置。在分发包里直接运行过之后再打包，`package-release.py` 会因为出现 `runtime/.env` 或 `runtime/config` 而拒绝——这是有意设计，清理运行数据或重新 `shell:dist` 即可。

运行包位置按 `--runtime-root=` / `ZVIEWER_RUNTIME_ROOT` / 可执行文件周边（`runtime/`、`dist/win`、上溯三层）顺序探测；配置目录按 `--state-dir` / `ZVIEWER_STATE_DIR` / `%APPDATA%\ZViewerDesktop` 探测。更新头像 ICO 可用 Python 与 Pillow 执行 `desktop/scripts/make-icon.py`；ICO 变了以后 `build-shell.mjs` 会按 mtime 用 `rsrc` 重新生成 `rsrc_windows_amd64.syso`（需 `go install github.com/akavel/rsrc@latest`），否则 EXE 沿用旧图标。

调试开关：`ZVIEWER_SHELL_OPAQUE=1` 关闭 Mica 透明（无重定向位图的窗口无法用 GDI 截屏），`ZVIEWER_SHELL_AUTOSTART=1` 启动即拉起本地服务，`ZVIEWER_STATE_DIR` 指定独立配置目录。构建时加 `--console` 可保留控制台窗口以便观察 panic（默认 `-H windowsgui`）。

## 源码检查

```powershell
cd desktop; go vet ./...
npm --prefix desktop run check
```

`npm run check` 只做 JS 语法检查（预览服务器、构建脚本、界面脚本、CLI 补丁）。Go 控制层目前没有自动化测试，改配置校验、证书或端口逻辑时需要手工验证，后续应补 `go test` 覆盖。

## 架构与数据边界

- 三层结构：`ui/`（HTML/CSS/JS，用 `go:embed` 编进二进制）→ `shell_app.go`（绑定层，把 Go 方法映射成 `window.zviewerDesktop`）→ `controller/`（配置、证书、服务编排、进程、网络，纯 Go 无 UI 依赖）。
- 页面启用严格 CSP：`connect-src 'none'`，任何网络请求都必须经绑定方法走控制层；只有内嵌 CLI 设置页通过 `frame-src http://127.0.0.1:*` 放行。
- 后端、LiveKit、FRP、CLI 各自由一个 `ZViewer.ProcessHost.exe` 托管，挂在 Job Object 上；先请求正常退出，超时后只结束自己的进程树，GUI 被强杀时子进程一并回收。
- LiveKit 使用外置模式，UDP 跟随网页端口，信令和 RTC TCP 由控制层下发；随机 API 凭据只存在于内存与子进程环境。
- FRP 密钥使用 Windows DPAPI 保存，导出 TOML 通过环境变量读取；私钥留在当前用户配置目录。DPAPI 密文格式与旧版本一致，历史 `settings.json` 可直接沿用。
- HTTPS 使用本机自签证书，不修改 Windows 证书存储，也不提供安装/撤销根证书信任的入口；浏览器首次访问会提示证书不受信任，选择继续访问即可。

## 网页与管理入口

保持整个分发文件夹完整，双击根目录 `ZViewerDesktop.exe` 打开 GUI。

首页“打开网页端”与“启动服务”使用相同按钮样式。点击后会先确保本机服务就绪，再用默认浏览器打开当前 HTTP/HTTPS 和端口对应的首页。首页及证书页的“打开管理页面”继续访问 `/admin`；托盘只保留“打开网页端”网页入口。默认首页 `http://localhost:3333/`，管理页 `http://localhost:3333/admin`。使用文档入口：<https://docx.zviewer.zero251.xyz/> 。

## 端口、配置与托盘

“应用设置”可调整网页、RTMP、HTTP-FLV 端口及网页/信令监听范围。监听范围默认“所有地址 · IPv4 + IPv6”，同时覆盖回环（localhost / 127.0.0.1 / ::1）、局域网 IPv4 与 IPv6，装好即可被同网段设备访问；只想本机使用时改回“仅本机 · 127.0.0.1”（旧版本保存过该值的继续沿用）。首次以“所有地址”启动时 Windows 防火墙可能弹出授权提示，只在本机用可以取消，允许后同网段设备才能访问；回环访问不受防火墙影响。HTTPS 使用独立滑块，点击“保存配置”后才应用。LiveKit UDP 始终跟随网页端口；内部信令固定 3336（与主项目一致，面板只读），RTC TCP 默认 3337，可调整。TCP 端口不可重复，UDP 与网页 TCP 可以使用相同端口号。保存后重启服务生效，下次打开自动恢复。

本机模式启用 UDP 回环监听，使 localhost 与 FRP 的回环转发可达；公布公网地址时保留媒体转发所需的网卡。网页/信令监听范围不限制 LiveKit RTC TCP 的底层网卡监听。程序不修改系统防火墙、路由器、hosts 或 DNS。

正式版配置位于 `%APPDATA%/ZViewerDesktop/settings.json`。FRP 密钥与组网密钥分别由当前用户 DPAPI 加密，换电脑或用户后需重新填写。登录启动默认关闭；入口 EXE 只显示界面，服务由界面按钮启动。

关闭窗口默认收起到系统托盘，头像图标可恢复；右键菜单提供服务启停、打开网页端、日志与退出。第二次启动恢复已有窗口。选择“退出并停止受管服务”会停止受管 CLI、FRP、后端和独立 LiveKit，不按端口强杀其他程序。

## localhost HTTPS 与内网域名

在“证书与域名”点击“签发并启用 HTTPS”，生成包含 localhost、127.0.0.1、::1 的服务器证书，然后打开网页或管理页。桌面端不安装、不撤销系统证书信任：浏览器首次会提示证书不受信任，按提示选择继续访问即可，不会把操作踢回证书页。

签发过证书后仍可切回 HTTP：证书页的“以 HTTP 方式启动”会关闭 HTTPS 并按新协议重启服务，证书保留；需要 HTTPS 时再点一次“签发并启用 HTTPS”即可。

同一页支持按本机 IPv6 签发：先“探测本机 IPv6”，再“按 IPv6 签发并启用 HTTPS”，该地址会加入证书 SAN，之后可用 `https://[IPv6]:端口/admin` 直连（IPv6 字面量必须写成方括号形式）。前提是“应用设置”里网页/信令监听范围选“所有地址 · IPv4 + IPv6”，否则其他设备无法经 IPv6 连入；范围仍是“仅本机”时该地址只有本机能用。

证书与私钥保存在当前用户配置目录的 `tls`，目录权限限制为当前用户和 SYSTEM，服务器证书有效期一年。证书为自签证书，其他设备访问时会提示不受信任，需在该设备上手动信任；证书页的“导出公开 CA”导出根证书 `ZViewer-Local-CA.crt`，供其他设备导入信任。桌面端不写入系统证书存储，禁止分享私钥或整个 `tls` 文件夹。

高级内网模式可填写自定义域名与 IP，加入证书 SAN。域名解析需在访问设备 hosts 或内网 DNS 配置，并开启适合的网页监听范围；其他设备访问时直接忽略证书警告继续访问即可。

## 连接方式

左侧栏“连接方式”集中列出五种外网访问方式，按需选一种即可。

IPv6 直连：打开页面时由程序经外部接口（`v6.ident.me` 等仅解析 AAAA 的地址）查询本机公网 IPv6，不读取本机网卡。接口能通过 IPv6 访问到本机，说明地址可在公网路由；没有公网 IPv6 时显示“没有”。界面给出的是带端口的完整地址（如 `http://[2409:...]:3333/`），复制后可直接粘贴到浏览器。路由器与 Windows 防火墙仍需放行入站端口，程序不修改防火墙与路由器。

服务商 FRP：列出樱花内网穿透、OpenFrp、cpolar、ngrok，注册后把服务商给出的服务器地址、端口与密钥填进“高级 → FRP 穿透”的本机 frpc 配置，不用自建服务器；访问域名、远端端口与带宽由服务商决定。

自建 FRP：自己的 VPS 上运行 frps，本机 frpc 连接该服务器，控制台生成并导出 `frpc.toml`（`frps.toml` 按官方文档在 VPS 上自建）。端口、域名与带宽自管，需自行在安全组与系统防火墙放行映射端口。

虚拟局域网：内置「EasyTier 虚拟组网」（左侧栏“高级 → EasyTier 虚拟组网”），本机直接加入虚拟网络，其他设备按虚拟 IP 访问，详见下一节。

Cloudflare Tunnel：使用 `cloudflared` 的快速隧道，由程序启动并解析其输出的 `trycloudflare.com` 临时地址，停止隧道后地址失效。程序不内置 `cloudflared`，需自行下载后放入运行包目录或加入 PATH，未找到时按钮只提供下载入口。快速隧道地址随机、随会话失效；固定域名请改用 Cloudflare 命名隧道，需要一张外国银行卡。

## EasyTier 虚拟组网

入口在左侧栏“高级 → EasyTier 虚拟组网”。包内自带 [EasyTier](https://github.com/EasyTier/EasyTier) 2.6.4（`runtime/mesh/`），以 `no_tun` 方式运行：不需要管理员权限、不创建虚拟网卡、不需要任何账号。本机加入虚拟网络后，网络内其他设备可以用虚拟 IP 访问本机的网页、推流与语音端口；本机本身不能主动访问其他节点。

组网只需要一组网络名称与网络密钥，两者在同一个网络里必须一致。点“生成新的网络名与密钥”会自动填好并保存，复制“入网说明”发给对方即可。

双方都在 NAT 后面时必须有中转节点，否则彼此发现不了。在“对端地址”里填一台双方都能连到的节点（推荐在自建 VPS 上跑同版本 easytier），例如 `tcp://1.2.3.4:11010`；填一个即可，多行只是备份。同一局域网内不必中转，直接把本机的局域网地址给对方即可。对端地址也可以整个留空：节点照样能启动并监听端口，只是没有其他设备接入前拿不到虚拟 IP。组网监听端口默认 11010，不能在 VPS 与系统防火墙上被占用或拦截。

不想自己搭中转时，用组网页下方的“公共对端服务器”卡片：点“测试可用性”会从本机逐个测到节点的 TCP 连接并给出延迟，点“填入最快节点”会把延迟最低的那个写进“对端地址”。对端地址只负责首次发现，连上一个节点就能拿到整个网络，填一个能连上的就够；多填几个只是给下次启动留备份。候选由社区维护，随时可能下线，也不保证带宽；EasyTier 官方公共节点（`public.easytier.cn` / `.top`）已经停服，不在列表里。默认配置仍然不预填任何地址。

对方的设备需要安装 EasyTier 客户端（Windows / macOS / Android 等官方发行版），填入同样的网络名称与密钥加入网络，然后打开 `http://<虚拟IP>:<网页端口>/`。网页端口就是“应用设置”里的端口，默认 3333。

已经有现成 EasyTier 配置时，在组网页顶部切到“配置文件”，粘贴整份 TOML 或点“导入文件”从磁盘选择，再点“保存并入网”。内容原样保存在 `<数据目录>\mesh\mesh.custom.toml`，不进 `settings.json`；启动时另写一份运行时配置，写入 `no_tun = true` 与 `bind_device = false`，缺 `[flags]` 段时自动追加。这里只接受 TOML。配置文件模式下入网信息全部取自文件，“复制入网说明”也从文件读取；对端写在 `[[peer]]` 段的 `uri` 里（如 `uri = "tcp://1.2.3.4:11010"`），可写多条，没有 `[[peer]]` 段时节点只在本机监听，其他设备发现不了。

组网密钥由当前用户 DPAPI 加密保存在 `settings.json`，与 FRP 密钥互不影响。勾选过“入网”后，打开控制台会自动入网；点“停止组网”会关闭自动入网，虚拟 IP 立即失效。组网节点独立于主服务，只停主服务不会让它退出。组网起不来时界面会给出一句原因（配置无效、端口被占用、缺少驱动文件等），easytier 的原始报错写在“导出日志”里。

## 自建 FRP

包中只带 FRP 客户端 `frpc` 0.71.1（不含服务端 `frps`）。填写 VPS IP/域名、控制端口、密钥，保存后在 VPS 上自行部署同版本 frps，使用导出 TOML 并设置 `FRP_TOKEN` 环境变量。启动本地服务后连接 FRP。传输 TLS 与浏览器网页 HTTPS 分别配置。

外网语音需填写 VPS 公网 IPv4 作为公布地址，并重启服务；远端 UDP 需与当前本地网页/语音 UDP 端口一致，远端语音 TCP 需与当前 RTC TCP 端口一致。网页与信令共用网页入口，无需额外暴露内部信令端口。默认映射随相应本地端口变更，手动设置的其他远端映射保留，请自行放行 VPS 安全组/防火墙。

“代理已注册”只表示 frps 接受代理，不代表跨设备语音、推流或公网访问已完成验收。本机自签证书也不会被外部访问设备自动信任。

## 直接使用 frpc 配置文件

“FRP 穿透”页顶部有“图形配置”与“配置文件”两个入口。切到“配置文件”后可以粘贴任意 frpc 配置，或用“导入文件”读取本机的 `.toml`、`.yaml`、`.yml`、`.json`。

- 内容保存为配置目录下的 `frp/frpc.custom.<扩展名>`，连接时原样交给 frpc，表单不再覆盖它；图形配置生成的 `frpc.toml` 与它互不影响。
- “按图形配置填充”把当前表单参数写成一份 TOML，方便从零开始改；仅在编辑框为空、且格式为 TOML 时可用。
- 密钥可以直接写在配置里；配置用 `{{ .Envs.FRP_TOKEN }}` 读取时，界面里填写的密钥会以环境变量 `FRP_TOKEN` 注入，界面上留空则沿用已保存的密钥。
- 连接前先执行 `frpc verify -c`，失败原因显示在编辑框下方；已连接时修改内容，需要断开再连接才生效。
- 配置文件模式不比对本地服务端口，也不要求填写 VPS 地址；本地服务仍需先启动。

## 软件更新

侧栏底部“检查更新”打开弹窗；启动 6 秒后自动检查一次，此后每 6 小时复检，只检查不下载，可在弹窗里关闭。

- 检查：读取 GitHub Release 的最新正式版，与当前版本按数字段比较；预发布版本不参与，因此 main 分支的 `latest` 预发布不会被提示为更新。
- 前置反代：弹窗里可开“使用前置反代”，把检查和下载都拼在一个前缀式反代后面，默认 `https://gh-proxy.com`，可改成 `https://ghproxy.net` 等服务商，配置项为 `updateProxy` / `updateProxyUrl`。启用时检查请求走 `<前缀>/https://api.github.com/...`，下载首选 `<前缀>/<github.com 直链>`、回退 `api.github.com` 资产端点；反代检查失败会自动退回直连，下载失败也会换回退地址重试一次。只接受 `https://` 前缀，域名会加入下载白名单，未启用时只允许 GitHub 官方域。
- 下载：默认走 `api.github.com` 的资产端点（直连 `github.com` 在部分网络下会超时），流式写入配置目录 `updates/<版本>/`，期间控制台照常可用；下载完成后核对文件大小与 ZIP 结构，通过才标记为待安装。
- 安装：点击“重启并安装”时先在更新目录写好 PowerShell 脚本并启动，再正常退出控制台（受管服务一并停止）；脚本等待本进程结束，解压覆盖运行目录并重新启动 `ZViewerDesktop.exe`。覆盖失败会记入同目录 `apply.log`，此时界面已退出，需要手动处理。
- 运行目录必须可写（便携包默认如此）。放进 `Program Files` 等受保护目录时覆盖会失败，建议解压到用户目录。

## 日志、数据与更新

日志位于用户配置目录 `logs`，按来源、级别、关键字过滤；独立 LiveKit 为 `voice` 来源，Cloudflare Tunnel 为 `tunnel` 来源，高画质代理为 `cli` 来源，软件更新为 `update` 来源。文件达到 2 MB 后滚动，界面保留最近 500 条，已知敏感值脱敏。

首次启动新运行包时生成独立随机 JWT 密钥，分发版后端数据留在 `runtime/config`，环境配置位于 `runtime/.env`。更换版本前保留这些文件和用户配置目录。分发包不包含真实 `.env`、数据库、日志或私钥。

壳、进程监管组件和 CLI 由源码构建；已有后端、LiveKit 和网页复用指定运行包。若网页包含 Windows CLI 下载文件，打包时同步替换为本次构建的同一 CLI，不修改原运行包。当前未配置代码签名；EXE 的图标由 `rsrc_windows_amd64.syso` 注入（`assets/app.ico` 的产物，链接时自动合并），更换图标后重新生成该文件即可。`BUILD-MANIFEST.json` 记录版本和主要文件 SHA-256。

## 托盘实现的注意点

`Shell_NotifyIcon` 的回调按**线程消息队列**投递，所以托盘窗口的 `CreateWindowEx` 与 `GetMessage` 循环必须在同一个被 `LockOSThread` 固定的线程里（`shell_tray.go` 的 `start`/`createWindow`/`messageLoop`）。如果分开写，窗口建在 A 线程、消息循环跑在 B 线程，图标能显示但左键点击永远不会触发。

另外两处 Win32 细节：

- `DestroyWindow` 只能由创建窗口的线程调用，退出时用 `PostMessage(WM_CLOSE)` 让托盘线程自己收尾；函数导出名是 `DestroyWindow`，没有 `W` 后缀。
- 唤醒主窗口时先走 Wails 的 `WindowShow`，再用原生 `ShowWindow` + 置顶翻转 + 前台线程挂靠兜底，否则后台进程调用 `SetForegroundWindow` 会被前台锁静默拒绝。

## 第三方组件与许可

分发包聚合了几个独立的可执行文件，各自保留原许可证，均未修改二进制：

| 组件 | 版本 | 许可证 | 分发包内文件 |
| --- | --- | --- | --- |
| [frp](https://github.com/fatedier/frp) 客户端 | 0.71.1 | Apache-2.0 | `runtime/frpc.exe`、`LICENSE-FRP.txt` |
| [EasyTier](https://github.com/EasyTier/EasyTier) | 2.6.4 | LGPL-3.0 | `runtime/mesh/`、`LICENSE-EasyTier.txt` |
| [ZViewerCLI](https://github.com/Zero-wyc/ZViewerCLI) | 0.2.1 | MIT | `runtime/zviewer-cli-windows-amd64.exe`、`LICENSE-ZViewerCLI.txt` |
| [LiveKit](https://github.com/livekit/livekit) server | 见运行包 | Apache-2.0 | `runtime/livekit-server.exe` |

EasyTier 为 LGPL-3.0：本项目按原样聚合分发其官方发布包中的未修改二进制，未做任何链接或修改；对应源码可从 <https://github.com/EasyTier/EasyTier/tree/v2.6.4> 获取，许可证全文随包提供。需要替换该组件时，用自己的构建产物覆盖 `runtime/mesh/` 下的同名文件即可。

## 上游贡献

贡献内容应仅包含源码、应用图标、构建脚本和文档。排除本机配置、登录资料、数据库、证书私钥、运行时与下载缓存、测试输出和分发二进制。

