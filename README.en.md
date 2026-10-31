# ZViewer

> Watch movies, listen to music and talk over voice — together, in one room.

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

| ![](https://raw.githubusercontent.com/Zero-wyc/Image/main/All/20261003200919255.webp) | ![](https://raw.githubusercontent.com/Zero-wyc/Image/main/All/20261003200942428.webp) |
| ------------------------------------------------------------ | ------------------------------------------------------------ |
| ![](https://raw.githubusercontent.com/Zero-wyc/Image/main/All/20261003200643035.webp) | ![](https://raw.githubusercontent.com/Zero-wyc/Image/main/All/20261003200707122.webp) |
| ![](https://raw.githubusercontent.com/Zero-wyc/Image/main/All/20260930211758831.webp) | ![](https://raw.githubusercontent.com/Zero-wyc/Image/main/All/20261003201053941.webp) |
| ![](https://raw.githubusercontent.com/Zero-wyc/Image/main/All/20261003200715093.webp) | ![](https://raw.githubusercontent.com/Zero-wyc/Image/main/All/20261003201139524.webp) |

## Features

- **Watch together**: synchronized group viewing; the host controls playback, viewers can request pause / seek
- **Video sources**: Bilibili (premium quality), MP4 direct links, WebDAV / FTP / OpenList, Emby / Jellyfin, server local folders
- **Format compatibility**: MKV / AVI / TS / WMV, DTS / AC3 / EAC3 audio
- **Danmaku & subtitles**: Bilibili, DandanPlay, local files; multiple subtitle tracks with independent font sizes
- **Voice & sharing**: voice chat, WebRTC screen sharing
- **OBS streaming**: RTMP push and low-latency delivery inside the room
- **Listen together**: NetEase Cloud Music × Bilibili; playlists auto-filled, one-click favorites into both folders
- **High quality, low bandwidth**: pair with [ZViewerCLI](https://github.com/Zero-wyc/ZViewerCLI) for a local proxy
- **Interface**: Material You themes, custom backgrounds, glassmorphism
- **Deployment**: Docker / single-file builds work out of the box, one-click auto update

> Chrome / Edge 130+ is recommended. Safari and Firefox have incomplete MSE / MKV support — you may see stuttering or subtitle glitches.

## ZViewerCLI

[ZViewerCLI](https://github.com/Zero-wyc/ZViewerCLI) (Go) is a local resolver/proxy: it streams with your own Bilibili cookie so everyone in the room gets premium quality while barely using server bandwidth.

## Quick Start

On first startup a ROOT administrator is created automatically: `root` / `root`. **Change the password immediately.**

### Windows Desktop (recommended)

Download [`zviewer-windows-x64-GUI.zip`](https://github.com/Zero-wyc/ZViewer/releases/download/latest/zviewer-windows-x64-GUI.zip), unzip it and run `ZViewerDesktop.exe`, then follow the prompts.

### Single-file build

| Platform | File | After unzipping |
| --- | --- | --- |
| Windows | [zviewer-windows-x64.zip](https://github.com/Zero-wyc/ZViewer/releases/download/latest/zviewer-windows-x64.zip) | run `start.bat` |
| Linux | [zviewer-linux-x64.tar.gz](https://github.com/Zero-wyc/ZViewer/releases/download/latest/zviewer-linux-x64.tar.gz) | run `./start.sh` |

Then open `http://localhost:3333`. For stable versions, pick one from [Releases](https://github.com/Zero-wyc/ZViewer/releases).

### Docker

```bash
docker run -d --name zviewer --restart unless-stopped \
  -p 3333:3333 -p 3333:3333/udp -p 3334:3334 -p 3337:3337 \
  -v zviewer-data:/app/config \
  zerowyc0721/zviewer:latest
```

### From source

```bash
npm install
npm run db:init
npm run build
npm start
```

Requires Go 1.26+ and Node.js 22+; see [Development](#development).

## Windows Desktop App

`ZViewerDesktop.exe` is a Go + WebView2 native shell (Wails v2 — no Electron, no runtime to install). The app itself stays in the browser; the shell hosts the backend and the network entry points.

| Capability | Notes |
| --- | --- |
| Tray & single instance | Closing the window keeps it in the tray; launching again only restores the open window |
| Process hosting | Starts / stops the backend, LiveKit and ZViewerCLI; first launch with no database runs `--init-db` (`root` / `root`, change it after login) |
| Ports & HTTPS | Port is configurable and persisted; can issue a certificate for localhost |
| Remote access | IPv6 direct, provider FRP, self-hosted FRP (exports `frpc.toml`), EasyTier mesh, one-click Cloudflare Tunnel |
| Premium proxy | Bundled ZViewerCLI on `9333`, bound to `127.0.0.1`, QR login, can start with the service |
| On-demand components | cloudflared / frpc / EasyTier / LiveKit download on first use — not shipped in the installer |
| Auto update | Checks once 6 s after start, then every 6 hours; streaming download + structure check + restart |
| Logs | Filtered by voice / tunnel / cli / update, level and keyword; last 500 entries kept |

Tunnel and IPv6 conventions: [IMPLEMENTATION-CLOUDFLARE-TUNNEL.md](desktop/IMPLEMENTATION-CLOUDFLARE-TUNNEL.md) (Chinese).

### Layout

| Path | Contents |
| --- | --- |
| `ZViewerDesktop.exe` | GUI entry point |
| `assets/ZViewer.ProcessHost.exe` | Process supervisor host |
| `runtime/` | Backend, LiveKit, CLI, web UI; components land here too |
| `runtime/.env`, `runtime/config` | Backend environment and business data |
| `%APPDATA%/ZViewerDesktop` | GUI settings, certificates, FRP credentials, logs |
| `%USERPROFILE%/.zviewer/config.json` | ZViewerCLI login config |

The whole folder can be copied elsewhere — nothing to install. Before updating, quit the console and back up `.env`, `config` and the user config folder.

### Build

Requires Go 1.26+, Node.js 22+, Python 3.11+ (packaging) and the built-in C# compiler (for the supervisor host).

```powershell
node build-all.js --win               # build the Windows runtime first
npm --prefix desktop run shell:build  # build/bin/ZViewerDesktop.exe (--console for logs)
npm --prefix desktop run shell:dist   # dist-gui/
npm --prefix desktop run package      # ZIP + SHA256
```

UI files are embedded into the EXE via `go:embed`, so editing `desktop/ui/` needs a rebuild (use `npm --prefix desktop run preview` while iterating). Checks: `cd desktop && go vet ./... && go test ./...`.

```text
zviewer-windows-x64-GUI/
  ZViewerDesktop.exe                # single entry point
  assets/ZViewer.ProcessHost.exe    # process supervisor host
  runtime/                          # backend, LiveKit, CLI, web UI
  licenses, BUILD-MANIFEST.json
```

Do not run `cd desktop && go build -tags production .` — it overwrites the committed `desktop/desktop.exe`.

### Third-party components

| Component | Version | License | Location |
| --- | --- | --- | --- |
| [frp](https://github.com/fatedier/frp) client | 0.71.1 | Apache-2.0 | downloaded to `runtime/frpc.exe` |
| [EasyTier](https://github.com/EasyTier/EasyTier) | 2.6.4 | LGPL-3.0 | downloaded to `runtime/mesh/` |
| [ZViewerCLI](https://github.com/Zero-wyc/ZViewerCLI) | 0.2.1 | MIT | shipped as `runtime/zviewer-cli-windows-amd64.exe` |
| [LiveKit](https://github.com/livekit/livekit) server | 1.13.7 | Apache-2.0 | downloaded to `runtime/livekit-server.exe` |

All are unmodified binaries redistributed as-is, each keeping its license: frp / EasyTier under `assets/LICENSE-*.txt`, LiveKit and the CLI inside `runtime/`.

## Development

For people changing this repository. Deployment options are in [DEPLOYMENT.md](DEPLOYMENT.md) (Chinese).

- **Two independent Go modules, no module at the root**: `backend-go/` (`zviewer/backend`) and `desktop/` (`zviewer/desktop`) build separately and share no internal packages.
- In production the Go server serves the SPA; during development Vite runs on 5174 and proxies `/api`, `/socket.io` and `/live` to 3333.
- Voice is an embedded LiveKit companion process; OBS streaming and listen-together run inside the backend process, no external service.
- `config/` is not committed (database, certificates, uploads, HLS segments) — a fresh clone must run `npm run db:init`.

| Dependency | Version |
| --- | --- |
| Go | 1.26+ (desktop shell 1.25+) |
| Node.js | 22+ |
| npm | 10+ |
| Git Bash | Windows only, for `backend-go/scripts/*.sh` |

Optional: OBS (streaming), `sqlite3`, WebView2 (desktop shell development).

| Path | Contents |
| --- | --- |
| `frontend/` | React 18 + Vite SPA, alias `@/` → `src/` |
| `backend-go/internal/api` | HTTP layer; business logic in sibling `<domain>` packages; SQL in `internal/store` |
| `backend-go/internal/db` | Open, schema verification, indexes, DDL, backup |
| `backend-go/scripts` | Smoke / regression scripts |
| `backend-go/testdata/contract` | Endpoint and event contract snapshots (189 endpoints / 65 events) |
| `desktop/` | Wails desktop shell, `controller/` manages processes and certificates |
| `scripts/` | Hot reload, artifact build, launchers |

| Command | Purpose |
| --- | --- |
| `npm run dev` | Both ends (backend restarts on save) |
| `npm run dev:backend` / `dev:backend:once` / `dev:frontend` | One end only |
| `npm run build` / `build:backend` / `build:frontend` | Artifacts into `dist/` |
| `npm run build:all` | Pick a platform interactively, outputs `dist/win` or `dist/linux` |
| `npm run db:init` / `db:backup` | Create the database / hot backup (`VACUUM INTO`) |
| `npm run lint:go` / `test:go` | `gofmt -l` + `go vet` / `go test ./...` |
| `npm run lint` / `npm test -w frontend` | eslint (0 error 0 warning) / frontend unit tests |
| `npm run test:regression` | Full regression, about 1 min 45 s |

Change the backend port with `PORT`, point the frontend at it with `VITE_API_TARGET`. Port map: 3333 backend + web, 5174 Vite, 3334/3335 RTMP and HTTP-FLV, 3336/3337/3338 LiveKit.

Regression scripts each cover one area (`route-parity`, `events-parity`, `bilibili-smoke`, `frontend-smoke`, `soak`, …) and always work on a database copy, never `config/dev.sqlite`. Run one alone: `bash backend-go/scripts/profile-smoke.sh`.

### Database

1. **Never create tables or add columns at startup**. `VerifySchema` exits when a table or key column is missing.
2. **`internal/db/schema.sql` is the single source of truth** and is only used by `--init-db`; indexes live in `internal/db/indexes.go` and are created idempotently at startup.
3. **Adding a column touches four places**: `schema.sql` → store `columns` + `scanXxx` + `INSERT/UPDATE` → legacy-database migration statement (no migration framework) → run the regression suite.
4. **Never back up with `cp`**: under WAL the latest transaction sits in `-wal`, copying only the main file silently loses data.

### Conventions

- **Backend**: `internal/api` → `internal/<domain>` → `internal/store`, one-way dependencies; responses go through `httpx.OK / Fail`; column names are quoted camelCase; time comparisons use `datetime('now')`.
- **Frontend**: always the `@/` alias; UI from `@/components/ui`, dialogs from `ui/Modal`, durations via `formatDuration(Ms)`; `components/` must not depend on `modules/room`.
- **Not used**: ORM / query builders, automatic DDL on the startup path.

### Release

`.github/workflows/build.yml` does not build on every push to main: trigger it manually and enter `vX.Y.Z` for a stable release (tag + Release + artifact repo + GitCode sync); leave it empty for a `latest` pre-release.

| Secret | Purpose |
| --- | --- |
| `RELEASE_REPO_TOKEN` | PAT with `contents:write` on `ZviewerRelease` |
| `GITCODE_TOKEN` | Write access to `ZViewer` and `ZviewerRelease` |

Optional components (cloudflared, frpc, EasyTier, LiveKit) live on the **`components` branch** of `ZviewerRelease`: `main` there is replaced wholesale by an orphan commit on every release, which would wipe them.

Update source: both the web UI and the desktop app have a "use mirror update source" switch (on by default). Manifests and installers come from GitCode raw, the preference is stored in `config/update-source.json` / the GUI `settings.json`, and operators can override with `ZVIEWER_UPDATE_SOURCE=github|gitcode|mirror`. There is **no automatic fallback** — pick the mirror and only the mirror is used; failures are reported so the switch can be turned off.

## Documentation

| Topic | Where |
| --- | --- |
| Deployment (ports, Docker, environment variables, streaming, voice) | [DEPLOYMENT.md](DEPLOYMENT.md) (Chinese) |
| Full user guide | [docx.zviewer.zero251.xyz](https://docx.zviewer.zero251.xyz) (Chinese) |
| Cloud tunnel internals | [desktop/IMPLEMENTATION-CLOUDFLARE-TUNNEL.md](desktop/IMPLEMENTATION-CLOUDFLARE-TUNNEL.md) (Chinese) |
| High-quality proxy CLI | [ZViewerCLI](https://github.com/Zero-wyc/ZViewerCLI) |
| Mobile app (in development) | [ZViewerAPP](https://github.com/Zero-wyc/ZViewerAPP) |

## Community

[Telegram](https://t.me/Zero_251)　|　[QQ group](https://qm.qq.com/q/MuKPRVz8wc)

## Star History

<a href="https://star-history.com/#Zero-wyc/ZViewer&Zero-wyc/ZViewerCLI&Zero-wyc/ZViewerAPP&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=Zero-wyc/ZViewer,Zero-wyc/ZViewerCLI,Zero-wyc/ZViewerAPP&type=Date&theme=dark&v=2" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=Zero-wyc/ZViewer,Zero-wyc/ZViewerCLI,Zero-wyc/ZViewerAPP&type=Date&v=2" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=Zero-wyc/ZViewer,Zero-wyc/ZViewerCLI,Zero-wyc/ZViewerAPP&type=Date&v=2" />
 </picture>
</a>
