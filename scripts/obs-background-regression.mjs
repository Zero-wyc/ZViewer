import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { io } from 'socket.io-client'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const binaryIndex = process.argv.indexOf('--binary')
const workspace = await mkdtemp(path.join(os.tmpdir(), 'zviewer-obs-regression-'))
const binary =
  binaryIndex >= 0
    ? path.resolve(process.argv[binaryIndex + 1])
    : path.join(workspace, process.platform === 'win32' ? 'server.exe' : 'server')
const children = new Set()
const sockets = new Set()
const secrets = new Set()
const checks = []
const testSecret = 'obs-regression-only-access-secret'
const offlineGraceSeconds = 2
let fixture
let streamReader

function redact(value) {
  let text = String(value)
  for (const secret of secrets) {
    if (secret) text = text.replaceAll(secret, '[redacted]')
  }
  return text
    .replace(/rtmp:\/\/\S+/g, 'rtmp://[redacted]')
    .replace(/ticket=[^&\s"]+/g, 'ticket=[redacted]')
}

function start(command, args, options = {}) {
  const child = spawn(command, args, {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  })
  children.add(child)
  child.output = ''
  child.stdoutText = ''
  child.panicSeen = false
  child.on('error', (error) => {
    child.failure = error
  })
  child.stdout.on('data', (chunk) => {
    child.stdoutText = (child.stdoutText + chunk).slice(-40000)
  })
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => {
      child.output = (child.output + chunk).slice(-12000)
      child.panicSeen ||= child.output.includes('[panic]')
    })
  }
  child.on('exit', () => children.delete(child))
  return child
}

async function run(command, args, options) {
  const child = start(command, args, options)
  const [code] = await once(child, 'exit')
  assert.equal(code, 0, `${path.basename(command)} failed: ${redact(child.output)}`)
  return child
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill()
  await Promise.race([
    exited,
    new Promise((_, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`${path.basename(child.spawnfile)} did not exit`))
      }, 5000)
      timer.unref()
    }),
  ])
}

async function freePort() {
  const server = net.createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function waitFor(predicate, label, timeout = 10000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
  throw new Error(`Timed out: ${label}`)
}

async function connectSocket(base, token) {
  const socket = io(base, {
    auth: { token },
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    autoConnect: false,
    timeout: 5000,
  })
  sockets.add(socket)
  const connected = once(socket, 'connect')
  const failed = new Promise((_, reject) => socket.once('connect_error', reject))
  socket.connect()
  await Promise.race([connected, failed])
  return socket
}

async function ack(socket, event, payload) {
  return socket.timeout(5000).emitWithAck(event, payload)
}

function shortenToken(token) {
  const [header, body] = token.split('.')
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString())
  claims.exp = Math.floor(Date.now() / 1000) + 2
  const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const signed = `${header}.${encoded}`
  return `${signed}.${createHmac('sha256', testSecret).update(signed).digest('base64url')}`
}

