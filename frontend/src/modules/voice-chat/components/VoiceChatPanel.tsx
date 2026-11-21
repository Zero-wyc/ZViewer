import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  Users,
  Headphones,
  ChevronDown,
  Volume2,
  VolumeX,
  UserX,
} from 'lucide-react'
import type { Socket } from 'socket.io-client'
// v7：LiveKit 版语音（SFU 由独立 LiveKit 服务承载）
import { useVoiceChat, type VoiceMember } from '../hooks/useVoiceChat'
import { useVoiceStatus } from '../hooks/useVoiceStatus'
import { cn } from '@/lib/utils'
import { useFullscreenOverlayStore } from '@/store/fullscreenOverlayStore'
import { Button } from '@/components/ui/Button'
import { SectionHeader } from '@/components/ui/SectionHeader'
import { Slider } from '@/components/ui/Slider'
import { message } from '@/components/ui/message'
import { t } from '@/i18n'

interface VoiceChatPanelProps {
  socket: Socket | null
  roomId: string | undefined
  username?: string
  /** 是否为房主（已废弃，码率固定不再需要房主权限） */
  isHost?: boolean
  /** 语音管理权限（房主或房管）：显示禁言/踢出按钮 */
  canManageVoice?: boolean
  /** 嵌入模式（一起听右侧工具坞）：不 portal / 不渲染触发按钮，直接渲染
   *  展开态面板并填满父容器，收起按钮隐藏（显隐由工具坞 Tab 控制） */
  embedded?: boolean
}

