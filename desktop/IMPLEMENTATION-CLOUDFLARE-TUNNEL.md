# Cloudflare Tunnel 与 IPv6 连接维护说明

## 启动与停止

服务总览使用“新手推荐：Cloudflare Tunnel”，提示语为“一键启动，无需额外配置”。Cloudflare 卡片排在连接方式页首位；启动为蓝色，停止或中断为红色，复制地址后提供“刷新隧道”。

`controller/tunnel.go` 用一个可取消的启动会话完成本机源站检测、组件更新、候选进程、健康检测和自动刷新。UI 启动命令立即返回，停止命令取消该会话的网络请求和确切子进程；旧会话退出后才能启动新会话，防止手动中断后再次拉起进程。

本机 `/health` 最多检查两次，单次最多 1.5 秒。组件版本每次手动启动/刷新检查一次，自动刷新复用已检查的组件；官方更新请求和下载均可取消。下载仍先写临时文件，再检查大小、PE 标记和 Release 提供的 SHA-256；更新失败保留旧组件，PATH 文件不被改写。

## 组件获取源

连接方式卡片的启动按钮旁提供「获取源」下拉框，独立保存为 `cloudflaredSource`：`proxy`（默认，GitHub 前置反代）或 `github`（GitHub 官方）。旧配置缺少此项时自动采用默认值。版本检查和安装文件下载共用同一来源；默认通过 `https://gh-proxy.com/` 前缀获取官方 Release API 和 Windows x64 附件。反代版本检查或下载失败时自动回退官方直连，界面进度和 `tunnel` 日志记录原因；用户中断后不回退、不继续请求。两种来源都失败时保留现有组件。

获取源独立于 GUI 自身的软件更新设置。更改后下次启动或刷新隧道生效，无需重启主服务。仅在隧道已停止或启动失败后显示来源下拉；检测、下载、连接、自动刷新、运行、原地址重连和停止期间均隐藏，停止完成后恢复所保存的选择。下载只允许固定反代域名及 GitHub 附件域名的 HTTPS 跳转。

Windows 可能在写入完成后继续占用下载文件，使读取或原子重命名返回 `ERROR_SHARING_VIOLATION` / `ERROR_ACCESS_DENIED`。组件读取、安装与旧文件暂存对此每 100 ms 重试，最多 5 秒，遵循当前会话取消信号。安装失败或取消时恢复已暂存的旧文件，清理下载与回滚临时文件也对短时占用做有限重试。持续的本地安装错误不触发换源重下；旧组件仍在时继续使用旧组件，无可用组件时报告本地文件问题。回滚失败时保留旧文件并在错误中给出位置。

2026-10-26 检查 GitCode 的 `gh_mirrors/cl/cloudflared` 镜像，发行版为 0；`cloudflare/cloudflared` Release API 返回空列表，无法用作二进制更新源。SourceForge 提供 2026.10.3 Windows x64 文件，本机直连 1 MiB 抽样约 0.2 MB/s；默认反代同文件抽样约 0.8 MB/s。该结果只反映本次网络，不代表各地速度。

## 连接和健康判定

- cloudflared 使用 `--protocol http2`，这是到 Cloudflare 边缘的连接协议；本机源站按实际运行配置保留 HTTP 或 HTTPS，HTTPS 使用 localhost SNI。
- 每个候选先等待分配地址和 `Registered tunnel connection`，最多 18 秒；不会刚打印 URL 就开始探测或标记已连通。
- 公网 `/health` 单次最多 2 秒，两次失败就刷新；连续两次成功且 `startedAt` 与本机源站一致后公布地址，避免把错误页或另一代服务当成健康。
- 最多自动刷新 5 次，连同首次共 6 个候选。旧候选进程退出后才会建立下一个；本机源站失败或旧进程无法退出时提前结束并报告实际原因。
- 成功后结束启动重试，不再自动创建新地址。被动监听 cloudflared 日志，链路出错显示原地址重连中，源站错误显示具体原因；组件自行重连时保持同一 URL。
- 主服务主动停止、重启或意外退出均清理隧道。意外退出时显示源站错误，不保留虚假的“已连通”状态。

## IPv6 判定

外部接口只验证 IPv6 出口。公网地址存在但服务监听 `127.0.0.1` 或 `0.0.0.0` 时，不提供可用性承诺；连接卡片提示先切换为 `::` 并重启。服务运行且具备 IPv6 监听后，地址仍标记为候选、待外网验证。HTTPS 证书、访问端 IPv6、Windows 防火墙及路由器入站策略需分别核对，GUI 不自动更改这些网络策略。

## 诊断证据与验证

2026-10-25 使用官方 cloudflared 2026.10.3 和临时 HTTPS 文字服务实测，默认 QUIC 注册后出现 `timeout: no recent network activity`；切换 HTTP/2 的一轮实测在约 42 秒内完成 12 次公网健康访问。新会话实现的真实公网验收在约 26 秒内通过启动检查、随后 6 次健康接口访问和首页内容核对。也观察到新域名暂时无法解析和短时网络超时；因此不把组件注册或一次请求成功视为长期可达。

`controller/tunnel_test.go` 覆盖刷新上限、中断后不再启动、健康成功结束启动重试、短时失败和请求取消、源站身份校验、更新检查期间停止及源站退出清理。`TestTunnelHTTP2Live` 默认跳过，设置 `ZVIEWER_TEST_CLOUDFLARED` 后仅公开隔离的临时 HTTPS 测试服务，不读取用户业务数据。公网验收需同时记录失败与成功结果。

`controller/cloudflared_source_test.go` 覆盖默认值与持久化、两种来源的 API/附件请求、反代 API/下载/校验失败后的回退、中断不回退、离线保留现有组件和 HTTPS 来源限制。2026-10-26 通过 `go test ./...`、`go vet ./...`、JS 检查及 Windows 发布构建；设置 `ZVIEWER_TEST_CLOUDFLARED_DOWNLOAD=1` 运行 `TestCloudflaredProxyDownloadLive`，在临时目录完整下载并校验 2026.10.3，执行 `--version` 成功；未启动公网隧道。下拉的界面检查交由用户进行。

2026-10-26 后续修复使用 `CreateFile` 建立真实的 Windows 共享锁，在反代返回 502、官方源下载完成后暂时锁住下载文件：修复前重现「The process cannot access the file because it is being used by another process」，修复后同一用例安装成功。`controller/cloudflared_install_windows_test.go` 另覆盖旧组件与下载文件的临时锁、取消时恢复旧组件，以及持续占用时不切源重下。浏览器夹具检查了 11 次状态转换：停止/错误时显示来源，所有活动状态隐藏，再次停止时恢复原选择；此检查未启动用户业务服务或公网隧道。

构建：`npm --prefix desktop run check`，`go test ./...`（在 desktop 目录），`npm --prefix desktop run shell:build -- --release`。产物为 `desktop/build/bin/ZViewerDesktop.exe`，替换运行包壳时保留 runtime 业务数据与用户配置。
