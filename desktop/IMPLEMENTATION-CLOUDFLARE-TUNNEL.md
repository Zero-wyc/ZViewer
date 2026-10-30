# Cloudflare Tunnel 与 IPv6 连接约定

实现与验收记录，结论部分供改隧道逻辑时对照。用户操作见 [README.md](README.md)。

## 启动与停止

`controller/tunnel.go` 用一个可取消的启动会话串起：本机源站检测 → 组件更新 → 候选进程 → 公网健康检测 → 自动刷新。
UI 启动命令立即返回；停止命令取消该会话的请求与确切子进程；旧会话退出后才允许新会话，防止中断后被重新拉起。

- 本机 `/health` 最多两次，单次 1.5 秒。
- 每个候选先等地址分配与 `Registered tunnel connection`，最多 18 秒，不刚打印 URL 就判定连通。
- 公网 `/health` 单次 2 秒，两次失败即刷新；连续两次成功且 `startedAt` 与当前源站一致才公布地址，避免把错误页当成健康。
- 最多自动刷新 5 次（共 6 个候选）。成功后结束重试，断线交给 cloudflared 在原地址重连。
- 主服务停止、重启、意外退出都清理隧道；意外退出显示源站错误，不保留虚假「已连通」。

## 组件下载

- 空闲超时：从发起请求起，连续 1 分钟没有响应或数据才中断，收到数据就一直续。错误码 `cloudflared_download_idle_timeout`，
  GUI 状态「下载超时」，提示检查网络或换源。用户主动取消不显示超时、不继续回退。
- 下载先写临时文件，再校验大小与 PE 头（官方给 SHA-256 时额外比对）；失败保留旧组件，PATH 不被改写。
- Windows 会短暂占用刚下载的文件（`ERROR_SHARING_VIOLATION`），读取、安装、回滚每 100 ms 重试，最多 5 秒。
  持续占用不触发换源，旧组件可用就继续用。

## 获取源

`cloudflaredSource` 三选一：`gitcode`（默认）、`github`、`proxy`。旧配置缺此项自动用 `gitcode`，已存的 `proxy` / `github` 继续有效。

- GitCode 源不查 Release API，版本钉死 `2026.10.3`，走 `api.gitcode.com/api/v5/repos/{owner}/{repo}/raw/{path}?ref=components`。
- **不能用 `raw.gitcode.com/{owner}/{repo}/raw/{branch}/{path}`**：预览通道，exe / zip 一律 `403 暂不支持预览`。
  api/v5 端点返回 `application/octet-stream` 且支持 Range，2.6 MB 与 56 MB 文件实测均可完整下载。
- 失败自动回退 GitHub 官方，原因写进 `tunnel` 日志；用户中断后不回退。
- 下载首跳只允许固定反代域名、GitHub 与 GitCode；后续跳到对象存储要求公网 HTTPS，再由大小与 PE 头把关。
- 获取源与 GUI 自身的更新源独立，改后下次启动或刷新隧道生效。

## IPv6

外部接口只验证 IPv6 出口，不等于入站可达。监听 `127.0.0.1` 或 `0.0.0.0` 时不承诺可用性，需切到 `::` 并重启；
即使已监听，地址仍标记为候选、待外网验证。证书、访问端 IPv6、防火墙与路由器入站策略需各自核对，GUI 不改网络策略。

## 验证

```powershell
cd desktop
go test ./...; go vet ./...
npm --prefix desktop run check
npm --prefix desktop run shell:build -- --release
```

- `controller/tunnel_test.go`：刷新上限、中断后不再启动、健康成功即结束、源站身份校验、停止期间退出清理。
  `TestTunnelHTTP2Live` 默认跳过，设 `ZVIEWER_TEST_CLOUDFLARED` 后仅暴露临时 HTTPS 测试服务。
- `controller/cloudflared_source_test.go`：默认值与持久化、两种来源的请求、回退、中断不回退、离线保留旧组件。
  `TestCloudflaredProxyDownloadLive` 需 `ZVIEWER_TEST_CLOUDFLARED_DOWNLOAD=1`，真实下载并 `--version`。
- `controller/cloudflared_download_test.go`：用 `testing/synctest` 虚拟时钟验证空闲超时、空读取不续期、慢速下载成功。
- 2026-10-25 实测：默认 QUIC 注册后出现 `timeout: no recent network activity`，切 `--protocol http2` 后约 42 秒内 12 次公网健康访问全部成功。