export function VoiceChatPanel({
  roomId,
  username,
  canManageVoice = false,
  embedded = false,
}: VoiceChatPanelProps) {
  const [expanded, setExpanded] = useState(false)
  const [editingPeer, setEditingPeer] = useState<string | null>(null)

  // 全屏浮层宿主（播放器全屏时由 PlayerChrome / WatchTogetherCore 注册舞台）：
  // 有宿主就把浮球 portal 进舞台内部，并按宿主实测的控制栏高度抬到它上方，
  // 随控制栏一起显隐——否则原生全屏下 body 上的 fixed 浮球根本不可见，网页
  // 全屏下又会被 z-[100] 的舞台盖住（用户报「全屏时按钮挡住控制栏」）。
  const overlayTarget = useFullscreenOverlayStore((store) => store.target)
  const overlayBarVisible = useFullscreenOverlayStore(
    (store) => store.controlBarVisible
  )
  const overlayBarHeight = useFullscreenOverlayStore(
    (store) => store.controlBarHeight
  )
  const commentPaneOrientation = useFullscreenOverlayStore(
    (store) => store.commentPaneOrientation
  )
  const commentPaneSize = useFullscreenOverlayStore(
    (store) => store.commentPaneSize
  )
  const inOverlay = overlayTarget !== null && !embedded

  // portal 容器只创建一次：全屏切换时在舞台/body 之间搬父节点，React 子树
  // 不重挂，避免语音连接因重挂而断线。
  const [portalHost] = useState(() => {
    const host = document.createElement('div')
    host.style.display = 'contents'
    return host
  })
  useEffect(() => {
    const parent = inOverlay && overlayTarget ? overlayTarget : document.body
    parent.appendChild(portalHost)
    return () => {
      portalHost.remove()
    }
  }, [inOverlay, overlayTarget, portalHost])
  const {
    joined,
    joining,
    micEnabled,
    mediaConnected,
    selfId,
    members,
    transport,
    globalVolume,
    peerVolumes,
    micVolume,
    monitorEnabled,
    audioLevels,
    voiceMutedIds,
    join,
    leave,
    toggleMic,
    toggleMonitor,
    setGlobalVolume,
    setPeerVolume,
    setMicVolume,
    muteVoiceMember,
    kickVoiceMember,
  } = useVoiceChat({ roomId, username })

  // 媒体面没起来时对端永远不会发 offer，点「加入」只会一直转圈——
  // 那是用户最难自查的一种失败，所以在入口就拦住并说明。
  const { available } = useVoiceStatus()
  const unavailable = available === false

  if (!roomId) return null

  const memberCount = members.length
  const isMe = (id: string) => id === selfId
  /** 成员显示名：LiveKit name 缺失时以 id 尾号消歧义 */
  const displayName = (member: VoiceMember, me: boolean) => {
    if (me) return t('我')
    const name = member.username?.trim()
    if (name && name !== '游客' && name !== 'guest') return name
    return t('游客 {{value}}', { value: member.id.slice(-4).toUpperCase() })
  }

  /** 展开态面板内容（悬浮模式与嵌入模式共用；嵌入模式在工具坞内纵向堆叠，
   *  高度自适应并设上限：成员较多时面板内部滚动，不影响相邻面板可见性） */
  const panel = (
    <div
      className={cn(
        'glass-card flex flex-col overflow-hidden p-3',
        embedded
          ? 'w-full max-h-[min(50vh,420px)]'
          : 'zen-modal-content-enter w-64'
      )}
      style={
        embedded ? undefined : { maxHeight: 'min(420px, calc(100vh - 160px))' }
      }
    >
      {/* 标题栏 */}
      <SectionHeader
        icon={<Headphones className="h-4 w-4" />}
        title={t('语音聊天')}
        className="mb-2"
        subtitle={
          <div className="flex items-center gap-1.5">
            {/* 媒体未连通时明确显示「连接中」而不是人数——connect 成功不等于
                ICE 连通（代理/UDP 被拦时成员列表照常，但无声），避免误导。
                独处房间没有可建的边（Piik 不下发 connections），此时
                mediaConnected 直接是 true，正常显示「1 人在线」。 */}
            <span className="text-[10px] uppercase tracking-wide text-[var(--md-sys-color-on-surface-variant)]">
              {!joined
                ? t('未连接')
                : memberCount === 0
                  ? t('连接中…')
                  : mediaConnected
                    ? t('{{memberCount}} 人在线', { memberCount })
                    : t('媒体连接中…')}
            </span>
            {/* 媒体传输协议徽标：ICE 选中线路（UDP 直连 / TCP 兜底），周期实测非配置值；
                媒体未连通时无有效线路可测，一并隐藏 */}
            {joined && mediaConnected && transport && (
              <span
                className="rounded-full px-1.5 py-px text-[9px] font-semibold tracking-wide"
                style={{
                  backgroundColor:
                    transport === 'udp'
                      ? 'var(--md-sys-color-primary-container)'
                      : 'var(--md-sys-color-tertiary-container)',
                  color:
                    transport === 'udp'
                      ? 'var(--md-sys-color-on-primary-container)'
                      : 'var(--md-sys-color-on-tertiary-container)',
                }}
                title={
                  transport === 'udp'
                    ? t('语音媒体传输：UDP 直连（低延迟）')
                    : t('语音媒体传输：TCP 直连（UDP 被拦截时的兜底线路）')
                }
              >
                {transport.toUpperCase()}
              </span>
            )}
          </div>
        }
        extra={
          !embedded && (
            <button
              onClick={() => setExpanded(false)}
              className="rounded-full p-1 text-[var(--md-sys-color-on-surface-variant)] transition-colors hover:bg-[var(--md-sys-color-surface-container-highest)]"
            >
              <ChevronDown className="h-4 w-4" />
            </button>
          )
        }
      />

      {/* 全局音量 */}
      {joined && (
        <div className="mb-1.5 rounded-[var(--md-sys-radius-small)] bg-[var(--glass-bg)] px-2 py-1.5">
          <div className="mb-0.5 text-xs font-medium text-[var(--md-sys-color-on-surface)]">
            {t('全局音量')}
          </div>
          <div className="flex items-center gap-2">
            <Slider
              size="sm"
              showValue={false}
              value={Math.round(globalVolume * 100)}
              min={0}
              max={100}
              step={1}
              onChange={(v) => setGlobalVolume(v / 100)}
              className="flex-1"
            />
            <span className="w-9 text-right text-xs font-medium tabular-nums text-[var(--md-sys-color-on-surface-variant)]">
              {Math.round(globalVolume * 100)}%
            </span>
          </div>
        </div>
      )}

      {/* 麦克风音量（对所有远端用户生效） */}
      {joined && (
        <div className="mb-1.5 rounded-[var(--md-sys-radius-small)] bg-[var(--glass-bg)] px-2 py-1.5">
          <div className="mb-0.5 text-xs font-medium text-[var(--md-sys-color-on-surface)]">
            {t('麦克风音量')}
          </div>
          <div className="flex items-center gap-2">
            <Slider
              size="sm"
              showValue={false}
              value={Math.round(micVolume * 100)}
              min={0}
              max={100}
              step={1}
              onChange={(v) => setMicVolume(v / 100)}
              className="flex-1"
            />
            <span className="w-9 text-right text-xs font-medium tabular-nums text-[var(--md-sys-color-on-surface-variant)]">
              {Math.round(micVolume * 100)}%
            </span>
          </div>
        </div>
      )}

      {/* 成员列表 */}
      {joined && memberCount > 0 && (
        <div className="mb-2 flex-1 space-y-1.5 overflow-y-auto pr-1">
          {members.map((member) => {
            const me = isMe(member.id)
            const peerVolume = peerVolumes.get(member.id) ?? 1
            const levelKey = me ? 'self' : member.id
            const audioLevel = audioLevels.get(levelKey) ?? 0
            const memberMuted = voiceMutedIds.has(member.id)
            return (
              <div
                key={member.id}
                className="rounded-[var(--md-sys-radius-small)] bg-[var(--glass-bg)] px-2 py-1.5"
              >
                <div className="flex items-center gap-2">
                  <div
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full"
                    style={{
                      backgroundColor: me
                        ? 'var(--md-sys-color-primary-container)'
                        : 'var(--md-sys-color-surface-container-high)',
                      color: me
                        ? 'var(--md-sys-color-on-primary-container)'
                        : 'var(--md-sys-color-on-surface-variant)',
                    }}
                  >
                    {me ? (
                      micEnabled ? (
                        <Mic className="h-3 w-3" />
                      ) : (
                        <MicOff className="h-3 w-3" />
                      )
                    ) : (
                      <Users className="h-3 w-3" />
                    )}
                  </div>
                  <span
                    className={cn(
                      'shrink-0 truncate text-xs font-medium',
                      memberMuted
                        ? 'text-[var(--md-sys-color-error)]'
                        : 'text-[var(--md-sys-color-on-surface)]'
                    )}
                    title={memberMuted ? t('已被语音禁言') : undefined}
                  >
                    {displayName(member, me)}
                  </span>
                  {memberMuted && (
                    <VolumeX className="h-3 w-3 shrink-0 text-[var(--md-sys-color-error)]" />
                  )}
                  {/* 横向实时音量条 */}
                  <div className="flex h-1.5 flex-1 items-center overflow-hidden rounded-full bg-[var(--md-sys-color-surface-container-high)]">
                    <div
                      className="h-full rounded-full transition-[width] duration-75"
                      style={{
                        width: `${Math.max(2, audioLevel * 100)}%`,
                        backgroundColor:
                          audioLevel > 0.05
                            ? 'var(--md-sys-color-primary)'
                            : 'var(--md-sys-color-outline)',
                      }}
                    />
                  </div>
                  {me && !micEnabled && (
                    <MicOff className="h-3 w-3 text-[var(--md-sys-color-error)]" />
                  )}
                  {!me && (
                    <button
                      onClick={() =>
                        setEditingPeer((prev) =>
                          prev === member.id ? null : member.id
                        )
                      }
                      className={cn(
                        'rounded-full p-1 transition-colors',
                        editingPeer === member.id
                          ? 'bg-[var(--md-sys-color-primary-container)] text-[var(--md-sys-color-on-primary-container)]'
                          : 'text-[var(--md-sys-color-on-surface-variant)] hover:bg-[var(--md-sys-color-surface-container-highest)]'
                      )}
                    >
                      <Volume2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                  {/* 语音管理：房主/房管可禁言/踢出其他成员 */}
                  {canManageVoice && !me && (
                    <>
                      <button
                        onClick={() => {
                          void muteVoiceMember(member.id, !memberMuted).then(
                            (res) => {
                              if (!res.success && res.message) {
                                message.error(res.message)
                              }
                            }
                          )
                        }}
                        className="rounded-full p-1 text-[var(--md-sys-color-on-surface-variant)] transition-colors hover:bg-[var(--md-sys-color-surface-container-highest)]"
                        title={memberMuted ? t('解除语音禁言') : t('语音禁言')}
                      >
                        {memberMuted ? (
                          <Volume2 className="h-3.5 w-3.5" />
                        ) : (
                          <VolumeX className="h-3.5 w-3.5" />
                        )}
                      </button>
                      <button
                        onClick={() => {
                          void kickVoiceMember(member.id).then((res) => {
                            if (res.success) {
                              message.success(
                                t('已将 {{value}} 移出语音', {
                                  value: displayName(member, false),
                                })
                              )
                            } else if (res.message) {
                              message.error(res.message)
                            }
                          })
                        }}
                        className="rounded-full p-1 text-[var(--md-sys-color-on-surface-variant)] transition-colors hover:bg-[var(--md-sys-color-surface-container-highest)]"
                        title={t('移出语音')}
                      >
                        <UserX className="h-3.5 w-3.5" />
                      </button>
                    </>
                  )}
                </div>
                {!me && editingPeer === member.id && (
                  <div className="mt-2">
                    <Slider
                      size="sm"
                      label={t('单独音量')}
                      value={Math.round(peerVolume * 100)}
                      min={0}
                      max={100}
                      step={1}
                      valueFormatter={(v) => `${v}%`}
                      onChange={(v) => setPeerVolume(member.id, v / 100)}
                    />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* 未加入提示 */}
      {!joined && !joining && (
        <div className="mb-3 text-center text-xs text-[var(--md-sys-color-on-surface-variant)]">
          {unavailable
            ? t('语音服务当前不可用（媒体端口未就绪），请稍后再试')
            : t('点击加入即可与房间内其他观众语音交流')}
        </div>
      )}

      {/* 操作按钮 */}
      <div className="flex gap-2">
        {joined ? (
          <>
            <Button
              variant="secondary"
              size="sm"
              className="flex-1 whitespace-nowrap"
              icon={
                micEnabled ? (
                  <Mic className="h-3.5 w-3.5" />
                ) : (
                  <MicOff className="h-3.5 w-3.5" />
                )
              }
              onClick={toggleMic}
            >
              {micEnabled ? t('静音') : t('取消静音')}
            </Button>
            <Button
              variant={monitorEnabled ? 'primary' : 'secondary'}
              size="sm"
              icon={<Headphones className="h-3.5 w-3.5" />}
              onClick={toggleMonitor}
              title={monitorEnabled ? t('关闭反送') : t('开启反送')}
            />
            <Button
              variant="danger"
              size="sm"
              className="flex-1"
              icon={<PhoneOff className="h-3.5 w-3.5" />}
              onClick={leave}
            >
              {t('断开')}
            </Button>
          </>
        ) : (
          <Button
            variant="primary"
            size="sm"
            block
            loading={joining}
            disabled={unavailable}
            icon={<Phone className="h-3.5 w-3.5" />}
            onClick={join}
          >
            {t('加入语音')}
          </Button>
        )}
      </div>
    </div>
  )

  // 嵌入模式（一起听右侧工具坞）：直接渲染展开态面板，显隐由工具坞控制
  if (embedded) return panel

  const floating = (
    <div
      className={cn(
        // 全屏浮层里控制栏是贴底整条（z-[80]），浮球必须按宿主实测高度抬起
        // 并排到它上面，否则会被整块盖住、点不到。
        inOverlay
          ? 'absolute right-6 z-40 flex flex-col items-end gap-3 transition-opacity duration-300'
          : 'fixed bottom-6 right-6 flex flex-col items-end gap-3',
        // 展开时要压过 Live2D 的宿主层（fixed inset-0，z-60）：那一层虽然
        // pointer-events 为 none，但它的入口圆钮（右下 right-6/bottom-84）
        // 正好落在面板右上角，层级低一点就会被圆钮"贴"在面板上，看着像
        // 面板被戳了个洞。折叠时只是个 48px 圆钮，不跟任何东西抢，保持
        // 原来的 40，不必压过角色画布。
        expanded ? 'z-[70]' : 'z-40',
        'transition-all duration-300',
        // 全屏浮层与控制栏同步显隐；隐藏时放行指针事件（点一下画面控制栏回来）
        inOverlay && !overlayBarVisible && 'pointer-events-none opacity-0'
      )}
      style={
        inOverlay
          ? {
              // 控制栏实测高度 + 8px；还没测到时用 88（桌面常见值）。
              // 竖屏上下分屏时再让出评论面板的高度。
              bottom:
                (overlayBarHeight || 88) +
                8 +
                (commentPaneOrientation === 'stacked' ? commentPaneSize : 0),
              // 横屏左右分屏：右边界对齐画面右侧而不是舞台右侧
              ...(commentPaneOrientation === 'side'
                ? { right: commentPaneSize + 24 }
                : null),
            }
          : undefined
      }
    >
      {/* 展开的语音面板：收起时用 hidden 隐藏而不是卸载——语音连接与成员状态
          由面板内的 hook 持有，卸载即断线。 */}
      <div className={cn(expanded ? '' : 'hidden')}>{panel}</div>

      {/* 悬浮触发按钮 */}
      {!expanded && (
        <button
          onClick={() => setExpanded(true)}
          className={cn(
            'glass-card flex h-12 w-12 items-center justify-center rounded-full shadow-lg transition-all duration-200',
            'hover:scale-105 hover:shadow-xl active:scale-95',
            joined && 'ring-2 ring-[var(--md-sys-color-primary)]'
          )}
          style={{
            backgroundColor: joined
              ? 'var(--md-sys-color-primary-container)'
              : 'var(--glass-bg)',
            color: joined
              ? 'var(--md-sys-color-on-primary-container)'
              : 'var(--md-sys-color-on-surface)',
          }}
          title={t('语音聊天')}
        >
          {joined ? (
            micEnabled ? (
              <Mic className="h-5 w-5" />
            ) : (
              <MicOff className="h-5 w-5" />
            )
          ) : (
            <Headphones className="h-5 w-5" />
          )}
          {joined && memberCount > 1 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--md-sys-color-primary)] px-1 text-[10px] font-medium text-[var(--md-sys-color-on-primary)]">
              {memberCount}
            </span>
          )}
        </button>
      )}
    </div>
  )

  return createPortal(floating, portalHost)
}
