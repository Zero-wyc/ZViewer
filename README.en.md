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
- [Voice Advanced Configuration](#voice-advanced-configuration)
- [FAQ](#faq)

---

| ![](https://raw.githubusercontent.com/Zero-wyc/Image/main/All/20260804013054107.webp) | ![](https://raw.githubusercontent.com/Zero-wyc/Image/main/All/20260804013133193.webp) |
| ------------------------------------------------------------ | ------------------------------------------------------------ |
| ![](https://raw.githubusercontent.com/Zero-wyc/Image/main/All/20260804013107507.webp) | ![](https://raw.githubusercontent.com/Zero-wyc/Image/main/All/20260804013127227.webp) |

## ⚠️ Docker Upgrade Notice (required reading for v4.3.6 and below)

> **Docker users on v4.3.6 or lower**: voice chat has been migrated to LiveKit and is now bundled inside the container. Do **not** upgrade via the admin panel's "One-click Update" (Settings → Basic) — the old image does not contain the LiveKit companion binary, and the in-place update cannot add it, leaving voice chat broken after the update. Pull the new image and recreate the whole container instead:
>
> ```bash
> docker pull zerowyc0721/zviewer:latest
> docker compose up -d --force-recreate
> ```
>
> **You must also update your `docker-compose.linux-single.yml` file**: the new compose adds the `3333:3333/udp` media port mapping, which the old file lacks — updating the image without updating the compose file leaves the voice media port unexposed and voice chat still broken.
>
> Your data lives in the `/app/config` volume — recreating the container keeps the database and configuration intact.

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
- Voice chat: host enables voice chat for viewers to listen in real time (LiveKit WebRTC, bundled with the server out of the box; IPv6 support and TURN/TLS fallback relay).

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

The archive bundles the `livekit-server` companion binary (voice chat). The backend spawns it automatically on startup and discovers the public IP via STUN — no separate installation or configuration needed. Voice automatically uses `wss://` on HTTPS pages.

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
| Backend (unified entry) | 3333/tcp | HTTP/HTTPS API, WebSocket, frontend static files, SPA fallback, `/live` HTTP-FLV proxy |
| LiveKit media (voice) | 3333/udp | WebRTC media transport (same port number as the page, different protocol) |
| RTMP Push | 3334 | OBS push port (standalone; RTMP is a TCP binary protocol, cannot share with HTTP) |
| HTTP-FLV Pull | 3335 | Internal port (Node Media Server), container-only, not exposed externally |
| TURN/TLS relay | 5349 | Optional voice fallback over TCP when UDP is blocked |

In production mode, **only ports 3333 (tcp+udp) and 3334 are exposed externally**. Voice signaling goes through the `/rtc` reverse proxy on 3333 — no extra port needed. The backend handles API requests, frontend static resources, WebSocket, and reverse-proxies `/live` to the internal HTTP-FLV service.

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

The image bundles voice chat (the LiveKit companion binary ships with the image and is spawned automatically by the backend on startup). A single container provides all features — no separate LiveKit container needed.

Docker images run in HTTP mode. The backend serves frontend static files. For HTTPS, add a reverse proxy (Nginx / Caddy) in front of the container.

### docker run

```bash
docker run -d \
  --name zviewer \
  --restart unless-stopped \
  -p 3333:3333 \
  -p 3333:3333/udp \
  -p 3334:3334 \
  -v zviewer-data:/app/config \
  zerowyc0721/zviewer:latest
```

> Note: The update process replaces files inside the container (including `livekit-server`) then restarts the backend process in-place,
> without restarting the whole container and without relying on a restart policy.
> Keeping `--restart unless-stopped` is still recommended to recover from backend crashes (non-update exits).

### Docker Compose

```yaml
services:
  zviewer:
    image: zerowyc0721/zviewer:latest
    ports:
      - "3333:3333"      # Unified entry (API + WebSocket + frontend + /live proxy + /rtc voice signaling)
      - "3333:3333/udp"  # LiveKit WebRTC media (same port number, different protocol)
      - "3334:3334"      # RTMP push (OBS)
    volumes:
      - zviewer-data:/app/config
    restart: unless-stopped

volumes:
  zviewer-data:
```

- Voice chat works out of the box with zero configuration: the public IP is discovered automatically via LiveKit's native STUN, and signaling URLs are derived from the page origin (HTTPS pages get `wss://`). Media travels over 3333/udp; make sure your firewall allows it.
- **Advanced** (TURN/TLS fallback relay for blocked UDP, manual ICE address for complex NAT): see *Voice Advanced Configuration* in the extended tutorials.

### Build Yourself

```bash
# Build artifacts first (backend binary + livekit-server + frontend)
node build-all.js --linux
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
| Linux | `zviewer-linux-x64.tar.gz` | `zviewer-backend`, `zviewer-cert`, `livekit-server`, `start.sh` |
| Windows | `zviewer-windows-x64.zip` | `zviewer-backend.exe`, `zviewer-cert.exe`, `livekit-server.exe`, `start.bat` |
| Docker | `zerowyc0721/zviewer:latest` | Docker image based on Linux single-file build (bundles LiveKit) |

Builds target Node 26 (`node26-*-x64`). The `build-all.js` script downloads the LiveKit companion binary alongside the platform build; CI fails hard if the LiveKit download fails, guaranteeing voice capability in every artifact.

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

## Voice Advanced Configuration

The default deployment works with zero configuration: the public IP is discovered automatically via LiveKit's native STUN (requires outbound internet), and media connects over UDP directly. The options below are for special network environments.

### TURN/TLS Fallback Relay

Use case: the server or clients sit behind networks that **block UDP** (corporate firewalls, some campus networks), making STUN direct connections impossible.

How it works: the browser connects to the server's TURN relay over **TCP 5349**, and media is forwarded through the relay. The address is a domain name (resolved via DNS), so no public IP is needed. UDP direct connections are still attempted in parallel — TURN is only a fallback and does not affect low-latency direct connections.

The relay is enabled automatically when all three variables are set:

```yaml
# Append to docker-compose.linux-single.yml
    ports:
      - "5349:5349"      # TURN/TLS relay (TCP)
    environment:
      - LIVEKIT_TURN_DOMAIN=zviewer.example.com
      - LIVEKIT_TURN_CERT=/app/cert/live/zviewer.example.com/fullchain.pem
      - LIVEKIT_TURN_KEY=/app/cert/live/zviewer.example.com/privkey.pem
    volumes:
      - /etc/letsencrypt:/app/cert:ro   # Mount host certificate directory
```

- The domain must match the certificate and resolve to this server
- A **CA-issued certificate is required** (Let's Encrypt etc.) — self-signed certificates are not trusted by browser WebRTC
- Set `LIVEKIT_TURN_EXTERNAL_TLS=true` when TLS is terminated by an external reverse proxy

### Manual ICE Address (`LIVEKIT_NODE_IP`)

When STUN discovery fails (fully offline intranet deployment, unusual NAT), ICE would advertise unreachable internal addresses. In that case, specify the server's public IP manually:

```yaml
    environment:
      - LIVEKIT_NODE_IP=203.0.113.10   # Host public IP; use the v6 address for direct IPv6 scenarios
```

An explicit value takes the highest priority (STUN auto-discovery is skipped when set).

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
| `LIVEKIT_EXTERNAL` | `1` skips the bundled LiveKit and uses an external service | `0` |
| `LIVEKIT_BIND` | Bundled LiveKit listen address | `::` (dual-stack) |
| `LIVEKIT_NODE_IP` | ICE advertised address; leave empty to enable LiveKit's native STUN external IP discovery (requires outbound internet), set manually for complex NAT | (auto) |
| `LIVEKIT_TURN_DOMAIN` | TURN/TLS domain (enables the TCP 5349 fallback relay when set together with CERT/KEY; domain-based addressing needs no public IP) | — |
| `LIVEKIT_TURN_CERT` | TURN TLS certificate path (CA-issued required; self-signed is not trusted by browser WebRTC) | — |
| `LIVEKIT_TURN_KEY` | TURN TLS private key path | — |

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