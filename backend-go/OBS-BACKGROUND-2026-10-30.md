# OBS Background Browser Presence

## Problem

An OBS room could report its sharer offline while RTMP publishing continued.
Two independent paths caused this:

- A browser Socket.IO connection was actively disconnected when its access JWT
  expired. Socket.IO does not automatically reconnect after a server disconnect,
  and the web client did not recover that case.
- Joining, listing, and cleaning rooms used the browser sharer session without
  checking the active OBS publisher. The join grace is five minutes; the host
  reconnect grace is ten minutes. These windows are not a fixed 30-40 minute
  timeout.

The trigger in an existing deployment still requires its logs to distinguish JWT
expiry, ping timeout, and a closed transport. This change was tested locally with
isolated fixture data.

## Behavior

- Natural JWT expiry sends `auth-expired` with `code: TOKEN_EXPIRED` before
  disconnecting. The shared web socket refreshes credentials and reconnects,
  with up to three attempts and one/three-second delays between attempts.
  Existing connect handlers restore the host registration.
- Temporary refresh failures such as HTTP 502, 503, and 429 remain retryable.
  Only an explicit 401 or 403 marks the refresh session as expired.
- Recovery is restricted to expiry notifications. Kicks, room closure, and token
  revocation retain their existing disconnect behavior. Recovery is cancelled on
  logout, identity changes, socket replacement, or removal of all subscribers.
- The embedded media service exposes per-key publishing activity. A new RTMP
  publisher has the configured startup window; nonempty audio/video packets
  extend it. Metadata, empty packets, old publisher leases, and a listening media
  port cannot keep a source online. Current publish authorization is also required.
- `STREAM_PUSH_OFFLINE_GRACE_SECONDS` sets the stop and missing-media threshold:
  integer seconds from 1 to 3600, default 60. A stopped recent publisher retains
  presence for that window, independently of its ended RTMP connection and FLV
  subscriptions. Restarting within the window keeps the source online. An
  already stale connection cannot become online again by closing.
- The existing two-second heartbeat reports `stream-status` to OBS viewers,
  including those without playback memory. After the threshold, notifications
  arrive on the next heartbeat (normally within two seconds). Joining and
  reconnecting sockets also receive a state snapshot. An absent browser host's
  old five-minute join grace cannot bypass the OBS media threshold.
- Live FLV players reconnect on both normal stream end and transport failure.
  After fast retries they continue every ten seconds while mounted, so an OBS
  restart late in the offline grace can still resume playback. Offline state or
  leaving the room unmounts the player and cancels retries.
- A live publisher keeps its OBS room online for listing and viewer admission
  after the browser session ends. New approval requests still require a connected
  browser host; prior approval remains valid while the source is live.
- Browser disconnect ends its session and host permissions normally. It does not
  announce the live OBS source as offline. Reconnect-grace checks repeat while
  media is active, so stopped or stale publishers can still return to normal
  closure. The media threshold is separate from the ten-minute host reconnect
  grace and the automatic room deletion setting. A connected browser can remain
  a room host while its media source is offline. Explicit room closure continues
  to work.
- Periodic inactive-room cleanup skips active OBS sources.

External media servers have no trusted per-stream presence API in the current
integration. They retain the previous browser-session presence behavior. The
per-stream protection described above applies to the embedded RTMP service.

This change does not prevent a browser or operating system from freezing or
discarding a page. Browser control still requires an active page; OBS media
presence can continue independently.

## Validation

Run from the repository root:

```text
npm run build
npm run lint:go
npm run test:go
npm test -w frontend
npm run test:socket-auth
npm run test:flv-live
npm run test:obs-background -- --binary <absolute-path-to-built-server>
```

The OBS regression requires Node.js with `node:sqlite`, `socket.io-client`, and
FFmpeg with `libx264`. Without `--binary` it builds a temporary server. It runs
hidden child processes, publishes generated video without audio, uses a new
temporary database, and cleans up its sockets, processes, and temporary files.
It never reads a deployment's configuration or captures the desktop.

The fixture moves the disconnected host session forty minutes into the past
and uses a two-second media threshold to test real stop, grace-period rejoin,
restart, and expiry. It also restores a recent browser disconnect timestamp to
check the media threshold cannot be bypassed. Room unit tests exercise four
expired reconnect-grace callbacks directly. These checks accelerate the timeout
conditions; they are not a forty-minute browser background soak test or
acceptance of a deployed NAS. FLV tests simulate recovery after a fifty-second
outage with a fake clock.

The existing full-tree frontend lint includes unrelated validation artifacts,
vendor files, and CRLF formatting failures. Targeted lint of `useSocket.ts`,
`api.ts`, and `flv-engine.ts` passes. Socket authentication covers 23 cases;
live FLV recovery covers eight cases.
The legacy shell regression scripts contain another machine's absolute
paths; the OBS regression instead probes all 189 route contracts on its isolated
server across ten integration checks, and the event fixture audit covers
65 incoming room events.

The Windows environment used for this check has no C compiler configured for
CGO, so Go race instrumentation was unavailable.
