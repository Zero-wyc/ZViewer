# ZViewer

> A platform for watching movies, listening to music, voice-chatting and sharing your screen together.

English | **[中文](README.md)**

<p align="left">  
  <a href="LICENSE">  
    <img src="https://img.shields.io/github/license/Zero-wyc/ZViewer?style=flat-square&logo=github&label=LICENSE&labelColor=333&color=blue" alt="MIT">  
  </a>  
  <img src="https://img.shields.io/github/stars/Zero-wyc/ZViewer?style=flat-square&logo=github&label=Stars&labelColor=333&color=blue" alt="Stars">  
  <a href="https://github.com/Zero-wyc/ZViewer/releases">  
    <img src="https://img.shields.io/github/v/release/Zero-wyc/ZViewer?style=flat-square&logo=github&label=RELEASE&labelColor=333&color=green" alt="Release">  
  </a>  
  <img src="https://img.shields.io/github/contributors/Zero-wyc/ZViewer?style=flat-square&logo=github&label=Contributors&labelColor=333&color=brightgreen" alt="Contributors">  
  <img src="https://img.shields.io/github/repo-size/Zero-wyc/ZViewer?style=flat-square&logo=github&label=Size&labelColor=333&color=yellow" alt="Repo Size">  
  <img src="https://img.shields.io/github/last-commit/Zero-wyc/ZViewer?style=flat-square&logo=github&label=Last%20Commit&labelColor=inactive" alt="Last Commit">  
  <img src="https://img.shields.io/github/languages/top/Zero-wyc/ZViewer?style=flat-square&logo=typescript&labelColor=333&color=3178C6" alt="Top Language">  
  <a href="https://t.me/Zero_251">  
    <img src="https://img.shields.io/badge/Telegram-26A5E4?style=flat-square&logo=telegram&logoColor=white" alt="Telegram">  
  </a>  
</p>

---

