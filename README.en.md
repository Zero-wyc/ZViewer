# ZViewer

> Sync-watch, co-viewing & remote sharing platform.

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
  <img src="https://img.shields.io/github/last-commit/Zero-wyc/ZViewer?style=flat-square&logo=github&label=Last%20Commit&labelColor=333&color=inactive" alt="Last Commit">
  <img src="https://img.shields.io/github/languages/top/Zero-wyc/ZViewer?style=flat-square&logo=typescript&labelColor=333&color=3178C6" alt="Top Language">
  <a href="https://t.me/Zero_251">
    <img src="https://img.shields.io/badge/Telegram-26A5E4?style=flat-square&logo=telegram&logoColor=white" alt="Telegram">
  </a>
</p>

---

## Browser Requirements

> **Strongly recommended to use a high-version Chromium-based browser such as Chrome / Edge (kernel 130+)** to access ZViewer.
>
> ⚠️ **Not recommended**: Safari and Firefox — due to differences in their support for MSE / MKV / browser-side decoding and transcoding, you may encounter playback stuttering, videos failing to decode, and subtitle extraction issues.

## Table of Contents

- [Features](#features)
- [Quick Start](#quick-start)
- [Ports](#ports)
- [HTTPS & Certificates](#https--certificates)
- [Docker Deployment](#docker-deployment)
- [GitHub Actions](#github-actions)
- [Local Development](#local-development)
- [Environment Variables](#environment-variables)
- [Permission Model](#permission-model)
- [Video Sources](#video-sources)
- [ZViewerCLI](#zviewercli)
- [FAQ](#faq)

---

| ![](https://github.cdn.zero251.xyz/Zero-wyc/Image/main/All/20260804013054107.webp) | ![](https://github.cdn.zero251.xyz/Zero-wyc/Image/main/All/20260804013133193.webp) |
| ------------------------------------------------------------ | ------------------------------------------------------------ |
| ![](https://github.cdn.zero251.xyz/Zero-wyc/Image/main/All/20260804013107507.webp) | ![](https://github.cdn.zero251.xyz/Zero-wyc/Image/main/All/20260804013127227.webp) |

## Features

### Watch-Together Rooms

- Create or join rooms to watch with friends in sync.
- Room host controls playback: play, pause, seek, speed. Viewers can request control.
- When host goes offline, viewers enter **self-control mode** and can control the player directly; the request-based mode is restored when the host reconnects.
- Playback memory: if the host briefly disconnects, the server continues broadcasting the current state.
- Room auto-closes if the host is offline for more than 10 minutes.

### Multi-Source Video Parsing

| Source | Description |
|---|---|
| **Bilibili** | Parse BV/AV video links, quality switching, premium credentials |
| **MP4 Direct Link** | Play MP4 videos directly from accessible URLs |
| **WebDAV** | Mount WebDAV servers, browse and play video files |
| **FTP** | Mount FTP servers, browse and play video files |
| **OpenList** | Mount OpenList services, browse and play video files |

### Subtitles & Audio Compatibility

- **Native subtitle system**: directly parses SRT / ASS / SSA / VTT / SMI / SUB and renders with HTML/CSS — no WebVTT conversion, higher style fidelity.
- **Browser-side embedded subtitle extraction**: text subtitle tracks inside MKV containers are extracted directly in the browser (custom MKV demux with sparse scanning that skips audio/video payload) — subtitles appear in seconds even for multi-gigabyte files, no server-side FFmpeg required.
- **Browser-side playback engine (playsvideo)**: containers such as MKV / AVI / TS / WMV are automatically remuxed to fMP4 in the browser; browser-incompatible audio tracks (DTS / AC3 / EAC3, etc.) are transcoded to AAC in real time in the browser. Fully automatic — **no admin-panel toggles required** — and the transcode core ships with the frontend assets, so no server-side FFmpeg is needed.

### Real-Time Interaction

- Comment panel & danmaku system: supports Bilibili official danmaku, DandanPlay danmaku, custom danmaku tracks.
- Playback state sync: host actions are broadcast to all viewers in real time.
- Viewers can request pause or seek; the host sees notifications at the top-left of the player.
- Voice chat: host enables voice chat for viewers to listen in real time (fixed 128kbps bitrate).

### Screen Sharing & Streaming

- WebRTC-based screen sharing: share your screen or video capture.
- OBS RTMP push support with Node Media Server for HTTP-FLV pull (via backend `/live` proxy).

### Theme System

- Material You (Monet) dynamic theme system, extracting colors from wallpapers to generate a complete palette.
- Light/dark theme toggle, custom backgrounds, glassmorphism UI, reduced motion mode.

---

## Quick Start

On first startup, the system automatically creates a super admin account: username `root`, password `root`. **Change the default password immediately after production deployment.**

### Single-File Build (Recommended)

No Node.js / npm required. Download the latest archive from [Releases](https://github.com/Zero-wyc/ZViewer/releases), extract, and run:

```bash
# Windows
start.bat              # Interactive menu
start.bat start        # Start service

# Linux
./start.sh             # Interactive menu
./start.sh start       # Start service
```

### Source Code Deployment

The `start-prod` scripts in the project root automatically detect dependencies, build on demand, and start the service.

**Windows**:

```powershell
.\start-prod.bat              # Interactive menu
.\start-prod.bat start        # Start (HTTP)
.\start-prod.bat stop         # Stop service
.\start-prod.bat status       # Check status
.\start-prod.bat cert         # Issue SSL certificate
.\start-prod.bat https        # Issue certificate + HTTPS start
```

**Linux / macOS**:

```bash
./start-prod.sh               # Interactive menu
./start-prod.sh start
./start-prod.sh stop
./start-prod.sh status
```

### Interactive Menu

```
========================================
  ZViewer Service Manager
========================================
  1) Start Service (HTTP)
  2) Start Backend Only (HTTP / HTTPS)
  3) Stop Service
  4) Restart Service
  5) Check Status
  6) View Logs
  7) Issue SSL Certificate
  8) HTTPS Start (Auto Certificate)
  9) Build Frontend & Backend (Source)
  0) Exit
```

### CLI Commands

| Command | Description |
|---|---|
| `start` | Start service (HTTP; add `-Https` for HTTPS mode) |
| `backend` | Start backend only (HTTP/HTTPS) |
| `cert [host]` | Issue SSL certificate; interactive type selection if host omitted |
| `https [host]` | Issue certificate + HTTPS start (backend serves all) |
| `stop` / `restart` | Stop / restart service |
| `status` | Check running status (PID, port listeners, certificate) |
| `logs [backend\|frontend]` | View logs (default: backend) |
| `build` | Build frontend & backend (source) |
| `help` / `menu` | Help / interactive menu |

### Access

| Mode | URL |
|------|-----|
| HTTP | `http://localhost:3333` |
| HTTPS | `https://localhost:3333` |

---

## Ports

| Service | Port | Description |
|---|---|---|
| Backend (unified entry) | 3333 | HTTP/HTTPS API, WebSocket, frontend static files, SPA fallback, `/live` HTTP-FLV proxy |
| RTMP Push | 3334 | OBS push port (standalone; RTMP is a TCP binary protocol, cannot share with HTTP) |
| HTTP-FLV Pull | 3335 | Internal port (Node Media Server), container-only, not exposed externally |

In production mode, **only port 3333 is exposed externally**. The backend handles API requests, frontend static resources, WebSocket, and reverse-proxies `/live` to the internal HTTP-FLV service.

---

## HTTPS & Certificates

### Certificate Types

The certificate tool (`zviewer-cert`, source at `scripts/generate-cert.js`) automatically selects the issuance method based on the address type:

| Address Type | Certificate | Description |
|---|---|---|
| `localhost` | Self-signed | SAN includes `localhost`, `127.0.0.1`, `::1`; 10-year validity |
| Domain (e.g. `example.com`) | **Let's Encrypt CA-trusted** | Auto-request via built-in ACME client; no browser warning |
| Public IP (e.g. `1.2.3.4`) | **Let's Encrypt CA-trusted** | Let's Encrypt supports IP certificates since 2025 |
| Private IP (e.g. `192.168.1.1`) | Self-signed | SAN includes the IP |

### CLI Usage

```bash
# Domain → auto-request Let's Encrypt trusted certificate
start.bat cert example.com
./start.sh cert example.com

# Public IP → auto-request Let's Encrypt trusted certificate
start.bat cert 1.2.3.4

# Private IP → self-signed certificate
start.bat cert 192.168.1.1

# Force re-issue
start.bat cert example.com --force
```

### Prerequisites for Let's Encrypt

1. Domain resolves to your public IP, or the public IP is directly accessible.
2. **Port 80** is open and firewall/security group allows it (ACME HTTP-01 challenge).
3. Rate limit: 5 certificates per domain per week. Use `--staging` for testing.

Certificate files are stored in `config/ssl/` (`cert.pem` chain, `key.pem` private key, `acme-account.key`).

---

## Docker Deployment

Docker images run in HTTP mode. The backend serves frontend static files. For HTTPS, add a reverse proxy (Nginx / Caddy) in front of the container.

### docker run

```bash
docker run -d \
  --name zviewer \
  --restart unless-stopped \
  -p 3333:3333 \
  -p 3334:3334 \
  -v zviewer-data:/app/config \
  zerowyc0721/zviewer:latest
```

> Note: The update process replaces files inside the container then restarts the backend process in-place,
> without restarting the whole container and without relying on a restart policy.
> Keeping `--restart unless-stopped` is still recommended to recover from backend crashes (non-update exits).

### Docker Compose

```yaml
services:
  zviewer:
    image: zerowyc0721/zviewer:latest
    ports:
      - "3333:3333"   # Unified entry (API + WebSocket + frontend + /live proxy)
      - "3334:3334"   # RTMP push (OBS)
    volumes:
      - zviewer-data:/app/config
    restart: unless-stopped

volumes:
  zviewer-data:
```

### Build Yourself

```bash
docker build -t zviewer -f Dockerfile.linux-single .
docker compose -f docker-compose.linux-single.yml up -d
```

### Access

Visit `http://localhost:3333` for all features. OBS push URL: `rtmp://localhost:3334/live`.

### Data Persistence

Mount `/app/config` as a volume:

| Path | Content |
|---|---|
| `/app/config/dev.sqlite` | Database |
| `/app/config/ssl/` | SSL certificates |
| `/app/config/uploads/` | User uploads |
| `/app/config/media/` | NMS stream media segments |

---

## GitHub Actions

Automatic builds on every push to `main` or tag (`v*`):

1. **Build Linux single-file** → upload artifact + push to Docker Hub (`zerowyc0721/zviewer`).
2. **Build Windows single-file** → upload artifact.
3. Tag pushes create a GitHub Release with both platform archives.

### Version Management

| Trigger | Version | Example |
|---|---|---|
| Tag `v1.0.0` | Release | `1.0.0` |
| Push to `main` | Pre-release | `0.0.0-dev.a1b2c3d` |
| Manual trigger | Manual build | `0.0.0-manual` |

### Build Artifacts

| Platform | Archive | Contents |
|---|---|---|
| Linux | `zviewer-linux-x64.tar.gz` | `zviewer-backend`, `zviewer-cert`, `start.sh` |
| Windows | `zviewer-windows-x64.zip` | `zviewer-backend.exe`, `zviewer-cert.exe`, `start.bat` |
| Docker | `zerowyc0721/zviewer:latest` | Docker image based on Linux single-file build |

---

## Local Development

The project uses npm workspaces. Install all dependencies from the root:

```bash
# Install all dependencies
npm install

# Start both frontend and backend dev servers
npm run dev

# Or start separately
npm run dev:backend
npm run dev:frontend
```

Development ports:

- Frontend: `http://localhost:5174` (Vite dev server, HMR)
- Backend: `http://localhost:3333` (Express + TypeScript, hot reload)

In development, Vite proxies `/api`, `/socket.io`, and `/live` requests to the backend.

### Project Structure

```
ZViewer/
├── backend/          # Express backend (TypeScript + TypeORM + sql.js)
│   └── src/
│       ├── routes/          # REST API routes
│       ├── services/        # Business logic (Bilibili, proxy, update, etc.)
│       ├── modules/         # Modular architecture (rooms, viewers, sync, etc.)
│       ├── entities/        # TypeORM entities
│       └── middleware/      # Auth middleware
├── frontend/         # React frontend (Vite + Tailwind CSS)
│   └── src/
│       ├── pages/           # Page components
│       ├── components/      # Shared UI components
│       ├── modules/         # Feature modules
│       └── store/           # Zustand state management
├── docker/           # Docker entrypoint scripts
├── packaging/        # Startup script templates
├── dist/             # Build output
└── build-all.js      # Single-file build script
```

---

## Environment Variables

### Backend

| Variable | Description | Default |
|---|---|---|
| `PORT` | Backend service port | `3333` |
| `HOST` | Listen address | (dual-stack) |
| `NODE_ENV` | Environment | `production` |
| `DATABASE_URL` | SQLite file path or PostgreSQL connection string | `<config>/dev.sqlite` |
| `CONFIG_DIR` | Data root directory | `<project-root>/config` |
| `CORS_ORIGIN` | Allowed CORS origins (comma-separated) | `*` |
| `JWT_ACCESS_SECRET` | Access Token secret (must change in production) | — |
| `JWT_REFRESH_SECRET` | Refresh Token secret (must change in production) | — |
| `JWT_ACCESS_EXPIRES_IN` | Access Token expiry | `15m` |
| `JWT_REFRESH_EXPIRES_IN` | Refresh Token expiry | `7d` |
| `RTMP_PORT` | RTMP push port | `3334` |
| `HTTP_FLV_PORT` | HTTP-FLV pull port (internal) | `3335` |

### Frontend Build

| Variable | Description | Default |
|---|---|---|
| `VITE_API_URL` | API / Socket.IO base URL; leave empty for `window.location.origin` | — |
| `VITE_FLV_BASE_URL` | OBS streaming HTTP-FLV pull base URL | — |

---

## Permission Model

Four-tier permission system:

| Role | Description | Permissions |
|---|---|---|
| `root` | Super admin | Create/control/delete any room, approve users, change roles, admin panel |
| `admin` | Admin | Create rooms, full control of own rooms, cannot delete others' rooms |
| `user` | Regular user | Join rooms, watch, send comments and danmaku; cannot create rooms |
| `guest` | Guest | Join rooms, watch, send comments and danmaku; cannot create rooms |

New users register as `guest` with `pending` status. Only `root` can approve users in the admin panel, upgrading them to `user`.

---

## Video Sources

### Bilibili

Parse BV/AV video links, with quality switching and premium content support. Configure Bilibili credentials in the admin panel for premium quality. Supports ZViewerCLI for local cookie-based high-quality streaming.

### Direct Links & Mounts

- **MP4 Direct Link**: Input a direct MP4 URL to play.
- **WebDAV / FTP / OpenList**: Save connection configurations in mount management, browse directories, and play video files.

---

## ZViewerCLI

[ZViewerCLI](https://github.com/Zero-wyc/ZViewerCLI) is an optional local proxy client that solves the browser's inability to use user Bilibili cookies and high-quality addresses:

- Uses local user cookies to parse Bilibili videos, obtaining premium high-quality addresses.
- Proxies video stream requests locally, injecting correct Referer/Origin/User-Agent headers to bypass CDN hotlink protection and CORS restrictions.
- Registers with the room via WebSocket; the frontend auto-detects and uses the local proxy.

---

## FAQ

### Self-signed certificate shows "Not Secure"

`localhost` and private IPs use self-signed certificates. Solutions:

- Import `config/ssl/cert.pem` into the client's "Trusted Root Certification Authorities"; or
- Use a domain or public IP with Let's Encrypt for a trusted certificate.

### WebSocket connection fails

Ensure your reverse proxy (Nginx, etc.) is properly configured with WebSocket upgrade headers:

```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
```

### WebRTC connection fails

`getUserMedia` requires HTTPS. Configure SSL in production. If both peers are behind strict NAT, consider deploying a TURN server (e.g., coturn).

### Database

The backend uses TypeORM + sql.js (WASM-based SQLite) — pure JS, no native modules. The single-file build runs on any platform without compilation. The database file is standard SQLite format (`config/dev.sqlite`), readable with any SQLite tool.

### Bilibili parse failure

- Check that the backend sends the correct Referer and other headers.
- Thumbnails and video URLs are fetched via the backend proxy to avoid CORS and hotlink protection issues.
- Premium content requires valid Bilibili credentials in the admin panel, or use ZViewerCLI.

### Update mechanism

The system supports automatic update detection from GitHub Releases and manual upload of update archives (zip/tar.gz). The admin panel controls whether to accept pre-release (main branch) updates.