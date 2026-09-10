import { useState } from 'react'
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
import { useVoiceChat, type VoiceMember } from '../hooks/useVoiceChat'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { Slider } from '@/components/ui/Slider'
import { message } from '@/components/ui/message'

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
  socket,
  roomId,
  username,
  canManageVoice = false,
  embedded = false,
}: VoiceChatPanelProps) {
  const [expanded, setExpanded] = useState(false)
  const [editingPeer, setEditingPeer] = useState<string | null>(null)
  const {
    joined,
    joining,
    micEnabled,
    members,
    globalVolume,
    peerVolumes,
    peerLatencies,
    micVolume,
    monitorEnabled,
    audioLevels,
    voiceMutedBySocket,
    join,
    leave,
    toggleMic,
    toggleMonitor,
    setGlobalVolume,
    setPeerVolume,
    setMicVolume,
    muteVoiceMember,
    kickVoiceMember,
  } = useVoiceChat({ socket, roomId, username })

  if (!roomId) return null

  const memberCount = members.length
  const isMe = (socketId: string) => socketId === socket?.id
  /** 成员显示名：登录用户为真实用户名；游客（userId=0）加短后缀消歧义 */
  const displayName = (member: VoiceMember, me: boolean) => {
    if (me) return '我'
    const name = member.username?.trim()
    if (name && member.userId > 0) return name
    if (name && name !== '游客' && name !== 'guest') return name
    return `游客 ${member.socketId.slice(0, 4).toUpperCase()}`
  }

  /** 展开态面板内容（悬浮模式与嵌入模式共用；嵌入模式填满父容器） */
  const panel = (
    <div
      className={cn(
        'glass-card flex flex-col overflow-hidden p-3',
        embedded ? 'h-full w-full' : 'zen-modal-content-enter w-64'
      )}
      style={
        embedded ? undefined : { maxHeight: 'min(420px, calc(100vh - 160px))' }
      }
    >
      {/* 标题栏 */}
      <div className="mb-2 flex items-center gap-2">
        <div
          className="flex h-8 w-8 items-center justify-center rounded-[var(--md-sys-shape-corner)]"
          style={{
            backgroundColor: 'var(--md-sys-color-primary-container)',
            color: 'var(--md-sys-color-on-primary-container)',
          }}
        >
          <Headphones className="h-4 w-4" />
        </div>
        <div className="flex flex-1 flex-col">
          <span className="text-sm font-medium text-[var(--md-sys-color-on-surface)]">
            语音聊天
          </span>
          <span className="text-[10px] uppercase tracking-wide text-[var(--md-sys-color-on-surface-variant)]">
            {joined ? `${memberCount} 人在线` : '未连接'}
          </span>
        </div>
        {!embedded && (
          <button
            onClick={() => setExpanded(false)}
            className="rounded-full p-1 text-[var(--md-sys-color-on-surface-variant)] transition-colors hover:bg-[var(--md-sys-color-surface-container-highest)]"
          >
            <ChevronDown className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* 全局音量 */}
      {joined && (
        <div className="mb-1.5 rounded-[var(--md-sys-radius-small)] bg-[var(--glass-bg)] px-2 py-1.5">
          <div className="mb-0.5 text-xs font-medium text-[var(--md-sys-color-on-surface)]">
            全局音量
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
            麦克风音量
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
            const me = isMe(member.socketId)
            const peerVolume = peerVolumes.get(member.socketId) ?? 1
            const levelKey = me ? 'self' : member.socketId
            const audioLevel = audioLevels.get(levelKey) ?? 0
            const memberMuted = voiceMutedBySocket.has(member.socketId)
            return (
              <div
                key={member.socketId}
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
                    title={memberMuted ? '已被语音禁言' : undefined}
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
                  {!me && (
                    <span className="text-[10px] tabular-nums text-[var(--md-sys-color-on-surface-variant)]">
                      {peerLatencies.has(member.socketId)
                        ? `${peerLatencies.get(member.socketId)}ms`
                        : '-'}
                    </span>
                  )}
                  {me && !micEnabled && (
                    <MicOff className="h-3 w-3 text-[var(--md-sys-color-error)]" />
                  )}
                  {!me && (
                    <button
                      onClick={() =>
                        setEditingPeer((prev) =>
                          prev === member.socketId ? null : member.socketId
                        )
                      }
                      className={cn(
                        'rounded-full p-1 transition-colors',
                        editingPeer === member.socketId
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
                          void muteVoiceMember(
                            member.socketId,
                            !memberMuted
                          ).then((res) => {
                            if (!res.success && res.message) {
                              message.error(res.message)
                            }
                          })
                        }}
                        className="rounded-full p-1 text-[var(--md-sys-color-on-surface-variant)] transition-colors hover:bg-[var(--md-sys-color-surface-container-highest)]"
                        title={memberMuted ? '解除语音禁言' : '语音禁言'}
                      >
                        {memberMuted ? (
                          <Volume2 className="h-3.5 w-3.5" />
                        ) : (
                          <VolumeX className="h-3.5 w-3.5" />
                        )}
                      </button>
                      <button
                        onClick={() => {
                          void kickVoiceMember(member.socketId).then((res) => {
                            if (res.success) {
                              message.success(
                                `已将 ${displayName(member, false)} 移出语音`
                              )
                            } else if (res.message) {
                              message.error(res.message)
                            }
                          })
                        }}
                        className="rounded-full p-1 text-[var(--md-sys-color-on-surface-variant)] transition-colors hover:bg-[var(--md-sys-color-surface-container-highest)]"
                        title="移出语音"
                      >
                        <UserX className="h-3.5 w-3.5" />
                      </button>
                    </>
                  )}
                </div>
                {!me && editingPeer === member.socketId && (
                  <div className="mt-2">
                    <Slider
                      size="sm"
                      label="单独音量"
                      value={Math.round(peerVolume * 100)}
                      min={0}
                      max={100}
                      step={1}
                      valueFormatter={(v) => `${v}%`}
                      onChange={(v) => setPeerVolume(member.socketId, v / 100)}
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
          点击加入即可与房间内其他观众语音交流
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
              {micEnabled ? '静音' : '取消静音'}
            </Button>
            <Button
              variant={monitorEnabled ? 'primary' : 'secondary'}
              size="sm"
              icon={<Headphones className="h-3.5 w-3.5" />}
              onClick={toggleMonitor}
              title={monitorEnabled ? '关闭反送' : '开启反送'}
            />
            <Button
              variant="danger"
              size="sm"
              className="flex-1"
              icon={<PhoneOff className="h-3.5 w-3.5" />}
              onClick={leave}
            >
              断开
            </Button>
          </>
        ) : (
          <Button
            variant="primary"
            size="sm"
            block
            loading={joining}
            icon={<Phone className="h-3.5 w-3.5" />}
            onClick={join}
          >
            加入语音
          </Button>
        )}
      </div>
    </div>
  )

  // 嵌入模式（一起听右侧工具坞）：直接渲染展开态面板，显隐由工具坞控制
  if (embedded) return panel

  return createPortal(
    <div
      className={cn(
        'fixed bottom-6 right-6 z-40 flex flex-col items-end gap-3',
        'transition-all duration-300'
      )}
    >
      {/* 展开的语音面板 */}
      {expanded && panel}

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
          title="语音聊天"
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
    </div>,
    document.body
  )
}