[Telegram](https://t.me/Zero_251) [QQ](https://qm.qq.com/q/MuKPRVz8wc)

---

Project docs: [docx.zviewer.zero251.xyz](https://docx.zviewer.zero251.xyz)

| ![](https://raw.githubusercontent.com/Zero-wyc/Image/main/All/20261003200919255.webp) | ![](https://raw.githubusercontent.com/Zero-wyc/Image/main/All/20261003200942428.webp) |
| ------------------------------------------------------------ | ------------------------------------------------------------ |
| ![](https://raw.githubusercontent.com/Zero-wyc/Image/main/All/20261003200643035.webp) | ![](https://raw.githubusercontent.com/Zero-wyc/Image/main/All/20261003200707122.webp) |
| ![](https://raw.githubusercontent.com/Zero-wyc/Image/main/All/20260930211758831.webp) | ![](https://raw.githubusercontent.com/Zero-wyc/Image/main/All/20261003201053941.webp) |
| ![](https://raw.githubusercontent.com/Zero-wyc/Image/main/All/20261003200715093.webp) | ![](https://raw.githubusercontent.com/Zero-wyc/Image/main/All/20261003201139524.webp) |

## Star History

<a href="https://star-history.com/#Zero-wyc/ZViewer&Zero-wyc/ZViewerCLI&Zero-wyc/ZViewerAPP&Date">
 <picture>  
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=Zero-wyc/ZViewer,Zero-wyc/ZViewerCLI,Zero-wyc/ZViewerAPP&type=Date&theme=dark&v=2" />  
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=Zero-wyc/ZViewer,Zero-wyc/ZViewerCLI,Zero-wyc/ZViewerAPP&type=Date&v=2" />  
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=Zero-wyc/ZViewer,Zero-wyc/ZViewerCLI,Zero-wyc/ZViewerAPP&type=Date&v=2" />  
 </picture>  
</a>

## Browser Requirements

> Chrome / Edge or another Chromium-based browser with kernel 130+ is recommended. Safari and Firefox have incomplete MSE / MKV decoding support — you may see stuttering, failed decoding, or subtitle glitches.

#### PS: There is also a [ZViewer mobile app](https://github.com/Zero-wyc/ZViewerAPP) under development　|　built by [FredQin](https://github.com/fredqin2006-X)

## Table of Contents

- [Features](#features)
- [ZViewerCLI](#zviewercli)
- [Installation & Startup](#installation--startup)
  - [Windows Desktop (GUI)](#windows-desktop-gui)
  - [Single-File Build (Recommended)](#single-file-build-recommended)
  - [Interactive Menu](#interactive-menu)
  - [From Source](#from-source)
  - [Ports](#ports)
- [Docker Deployment](#docker-deployment)
- [Deployment Configuration](#deployment-configuration)
  - [Environment Variables](#environment-variables)
  - [Voice Transport](#voice-transport)
- [Windows Desktop Console (Optional)](#windows-desktop-console-optional)

---

## Features

- **Watch together**: synchronized group viewing; the host controls playback, viewers can request pause / seek
- **Video sources**: Bilibili (multi-part, quality selection, premium quality), MP4 direct links, WebDAV / FTP / OpenList, Emby / Jellyfin, server local folders
- **Format compatibility**: MKV / AVI / TS / WMV, DTS / AC3 / EAC3 and other formats that browsers cannot play natively
- **Playback modes**: CLI local proxy (high quality, no server traffic), server DASH relay, MP4 direct link (up to 720P) — switch on demand
- **Danmaku & subtitles**: Bilibili official / DandanPlay / local XML·JSON (multiple tracks); SRT / ASS / SSA / VTT / SMI / SUB
- **Interaction & streaming**: comments, voice chat (UDP / TCP picked automatically, no manual switch), WebRTC screen sharing, OBS push
- **Listen together**: NetEase Cloud Music × Bilibili; playlists auto-filled with recommendations, one-click favorites into both folders, MV lyrics page background
- **Personalization**: Material You dynamic theme, custom theme colors and backgrounds, glassmorphism, independent danmaku and subtitle font sizes
- **Operations**: one-click auto update; Docker / single-file builds ready out of the box

## ZViewerCLI

[ZViewerCLI](https://github.com/Zero-wyc/ZViewerCLI) (Go) is a proxy that runs on the user's own machine: it parses and proxies the video stream locally with your own Bilibili cookie, so everyone in the room shares premium quality while barely consuming server bandwidth. It is meant for cases where you want high quality without paying for server traffic (server DASH relay uses a lot of bandwidth).

## Installation & Startup

On first startup a ROOT administrator is created automatically: username `root`, password `root`. **Change the password immediately after installation.**

### Windows Desktop (GUI)

`ZViewer-Windows-<version>-x64.zip` in Releases is a native desktop console (Go + system WebView2) for managing the local service, certificates, FRP tunneling and the high-quality proxy:

- Extract the archive and double-click `ZViewerDesktop.exe`; closing the window sends it to the system tray by default
- The runtime lives in `runtime/` inside the extracted folder, where `.env` and `config` are created on first launch
- The distribution already bundles the high-quality proxy CLI (`runtime/zviewer-cli-windows-amd64.exe`, the same file served by "Download CLI" on the web) and works out of the box; to change versions, replace `frontend/public/zviewer-cli-windows-amd64.exe` and rebuild the package

See `desktop/README.md` for build and debug instructions.

### Single-File Build (Recommended)

Download the archive for your platform from [Releases](https://github.com/Zero-wyc/ZViewer/releases), extract it, then:

- **Windows**: double-click `start.bat` to open the interactive menu
- **Linux**: run `./start.sh` (without arguments) to open the interactive menu

Choose `1` to start the service, then visit `http://localhost:3333`.

You can also skip the menu and pass a command directly, e.g. `start.bat start` / `./start.sh start`; see `start.bat help` for all commands.

#### Interactive Menu

```text
  1) 启动服务              2) 仅启动后端
  3) 停止服务              4) 重启服务
  5) 查看状态              6) 查看日志
  7) 一键签发 SSL 证书     8) HTTPS 启动（自动签发证书）
  0) 退出
```

> The bundled scripts print this menu in Chinese; the table below describes each entry.

| # | Action | Description |
| -- | -------- | ------------------------------------------------------ |
| 1  | Start service | Starts over HTTP; the port comes from `PORT` in `.env` (default 3333) |
| 2  | Backend only | Choose HTTP / HTTPS first; skips frontend artifact validation, suited to debugging frontend and backend separately |
| 3  | Stop service | Stops by the recorded PID, and cleans up port occupants as a fallback |
| 4  | Restart service | Stops, then starts again |
| 5  | Status | Port listening, process PID, presence of the program and certificates |
| 6  | Logs | Prints the last 50 lines of `log/backend.log` |
| 7  | Issue SSL certificate | Self-signed for `localhost`, or Let's Encrypt for a public domain / public IP (the domain must resolve and port 80 must be reachable; private IPs fall back to self-signed) |
| 8  | HTTPS start | Starts over HTTPS after the certificate has been issued |
| 0  | Exit | Closes the menu window only; the background service keeps running — choose `3` to stop it |

> Press Enter after each action to return to the menu.

> **Issuing production certificates from the command line is not recommended**: Let's Encrypt issuance from menu `7` / `8` is fine for testing, but renewals and failed-validation troubleshooting are on you. For production, hand the domain to an edge service that issues and renews automatically — **Cloudflare, ESA, EdgeOne** — or use a panel such as **aaPanel, 1Panel** to apply and renew, then reverse-proxy to ZViewer's port 3333.

### From Source

The backend is Go (`backend-go/`, requires Go 1.26+); the frontend is React + Vite.

```bash
npm install             # Install frontend dependencies
npm run db:init         # First run: create the database and the initial admin (password printed once)
npm run build           # Production build (Go backend + frontend)
npm start               # Start
```

> Editing the code? See [DEVELOPMENT.md](DEVELOPMENT.md) for prerequisites, directory map,
> hot-reload internals, regression scripts and the full checklist for changing a DB column.
> (Written in Chinese.)

`npm run build` compiles the Go backend to `dist/zviewer-backend(.exe)` and then builds the
frontend; `npm start` launches that binary (logs go to `log/backend.log`).

Development mode (Go backend + Vite HMR; the dev server proxies `/api` to port 3333):

```bash
npm run dev             # Backend and frontend together
npm run dev:backend     # Go backend only (restarts when a .go file is saved)
npm run dev:frontend    # Frontend only

npm run lint:go         # gofmt + go vet
npm run test:go         # go test ./...
npm run test:regression # All Node↔Go parity + smoke scripts (33 scripts, ~8 min)
```

Backend hot reload is provided by `scripts/dev-backend.js` (no `air` or other external tool
needed): it watches `backend-go/**/*.{go,mod,sum}`, compiles to a temporary binary and only
then swaps the process — so saving a half-written file with a syntax error keeps the old
process serving, and fixing it restores the new build automatically. Use
`npm run dev:backend:once` to disable the watcher.

Or use the script that handles dependency installation, build and startup:

```powershell
.\start-prod.bat start    # Windows
./start-prod.sh start     # Linux / macOS
```

Supported commands: `start` / `backend` / `stop` / `restart` / `status` / `logs` / `build` / `cert` / `https` / `help`.

### Ports

| Port     | Purpose                                                         |
| -------- | ------------------------------------------------------------ |
| 3333/tcp | Unified entry: HTTP/HTTPS API, WebSocket, frontend pages, `/live` FLV proxy |
| 3333/udp | LiveKit voice chat                                             |
| 3334/tcp | OBS push                                                     |
| 3335/tcp | HTTP-FLV pull (internal, proxied through `/live` on 3333 — do not expose)        |
| 3336/tcp | LiveKit HTTP/signaling (internal, reverse-proxied through `/rtc` on 3333 — do not expose)    |
| 3337/tcp | Voice ICE/TCP direct (on by default; the browser switches to it automatically when UDP is blocked) |
| 3338/tcp | Voice TURN/TLS relay (optional, enabled by the three certificate variables)      |

## Docker Deployment

> **Docker users on v4.3.6 or lower**: do **not** upgrade through the admin panel's "One-click Update" (Settings → Basic). Redeploy with the latest docker compose file instead.

```bash
docker run -d \
  --name zviewer \
  --restart unless-stopped \
  -p 3333:3333 \
  -p 3333:3333/udp \
  -p 3334:3334 \
  -p 3337:3337 \
  -p 3338:3338 \
  -v zviewer-data:/app/config \
  zerowyc0721/zviewer:latest
```

Or with docker compose:

```yaml
services:
  zviewer:
    image: zerowyc0721/zviewer:latest
    ports:
      - "3333:3333"      # API + WebSocket + frontend + /live FLV proxy + /rtc voice signaling proxy
      - "3333:3333/udp"  # LiveKit WebRTC media transport
      - "3334:3334"      # RTMP push (OBS)
      - "3337:3337"      # Voice ICE/TCP direct (on by default)
      - "3338:3338"      # Voice TURN/TLS relay (optional, enabled with all three cert vars)
    volumes:
      - zviewer-data:/app/config
    restart: unless-stopped
```

- Replace `zviewer-data` with your actual data directory
- Image tags: `latest` and `X.Y` only move when an official release is published (a `vX.Y.Z` tag is pushed), while `X.Y.Z` pins an exact version; `dev` follows the latest `main` build and may be unstable — for early testing only
- The image starts in HTTP mode; HTTPS is up to you: an edge service such as Cloudflare, ESA or EdgeOne, or a panel such as aaPanel / 1Panel that issues and renews certificates, reverse-proxied to 3333 (issuing production certificates from the command line is not recommended)
- `/app/config` holds the database (`dev.sqlite`), certificates (`ssl/`), uploads (`uploads/`) and stream segments (`media/`)
- Web-based updates remain available in Docker mode

## Deployment Configuration

### Environment Variables

| Variable                       | Description                                    | Default                     |
| ------------------------ | ------------------------------------- | ----------------------- |
| `PORT`                   | Backend port                                  | `3333`                  |
| `HOST`                   | Listen address                                  | empty (dual-stack)                   |
| `CONFIG_DIR`             | Data root directory                                 | `<project-root>/config` |
| `DATABASE_URL`           | SQLite file path (relative to `CONFIG_DIR`, or absolute) | `<config>/dev.sqlite`   |
| `SQLITE_WAL`             | Journal mode; set `0` to fall back to `journal_mode=delete` | WAL enabled          |
| `CORS_ORIGIN`            | CORS origins, comma-separated                          | `*`                     |
| `JWT_ACCESS_SECRET`      | Access secret (must be changed in production)                     | —                       |
| `JWT_REFRESH_SECRET`     | Refresh secret (must be changed in production)                    | —                       |
| `RTMP_PORT`              | RTMP push port                             | `3334`                  |
| `HTTP_FLV_PORT`          | FLV pull port (internal)                          | `3335`                  |
| `LIVEKIT_EXTERNAL`       | `1` uses an external LiveKit and skips the bundled one               | `0`                     |
| `LIVEKIT_NODE_IP`        | ICE advertised address; set the public IP manually for complex NAT or no outbound internet       | empty (automatic STUN)             |
| `LIVEKIT_BIND`           | LiveKit HTTP/signaling listen address (affects 3336 only, not media ports) | empty (dual-stack, all addresses) |
| `LIVEKIT_RTC_TCP_PORT`   | ICE/TCP direct port (on by default; set `0` to disable the listener and keep UDP only) | `3337`                  |
| `LIVEKIT_RTC_ADVERTISE_INTERNAL_IP` | Advertise both external and internal IP candidates (`advertise_internal_ip`); `false` disables | `true` |
| `LIVEKIT_RTC_SKIP_EXTERNAL_IP_VALIDATION` | Skip the external IP self-ping check (enable when NAT blocks self-ping) | unset |
| `LIVEKIT_TURN_TLS_PORT`  | TURN/TLS relay port (separate from 3337, both can run at once)       | `3338`                  |
| `LIVEKIT_TURN_DOMAIN`    | TURN/TLS domain                           | —                       |
| `LIVEKIT_TURN_CERT`      | TURN TLS certificate path                         | —                       |
| `LIVEKIT_TURN_KEY`       | TURN TLS private key path                         | —                       |

### Voice Transport

- No channel switch: the server publishes both `3333/udp` (low-latency direct) and `3337/tcp` (ICE/TCP direct) candidates and the browser's ICE picks automatically — UDP direct > TCP direct > TURN relay. When UDP is blocked by an ISP, corporate firewall or proxy, the browser switches to 3337 on its own; nothing needs toggling in the admin panel
- To turn the 3337 listener off entirely (open only the UDP port), set `LIVEKIT_RTC_TCP_PORT=0`. The value must be an explicit 0 — leaving it unset/deleted makes LiveKit fall back to its default 7881, which is never port-mapped, so clients only get candidates that can never connect
- Private and public networks both work: `advertise_internal_ip` is on by default, advertising the mapped external IP alongside the local interface IP. In bridge networking the local IP is the container's 172.x and is unreachable from LAN clients; for LAN direct connections use host networking (drop the compose `ports` section, add `network_mode: host`) and narrow the interfaces with `rtc.interfaces.includes: [eth0]` in `LIVEKIT_CONFIG`. Add `LIVEKIT_RTC_SKIP_EXTERNAL_IP_VALIDATION=true` when NAT blocks self-ping
- Once all three `LIVEKIT_TURN_*` variables are set, a TURN/TLS relay is also opened on 3338/tcp (a CA-issued certificate is required; this penetrates proxies and multi-layer NAT best). 3337 and 3338 are two independent channels that can coexist, and the client picks automatically: UDP direct > TCP direct > TURN relay
- When STUN discovery fails on a pure intranet or unusual NAT, set `LIVEKIT_NODE_IP` to the server's public IP
- Troubleshooting: the voice panel shows "connecting media…" while the media path is down and gives a network hint after 10 seconds. Joining a room successfully but hearing nothing usually means media never connected (a proxy TUN or firewall is dropping UDP) — try turning the proxy / VPN off first

**Direct connections from both LAN and WAN (host networking recommended)**

With bridge networking only the mapped address is reachable, and LAN clients often fail because the router does not support NAT hairpinning. Switch to host networking and pin the interface:

```yaml
services:
  zviewer:
    image: zerowyc0721/zviewer:latest
    network_mode: host          # drop the ports section: 3333, 3333/udp, 3334, 3337, 3338 listen directly on the host
    environment:
      LIVEKIT_BIND: "127.0.0.1"                          # signaling bound to localhost only (external access goes through the 3333 proxy)
      LIVEKIT_RTC_USE_EXTERNAL_IP: "true"
      LIVEKIT_RTC_ADVERTISE_INTERNAL_IP: "true"
      LIVEKIT_RTC_SKIP_EXTERNAL_IP_VALIDATION: "true"   # add when NAT blocks self-ping
      LIVEKIT_CONFIG: |-
        rtc:
          interfaces:
            includes: [eth0]
    volumes:
      - ./config:/app/config
    restart: unless-stopped
```

`interfaces.includes` keeps docker0, veth, tailscale and similar interfaces out of the candidate list, so clients are not handed unreachable addresses. The name must match the host's real interface (`ip -br addr`; cloud hosts commonly use `eth0` / `ens18` / `enp3s0`) — a wrong name makes LiveKit enumerate no ICE candidates at all and voice stops connecting, so drop this block and let LiveKit enumerate automatically if unsure.

Host networking has no port mapping, so `LIVEKIT_BIND: "127.0.0.1"` keeps LiveKit's own HTTP/signaling port (3336) on localhost while external clients come in through the `/rtc` proxy on 3333. It applies to **signaling only**: the media ports (`3333/udp`, `3337/tcp`, `3338/tcp`) still listen on all interfaces, so LAN and WAN direct connections are unaffected.
- To use the TURN/TLS relay, configure `LIVEKIT_TURN_DOMAIN` / `LIVEKIT_TURN_CERT` / `LIVEKIT_TURN_KEY` (the compose file already maps `3338:3338`, and 3338/tcp must be allowed through the firewall)

## Windows Desktop Console (Optional)

Windows users can build the native directory GUI (Go + system WebView2 — no runtime to install, no Electron dependency). Double-click the single `ZViewerDesktop.exe` in the distribution folder to open the console; the runtime sits in the sibling `runtime/` directory. The console provides a system tray, local HTTPS, self-hosted FRP, a persistable listen port, and in-window configuration plus QR-code login for the ZViewerCLI high-quality proxy. See [desktop/README.md](desktop/README.md) for build and usage steps; the existing web UI and command-line source workflows stay compatible.
