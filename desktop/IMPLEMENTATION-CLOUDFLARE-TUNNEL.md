# Cloudflare Tunnel 一键启动与更新说明

## 用户操作

在“连接方式”的 Cloudflare Tunnel 卡片中点击蓝色“一键启动隧道”。若运行包或 PATH 中已有 `cloudflared`，每次启动前查询 Cloudflare 官方最新 Release；版本较旧时下载更新到运行包 `runtime/cloudflared.exe`，校验后替换并启动。首次使用会先下载组件，再启动快速隧道。运行中可停止并复制 `trycloudflare.com` 临时地址。

## 实现边界

- 版本和校验值来自 Cloudflare 官方 GitHub Release API，下载使用官方 Release 资产地址，并限制 HTTPS 与 GitHub 下载主机。
- 文件先下载到运行包目录的临时文件，检查 HTTP 状态、大小、Release SHA-256（若提供）和 Windows PE 标记后再替换；失败时清理临时文件并保留旧版。
- PATH 中的用户文件不会被改写；自动更新组件落在当前运行包的 `runtime/`。
- 每次启动检查官方版本。查询失败或更新失败时记录警告并继续使用现有组件；首次安装失败时显示错误。
- 隧道按当前实际网页协议与端口启动，不需要账号或额外隧道配置；快速隧道地址在进程停止后失效。

## 构建与检查

使用 `npm --prefix desktop run shell:build -- --release` 构建 Windows 桌面程序。构建产物为 `desktop/build/bin/ZViewerDesktop.exe`。本次提交只记录源码与说明，发行目录中的 exe 由该命令生成。
