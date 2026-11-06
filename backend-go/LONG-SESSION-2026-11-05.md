# Long-running room recovery

## Bilibili media renewal

- The bundled web player checks CDN deadlines, including URLs nested in the
  stream proxy. The host re-resolves video and audio before expiry and retains
  position, playback rate, and playback intent.
- Listen Together invalidates the exact BVID/CID cache entry before re-resolving.
  Media errors also trigger recovery. Requests are single-flight, rate limited,
  and capped until successful playback advances.
- Late results cannot restart a different track, room, or disposed player.
  A viewer no longer pauses buffered playback solely because the host's old
  source URL passed its deadline.

## Socket authentication

- Registered access tokens default to 24 hours and refresh tokens to 30 days.
  Both remain configurable. HTTPS cookies use the issued token's actual expiry;
  guest token durations remain unchanged.
- A connected socket can renew access on the server using the refresh credential
  supplied in its initial HttpOnly cookie or handshake auth. Background browser
  timers are not required for renewal, and socket identity and room membership
  survive access expiry.
- The original refresh credential remains the expiry and revocation boundary.
  Password changes, disabled accounts, and role changes still invalidate it.
  Access-only clients retain the existing expiry notice and reconnect protocol.
- Extending JWT durations alone cannot repair missing room listeners or media
  URL expiry. TURN certificate paths must use the ordinary `NAME=value` syntax,
  but no certificate or deployment settings are changed by this fix.

## Members and moderators

- Member and moderator listeners now live at room-page scope for every room
  mode, including Listen Together, independently of the settings panel.
- `get-room-members` requires an admitted session in the requested room. The
  snapshot contains connected viewers with persistent user IDs, moderator IDs,
  and muted user IDs. It excludes disconnected socket records.
- Snapshots are pushed after host registration and viewer admission and queried
  on reconnect, foreground return, and every 30 seconds. Older query responses
  cannot overwrite newer join, leave, moderator, or snapshot events.
- Moderator appointment reports a disconnected socket or a missing response.
  The existing user-ID-based appointment protocol is preserved; no new
  username/UID lookup or offline appointment feature is introduced.

## Validation

- `go test ./...` and `go vet ./...` in `backend-go`.
- `npm run test:long-session` covers CDN deadlines, cache invalidation, progress
  restoration, retry bounds, cancellation, and member snapshot ordering.
- `npm run test:socket-auth` covers existing browser authentication recovery.
- `npm run build` builds the Go server and bundled web frontend.
- Isolated browser acceptance used an 8-second access TTL. The host retained
  the same socket across repeated expiry and a 12-second page freeze. A missed
  join event repaired itself without refreshing; viewer reconnect preserved
  moderator identity, and dismissal and reappointment both succeeded.
- The existing OBS background integration regression and FLV recovery tests
  passed. The broader music/media commands are currently blocked by their
  existing i18n alias and `normalizeBiliPages` mock resolution failures.
- The Go race detector was not run: this Windows environment has no CGO
  compiler.

Tests use isolated fixtures and accelerated expiry. They do not establish
multi-hour browser suspension, real Bilibili CDN acceptance, or NAS deployment
acceptance.