try {
  if (binaryIndex < 0) {
    await run('go', ['build', '-o', binary, './cmd/zviewer-server'], {
      cwd: path.join(repo, 'backend-go'),
    })
  }
  const [port, rtmpPort, flvPort] = await Promise.all([freePort(), freePort(), freePort()])
  assert.equal(new Set([port, rtmpPort, flvPort]).size, 3, 'Test ports must be distinct')
  const base = `http://127.0.0.1:${port}`
  const database = path.join(workspace, 'dev.sqlite')
  const env = {
    ...process.env,
    PROJECT_ROOT: workspace,
    CONFIG_DIR: workspace,
    DATABASE_URL: database,
    UPLOADS_DIR: path.join(workspace, 'uploads'),
    MEDIA_DIR: path.join(workspace, 'media'),
    HOST: '127.0.0.1',
    PORT: String(port),
    HTTPS: 'false',
    LIVEKIT_EXTERNAL: '1',
    STREAM_PUSH_ENABLED: '1',
    STREAM_PUSH_OFFLINE_GRACE_SECONDS: String(offlineGraceSeconds),
    NMS_EMBEDDED: '1',
    NMS_HTTP_FLV_URL: '',
    NMS_BIND: '127.0.0.1',
    RTMP_PORT: String(rtmpPort),
    HTTP_FLV_PORT: String(flvPort),
    JWT_ACCESS_SECRET: testSecret,
    JWT_REFRESH_SECRET: 'obs-regression-only-refresh-secret',
    JWT_ACCESS_EXPIRES_IN: '1h',
  }
  await run(binary, ['--init-db', '--admin-user', 'obs-fixture-owner'], {
    env,
    cwd: workspace,
  })
  fixture = new DatabaseSync(database)
  fixture.exec('PRAGMA busy_timeout=5000')
  fixture.exec(`INSERT INTO system_settings
    (autoDeleteInactiveRooms, autoDeleteAfterHours, roomCreationMode)
    VALUES (1, 1, 'all-users')`)
  const addUser = fixture.prepare(`INSERT INTO user (username, passwordHash, role, status)
    SELECT ?, passwordHash, 'user', 'active' FROM user WHERE username='obs-fixture-owner'`)
  const users = [
    'obs-fixture-viewer-1',
    'obs-fixture-viewer-2',
    'obs-fixture-viewer-3',
    'obs-fixture-viewer-4',
    'obs-fixture-viewer-5',
  ]
  const userIDs = users.map((name) => Number(addUser.run(name).lastInsertRowid))
  const server = start(binary, [], { env, cwd: workspace })
  await waitFor(async () => {
    if (server.failure) throw server.failure
    if (server.exitCode !== null) throw new Error(`Server exited: ${redact(server.output)}`)
    try {
      return (await fetch(`${base}/health`)).ok
    } catch {
      return false
    }
  }, 'isolated server startup')

  async function request(route, { token, body, method = 'GET' } = {}) {
    const response = await fetch(base + route, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(5000),
    })
    const result = await response.json()
    assert.ok(response.ok && result.success !== false, `Request failed: ${route}`)
    if (result.accessToken) secrets.add(result.accessToken)
    if (result.refreshToken) secrets.add(result.refreshToken)
    return result
  }

  async function login(username) {
    return request('/api/auth/login', {
      method: 'POST',
      body: { username, password: 'root' },
    })
  }

  const owner = await login('obs-fixture-owner')
  const identities = await Promise.all(users.map(login))
  const host = await connectSocket(base, owner.accessToken)
  const created = await ack(host, 'create-room', { mode: 'screen-share', name: 'OBS fixture' })
  assert.equal(created.success, true, 'Host must create the fixture room')
  const roomID = created.data.roomId
  const method = await ack(host, 'update-share-method', {
    roomId: roomID,
    shareMethod: 'stream-push',
  })
  assert.equal(method.success, true, 'Embedded RTMP service must be available')
  const streamKey = method.data.streamKey
  assert.equal(typeof streamKey, 'string')
  secrets.add(streamKey)
  function startPublisher() {
    return start(
      process.env.FFMPEG || 'ffmpeg',
      [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-re',
        '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=5',
        '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
        '-g', '5', '-b:v', '80k', '-f', 'flv',
        `rtmp://127.0.0.1:${rtmpPort}/live/${streamKey}`,
      ],
      { cwd: workspace },
    )
  }
  let publisher = startPublisher()
  const first = await connectSocket(base, identities[0].accessToken)
  const streamStatuses = []
  first.on('stream-status', (state) => {
    if (state?.roomId === roomID) streamStatuses.push(state.status)
  })
  const joined = await ack(first, 'request-join', { roomId: roomID })
  assert.equal(joined.success, true, 'Initial viewer must join')
  let disconnectNotice = false
  first.on('host-disconnected', () => {
    disconnectNotice = true
  })

  async function readFLV(token) {
    const grant = await request(`/api/stream-push/watch/${roomID}`, { token })
    const flv = await fetch(base + grant.url, { signal: AbortSignal.timeout(8000) })
    assert.equal(flv.status, 200, 'Viewer must receive HTTP-FLV')
    const reader = flv.body.getReader()
    let bytes = Buffer.alloc(0)
    while (bytes.length < 64) {
      const { value, done } = await reader.read()
      assert.equal(done, false, 'HTTP-FLV must remain live')
      bytes = Buffer.concat([bytes, value])
    }
    assert.equal(bytes.subarray(0, 3).toString(), 'FLV', 'RTMP must produce a real FLV stream')
    return { reader, bytes: bytes.length }
  }

  const initialStream = await readFLV(identities[0].accessToken)
  streamReader = initialStream.reader
  assert.equal(publisher.exitCode, null, `Publisher exited: ${redact(publisher.output)}`)
  await waitFor(() => streamStatuses.at(-1) === 'live', 'existing viewers receive live stream status')
  checks.push('real RTMP publisher and authenticated HTTP-FLV')
  const hostSocketID = host.id
  host.disconnect()
  await waitFor(
    () => fixture.prepare('SELECT endedAt FROM session WHERE socketId=?').get(hostSocketID)?.endedAt,
    'host session disconnect',
  )
  fixture.prepare(`UPDATE session SET endedAt=datetime('now', '-40 minutes')
    WHERE roomId=? AND role='sharer'`).run(roomID)
  const list = await request('/api/rooms', { token: identities[0].accessToken })
  assert.equal(list.rooms.find((room) => room.roomId === roomID)?.sharerOnline, true)
  assert.equal(disconnectNotice, false, 'Active OBS must suppress host-offline notification')
  checks.push('40-minute-old browser session still reports active OBS online')
  const second = await connectSocket(base, identities[1].accessToken)
  assert.equal((await ack(second, 'request-join', { roomId: roomID })).success, true)
  const nextStream = await readFLV(identities[1].accessToken)
  await nextStream.reader.cancel()
  checks.push('new viewer enters and receives FLV after browser join grace')
  assert.equal(
    (await ack(second, 'update-share-method', { roomId: roomID, shareMethod: 'webrtc' })).success,
    false,
    'OBS presence must not grant host permissions',
  )
  checks.push('viewer retains viewer permissions')

  fixture.prepare('UPDATE room SET requireApproval=1 WHERE roomId=?').run(roomID)
  const unapproved = await connectSocket(base, identities[2].accessToken)
  assert.equal(
    (await ack(unapproved, 'request-join', { roomId: roomID })).success,
    false,
    'New approval must require an online browser host',
  )
  fixture.prepare('UPDATE room SET approvedViewers=? WHERE roomId=?')
    .run(JSON.stringify([userIDs[3]]), roomID)
  const approved = await connectSocket(base, identities[3].accessToken)
  assert.equal((await ack(approved, 'request-join', { roomId: roomID })).success, true)
  checks.push('approval required for new users; prior approval remains valid')
  fixture.prepare('UPDATE room SET requireApproval=0 WHERE roomId=?').run(roomID)
  await streamReader.cancel()
  streamReader = undefined
  const interruptionStatusIndex = streamStatuses.length
  await stop(publisher)
  await new Promise((resolve) => setTimeout(resolve, 150))
  const graceList = await request('/api/rooms', { token: identities[0].accessToken })
  assert.equal(graceList.rooms.find((room) => room.roomId === roomID)?.sharerOnline, true)
  assert.equal(
    (await ack(unapproved, 'request-join', { roomId: roomID })).success,
    true,
    'Short RTMP interruption must retain viewer admission during the grace period',
  )
  assert.equal(disconnectNotice, false, 'Short RTMP interruption must not announce offline')
  checks.push('RTMP stop retains online presence and admission during the configured grace')
  publisher = startPublisher()
  const restartedStream = await readFLV(identities[2].accessToken)
  await restartedStream.reader.cancel()
  await new Promise((resolve) => setTimeout(resolve, offlineGraceSeconds * 1000 + 300))
  const restartedList = await request('/api/rooms', { token: identities[0].accessToken })
  assert.equal(restartedList.rooms.find((room) => room.roomId === roomID)?.sharerOnline, true)
  assert.equal(disconnectNotice, false, 'Restarted RTMP must cancel the prior offline deadline')
  assert.ok(
    !streamStatuses.slice(interruptionStatusIndex).includes('offline'),
    'Short RTMP interruption must not broadcast offline stream status',
  )
  checks.push('RTMP restart within grace restores FLV and survives the prior offline deadline')
  const finalStopAt = Date.now()
  await stop(publisher)
  await waitFor(async () => {
    const rooms = await request('/api/rooms', { token: identities[0].accessToken })
    return rooms.rooms.find((room) => room.roomId === roomID)?.sharerOnline === false
  }, 'stopped RTMP reports offline after the configured grace')
  assert.ok(
    Date.now() - finalStopAt >= offlineGraceSeconds * 1000 - 100,
    'RTMP must retain presence for the complete configured grace period',
  )
  await waitFor(
    () => streamStatuses.at(-1) === 'offline',
    'existing viewers receive offline stream status after RTMP grace',
  )
  await waitFor(() => disconnectNotice, 'existing viewers receive offline after RTMP grace')
  fixture.prepare(`UPDATE session SET endedAt=datetime('now')
    WHERE roomId=? AND role='sharer'`).run(roomID)
  const finalViewer = await connectSocket(base, identities[4].accessToken)
  const denied = await ack(finalViewer, 'request-join', { roomId: roomID })
  assert.equal(
    denied.success,
    false,
    'Expired RTMP grace must reject joins even when the browser disconnected recently',
  )
  checks.push('RTMP grace expiry broadcasts offline and rejects joins despite recent browser disconnect')

  const shortToken = shortenToken(owner.accessToken)
  secrets.add(shortToken)
  const expiring = await connectSocket(base, shortToken)
  const expiryEvents = []
  expiring.on('auth-expired', (marker) => {
    expiryEvents.push(`auth-expired:${marker?.code}`)
  })
  expiring.once('disconnect', () => {
    expiryEvents.push('disconnect')
  })
  const expired = once(expiring, 'disconnect')
  const [reason] = await Promise.race([
    expired,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Token expiry did not disconnect')), 5000)),
  ])
  assert.equal(reason, 'io server disconnect')
  assert.deepEqual(expiryEvents, ['auth-expired:TOKEN_EXPIRED', 'disconnect'])
  assert.equal(expiring.active, false, 'Server disconnect requires explicit client recovery')
  const refreshed = await request('/api/auth/refresh', {
    method: 'POST',
    body: { refreshToken: owner.refreshToken },
  })
  expiring.auth = { token: refreshed.accessToken }
  const recovered = once(expiring, 'connect')
  expiring.connect()
  await recovered
  assert.equal((await ack(expiring, 'register-host', { roomId: roomID })).success, true)
  checks.push('auth-expired marker precedes token disconnect, refresh and host recovery')
  const routeAudit = await run(
    process.execPath,
    [
      'backend-go/scripts/route-audit.js',
      '--fixture', 'backend-go/testdata/contract/routes.json',
      '--probe', base,
      '--json',
    ],
    { cwd: repo, env },
  )
  const routes = JSON.parse(routeAudit.stdoutText)
  assert.equal(routes.total, 189, 'Historical route contract must retain all 189 routes')
  assert.equal(routes.missing.length, 0)
  assert.equal(routes.skipped.length, 0)
  assert.equal(routes.timeouts.length, 0, 'Route existence must be verified by completed responses')
  assert.equal(server.panicSeen, false, 'Route audit must not panic the isolated server')
  checks.push('189 historical HTTP routes present without server panic')
  console.log(JSON.stringify({ passed: checks, initialFLVBytes: initialStream.bytes }, null, 2))
} catch (error) {
  console.error(redact(error.stack || error))
  process.exitCode = 1
} finally {
  if (streamReader) await streamReader.cancel().catch(() => {})
  for (const socket of sockets) socket.disconnect()
  await Promise.allSettled([...children].map(stop))
  fixture?.close()
  assert.equal(path.dirname(workspace), path.resolve(os.tmpdir()))
  assert.ok(path.basename(workspace).startsWith('zviewer-obs-regression-'))
  await rm(workspace, { recursive: true, force: true })
}
