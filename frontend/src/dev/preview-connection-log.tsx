/**
 * 连接日志的视觉预览页（只在本地调试时用，不参与构建）。
 *
 * 真实链路要两台设备协商才会产出日志，改版式时没法靠它验收。这里用一份
 * 抓下来的真实序列喂给状态面板，看的是排版、滚动区高度和颜色对比。
 *
 * 用法：`npm run dev` 后打开 `/preview-log.html`。
 */
import { createRoot } from 'react-dom/client'
import { ThemeProvider } from '@/components/ThemeProvider'
import { useThemeStore } from '@/store/themeStore'
import { SharingStatusPanel } from '@/modules/room/components/SharingStatusPanel'
import type { ShareEdgeStats } from '@/modules/screen-sharing/core/edge-stats'
import { emptyShareStats } from '@/modules/screen-sharing/core/stats'
import type { ConnectionLogEntry } from '@/modules/piik-share/connection-log'
import '@/index.css'

// `?dark=1` 切到深色：日志用的是 on-surface-variant + 语义色点，
// 深色基底上要确认对比度够。
if (new URLSearchParams(location.search).has('dark')) {
  useThemeStore.setState({ mode: 'dark', isDark: true })
}

const base = Date.now() - 9_000

/** 观众侧走中转时的一段完整日志：候选 → STUN 失败 → 打洞 → 中继建立。 */
const logs: ConnectionLogEntry[] = [
  {
    id: 1,
    at: base,
    level: 'warn',
    message: '直连不可用，改为从服务器接收',
    detail: 'conn-7f31',
  },
  {
    id: 2,
    at: base + 40,
    level: 'info',
    message: '开始从服务器拉流',
    detail: 'conn-7f31',
  },
  {
    id: 3,
    at: base + 320,
    level: 'info',
    message: '收集到本地候选：{{candidate}}',
    vars: { candidate: 'host/udp 192.168.1.8:54321' },
  },
  {
    id: 4,
    at: base + 470,
    level: 'info',
    message: '收集到本地候选：{{candidate}}',
    vars: { candidate: 'srflx/udp 203.0.113.5:54322' },
  },
  {
    id: 5,
    at: base + 2_100,
    level: 'warn',
    message: 'STUN 服务器不可达：{{url}}',
    vars: { url: 'stun:stun.l.google.com:19302' },
    detail: 'code=701',
  },
  {
    id: 6,
    at: base + 2_340,
    level: 'info',
    message: '收到远端候选：{{candidate}}',
    vars: { candidate: 'srflx/udp 198.51.100.7:60000' },
  },
  {
    id: 7,
    at: base + 2_900,
    level: 'info',
    message: 'ICE 状态：{{state}}',
    vars: { state: 'checking' },
    detail: 'conn-7f31',
  },
  {
    id: 8,
    at: base + 3_180,
    level: 'info',
    message: 'ICE 状态：{{state}}',
    vars: { state: 'connected' },
    detail: 'conn-7f31',
  },
  {
    id: 9,
    at: base + 3_260,
    level: 'ok',
    message: '打洞成功：{{local}} ↔ {{remote}}',
    vars: {
      local: 'srflx/udp 203.0.113.5:54322',
      remote: 'srflx/udp 198.51.100.7:60000',
    },
    detail: 'conn-7f31 · RTT 38 ms',
  },
  {
    id: 10,
    at: base + 3_300,
    level: 'ok',
    message: '服务器转发已建立',
    detail: 'conn-7f31',
  },
  { id: 11, at: base + 3_420, level: 'ok', message: '收到远端画面' },
  { id: 12, at: base + 3_450, level: 'ok', message: '收到远端声音' },
]

const edges: ShareEdgeStats[] = [
  {
    connectionId: 'conn-7f31',
    direction: 'inbound',
    state: 'connected',
    stats: emptyShareStats(),
  },
]

createRoot(document.getElementById('root')!).render(
  <ThemeProvider>
    <div
      className="min-h-screen p-6"
      style={{ backgroundColor: 'var(--md-sys-color-surface)' }}
    >
      <div className="mx-auto flex w-[380px] flex-col gap-4">
        <div className="h-[760px]">
          <SharingStatusPanel
            edges={edges}
            captureFps={null}
            mode="receiver"
            sharingMode="relay"
            connectionLog={logs}
            onClearLog={() => {}}
          />
        </div>
        {/* 无日志时的空态 */}
        <div className="h-[420px]">
          <SharingStatusPanel
            edges={[]}
            captureFps={null}
            mode="receiver"
            sharingMode="direct"
            connectionLog={[]}
          />
        </div>
      </div>
    </div>
  </ThemeProvider>
)
