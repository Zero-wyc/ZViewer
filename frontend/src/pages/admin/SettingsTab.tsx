import type { Dispatch, SetStateAction } from 'react'
import { Download, MonitorCog, Upload } from 'lucide-react'
import { AniSubsGithubBrowser } from '@/modules/admin/components/AniSubsGithubBrowser'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { InputNumber } from '@/components/ui/InputNumber'
import { Slider } from '@/components/ui/Slider'
import { Select } from '@/components/ui/Select'
import { Switch } from '@/components/ui/Switch'
import { Title, Text } from '@/components/ui/Typography'
import { Spinner } from '@/components/ui/Spinner'
import { cn } from '@/lib/utils'
import { useSystemSettingsStore } from '@/store/systemSettingsStore'
import type { AdminSettings } from './shared'
import {
  CMS_SOURCE_PRESETS,
  MATRIX_ACTIONS,
  MATRIX_ROLES,
  formatBytes,
} from './shared'
import type { SystemUpdateApi } from './useSystemUpdate'

interface SettingsTabProps {
  settings: AdminSettings
  /** 顶层 settings 的原始 setter（各控件就地行内更新，保持原有写法） */
  onSettingsChange: Dispatch<SetStateAction<AdminSettings>>
  settingsLoading: boolean
  savingSettings: boolean
  /** 房间默认音量的行内编辑状态（AdminPage 持有，UsersTab 的保存按钮联动） */
  editingMusicVolume: boolean
  musicVolumeDraft: string
  onMusicVolumeDraftChange: (value: string) => void
  onCommitMusicVolume: () => void
  onEditingMusicVolumeChange: (editing: boolean) => void
  onSaveSettings: () => void
  /** TVBox CMS 源检测 */
  cmsInspectUrl: string
  onCmsInspectUrlChange: (url: string) => void
  cmsInspecting: boolean
  onInspectCmsSource: () => void
  onCmsSourcesBlur: () => void
  /** 系统更新状态与动作（useSystemUpdate，状态由 AdminPage 持有跨 Tab 保持） */
  update: SystemUpdateApi
}

/** 系统设置 Tab（纯搬迁自 AdminPage，无行为变更） */
export function SettingsTab({
  settings,
  onSettingsChange,
  settingsLoading,
  savingSettings,
  editingMusicVolume,
  musicVolumeDraft,
  onMusicVolumeDraftChange,
  onCommitMusicVolume,
  onEditingMusicVolumeChange,
  onSaveSettings,
  cmsInspectUrl,
  onCmsInspectUrlChange,
  cmsInspecting,
  onInspectCmsSource,
  onCmsSourcesBlur,
  update,
}: SettingsTabProps) {
  const {
    updateInfo,
    updateLoading,
    applyLoading,
    uploadLoading,
    updateProgress,
    includePrerelease,
    setIncludePrerelease,
    fileInputRef,
    checkUpdate,
    handleApplyUpdate,
    handleFileUpload,
  } = update
  // 桌面 GUI 托管：整包版本由 GUI 维护，网页端不提供检查/更新入口
  const desktopManaged = useSystemSettingsStore((s) => s.desktopManaged)
  return (
    <div className="glass-card p-4">
      {settingsLoading ? (
        <div className="py-12">
          <Spinner tip="加载中..." size={32} />
        </div>
      ) : (
        <>
          <Title level={5} className="mb-4">
            房间自动清理设置
          </Title>
          <div className="mb-4">
            <Switch
              label="自动删除无人访问的房间"
              checked={settings.autoDeleteInactiveRooms}
              onChange={(e) =>
                onSettingsChange((prev) => ({
                  ...prev,
                  autoDeleteInactiveRooms: e.target.checked,
                }))
              }
            />
          </div>
          <div className="mb-6 max-w-xs">
            <InputNumber
              label="超过小时数未访问则自动删除"
              min={1}
              max={720}
              step={1}
              value={settings.autoDeleteAfterHours}
              disabled={!settings.autoDeleteInactiveRooms}
              onChange={(value) =>
                onSettingsChange((prev) => ({
                  ...prev,
                  autoDeleteAfterHours: value ?? 1,
                }))
              }
            />
          </div>

          <Title level={5} className="mb-4 mt-6">
            房间默认音量
          </Title>
          <div className="mb-6 max-w-md">
            <div className="mb-2 flex items-center justify-between text-sm text-[var(--md-sys-color-on-surface-variant)]">
              <span id="room-music-volume-label">一起听默认音量</span>
              {editingMusicVolume ? (
                <input
                  autoFocus
                  type="text"
                  inputMode="numeric"
                  aria-label="输入默认音量（0～100）"
                  value={musicVolumeDraft}
                  maxLength={3}
                  className="w-16 rounded-[var(--md-sys-shape-corner)] border border-[var(--md-sys-color-outline)] bg-[var(--md-sys-color-surface-container-high)] px-2 py-1 text-right tabular-nums focus:border-[var(--md-sys-color-primary)] focus:outline-none"
                  onChange={(e) => onMusicVolumeDraftChange(e.target.value)}
                  onFocus={(e) => e.currentTarget.select()}
                  onBlur={onCommitMusicVolume}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') onCommitMusicVolume()
                    if (e.key === 'Escape') onEditingMusicVolumeChange(false)
                  }}
                />
              ) : (
                <button
                  type="button"
                  aria-label="手动输入默认音量"
                  title="点击输入 0～100 的整数"
                  className="rounded-[var(--md-sys-shape-corner)] px-2 py-1 tabular-nums transition-colors hover:bg-[var(--md-sys-color-surface-container-high)] hover:text-[var(--md-sys-color-primary)]"
                  onClick={() => {
                    onMusicVolumeDraftChange(
                      String(settings.roomDefaultMusicVolume ?? 50)
                    )
                    onEditingMusicVolumeChange(true)
                  }}
                >
                  {settings.roomDefaultMusicVolume ?? 50}%
                </button>
              )}
            </div>
            <Slider
              aria-labelledby="room-music-volume-label"
              min={0}
              max={100}
              step={1}
              showValue={false}
              value={settings.roomDefaultMusicVolume ?? 50}
              onChange={(value) =>
                onSettingsChange((prev) => ({
                  ...prev,
                  roomDefaultMusicVolume: value,
                }))
              }
            />
            <p className="mt-1.5 text-xs text-[var(--md-sys-color-on-surface-variant)]">
              默认 50%。用户首次使用一起听时生效，之后按各自本地音量。
            </p>
          </div>

          <Title level={5} className="mb-4 mt-6">
            房间创建权限
          </Title>
          <div className="mb-6 max-w-md">
            <Select
              label="允许创建房间的用户范围"
              value={settings.roomCreationMode}
              options={[
                {
                  label: '仅管理员（root / admin）',
                  value: 'admin-only',
                },
                {
                  label: '所有登录用户（user / admin / root）',
                  value: 'all-users',
                },
              ]}
              onChange={(value) =>
                onSettingsChange((prev) => ({
                  ...prev,
                  roomCreationMode: value as 'admin-only' | 'all-users',
                }))
              }
            />
            <p className="mt-1.5 text-xs text-[var(--md-sys-color-on-surface-variant)]">
              设为所有登录用户后，普通用户也可创建房间；游客始终不可创建。
            </p>
          </div>

          <Title level={5} className="mb-4 mt-6">
            自定义 LiveKit 服务器地址
          </Title>
          <div className="mb-6 max-w-md">
            <Input
              label="LiveKit 服务器地址（可选）"
              value={settings.livekitExternalUrl}
              onChange={(e) =>
                onSettingsChange((prev) => ({
                  ...prev,
                  livekitExternalUrl: e.target.value,
                }))
              }
              placeholder="留空自动推导（如 wss://livekit.example.com）"
            />
            <p className="mt-1.5 text-xs text-[var(--md-sys-color-on-surface-variant)]">
              留空按页面域名推导；填外部地址时需与本站共用同一 Key / Secret，
              且媒体端口对该地址可达。
            </p>
          </div>

          <Title level={5} className="mb-4 mt-6">
            多页面登录（仅供测试）
          </Title>
          <div className="mb-6 max-w-md">
            <Switch
              label="允许单用户在多个页面同时登录同一房间"
              checked={settings.roomMultiInstanceLogin}
              onChange={(e) =>
                onSettingsChange((prev) => ({
                  ...prev,
                  roomMultiInstanceLogin: e.target.checked,
                }))
              }
            />
            <p className="mt-1.5 text-xs text-[var(--md-sys-color-on-surface-variant)]">
              开启后同一账号可在多个页面同时进入房间与语音，成员表会出现重名。
            </p>
          </div>

          <Title level={5} className="mb-4 mt-6">
            房间悬浮入口
          </Title>
          <div className="mb-6 max-w-md space-y-4">
            <div>
              <Switch
                label="显示语音聊天按钮"
                checked={settings.showVoiceChatButton}
                onChange={(e) =>
                  onSettingsChange((prev) => ({
                    ...prev,
                    showVoiceChatButton: e.target.checked,
                  }))
                }
              />
              <p className="mt-1.5 text-xs text-[var(--md-sys-color-on-surface-variant)]">
                关闭后房间右下角不显示语音入口。
              </p>
            </div>
            <div>
              <Switch
                label="显示流量统计按钮"
                checked={settings.showTrafficPanel}
                onChange={(e) =>
                  onSettingsChange((prev) => ({
                    ...prev,
                    showTrafficPanel: e.target.checked,
                  }))
                }
              />
              <p className="mt-1.5 text-xs text-[var(--md-sys-color-on-surface-variant)]">
                关闭后房间左下角不显示流量统计。
              </p>
            </div>
          </div>

          <Title level={5} className="mb-4 mt-6">
            公告
          </Title>
          <div className="mb-6 max-w-md">
            <Switch
              label="版本更新后自动弹出公告"
              checked={settings.announceAutoPopupOnUpdate}
              onChange={(e) =>
                onSettingsChange((prev) => ({
                  ...prev,
                  announceAutoPopupOnUpdate: e.target.checked,
                }))
              }
            />
            <p className="mt-1.5 text-xs text-[var(--md-sys-color-on-surface-variant)]">
              公告正文取仓库根目录的 announce.md。开启后版本号变化时自动弹出，关闭后仅首次启动弹出一次。
            </p>
          </div>

          <Title level={5} className="mb-4 mt-6">
            房间权限管理
          </Title>
          <div className="mb-6 max-w-2xl">
            <p className="mb-2 text-xs text-[var(--md-sys-color-on-surface-variant)]">
              勾选各角色作为观众时可执行的动作。房主与 root 始终放行，不参与勾选；未勾选按默认：房管与管理员允许，普通用户禁止。
            </p>
            <div
              className="overflow-x-auto rounded-[var(--md-sys-shape-corner)] border border-[var(--md-sys-color-outline)]"
              style={{
                borderColor: 'var(--md-sys-color-outline-variant)',
              }}
            >
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr
                    style={{
                      backgroundColor:
                        'var(--md-sys-color-surface-container-high)',
                    }}
                  >
                    <th className="border-collapse px-3 py-2 text-left font-medium text-[var(--md-sys-color-on-surface-variant)]">
                      动作
                    </th>
                    {MATRIX_ROLES.map((r) => (
                      <th
                        key={r.key}
                        className="border-collapse px-3 py-2 text-center font-medium text-[var(--md-sys-color-on-surface-variant)]"
                      >
                        {r.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {MATRIX_ACTIONS.map((action) => (
                    <tr
                      key={action.key}
                      className="border-t"
                      style={{
                        borderColor: 'var(--md-sys-color-outline-variant)',
                      }}
                    >
                      <td className="px-3 py-2 text-[var(--md-sys-color-on-surface)]">
                        {action.label}
                      </td>
                      {MATRIX_ROLES.map((role) => (
                        <td key={role.key} className="px-3 py-2 text-center">
                          <input
                            type="checkbox"
                            className="h-4 w-4 cursor-pointer"
                            checked={
                              settings.roomPermissionMatrix?.[action.key]?.[
                                role.key
                              ] ?? (role.key === 'user' ? false : true)
                            }
                            onChange={(e) =>
                              onSettingsChange((prev) => ({
                                ...prev,
                                roomPermissionMatrix: {
                                  ...prev.roomPermissionMatrix,
                                  [action.key]: {
                                    ...prev.roomPermissionMatrix?.[action.key],
                                    [role.key]: e.target.checked,
                                  },
                                },
                              }))
                            }
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <Title level={5} className="mb-4 mt-6">
            Beta 功能
          </Title>
          <div className="mb-6">
            <Switch
              label="启用 Beta 功能（Kazumi / AniSubs 番剧源 / B站视频下载）"
              checked={settings.betaFeaturesEnabled}
              onChange={(e) =>
                onSettingsChange((prev) => ({
                  ...prev,
                  betaFeaturesEnabled: e.target.checked,
                }))
              }
            />
            <p className="mt-1.5 text-xs text-[var(--md-sys-color-on-surface-variant)]">
              关闭后隐藏 Kazumi、AniSubs 番剧源与 B站视频下载入口。
            </p>
          </div>

          {settings.betaFeaturesEnabled && (
            <>
              <Title level={5} className="mb-4 mt-6">
                Kazumi 规则源
              </Title>
              <div className="mb-4">
                <label className="mb-1.5 block text-sm font-medium text-[var(--md-sys-color-on-surface-variant)]">
                  Kazumi 规则、索引或官方仓库地址（每行一个）
                </label>
                <textarea
                  rows={4}
                  className="w-full rounded-[var(--md-sys-shape-corner)] border border-[var(--md-sys-color-outline)] bg-[var(--md-sys-color-surface-container-high)] px-3 py-2 text-sm text-[var(--md-sys-color-on-surface)] placeholder:text-[var(--md-sys-color-on-surface-variant)] focus:border-[var(--md-sys-color-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--md-sys-color-primary)]"
                  placeholder="https://raw.githubusercontent.com/Predidit/KazumiRules/main/DM84.json"
                  value={(settings.dataSourceConfig?.kazumiRules || []).join(
                    '\n'
                  )}
                  onChange={(e) =>
                    onSettingsChange((prev) => ({
                      ...prev,
                      dataSourceConfig: {
                        ...prev.dataSourceConfig,
                        kazumiRules: e.target.value
                          .split('\n')
                          .map((s) => s.trim())
                          .filter(Boolean),
                      },
                    }))
                  }
                />
                <p className="mt-1 text-xs text-[var(--md-sys-color-on-surface-variant)]">
                  留空用内置默认规则。支持规则 JSON、index.json 与 Kazumi 仓库地址；依赖 WebView 或验证码的规则可能无法播放。
                </p>
              </div>

              <div className="mb-6">
                <AniSubsGithubBrowser
                  repoUrl="https://github.com/Predidit/KazumiRules"
                  defaultPath=""
                  title="从 KazumiRules 仓库选择规则"
                  allowAddAll={false}
                  existingUrls={settings.dataSourceConfig?.kazumiRules || []}
                  onAddUrls={(urls) =>
                    onSettingsChange((prev) => ({
                      ...prev,
                      dataSourceConfig: {
                        ...prev.dataSourceConfig,
                        kazumiRules: [
                          ...(prev.dataSourceConfig?.kazumiRules || []),
                          ...urls,
                        ],
                      },
                    }))
                  }
                />
              </div>

              <Title level={5} className="mb-4 mt-6">
                TVBox 采集源（CMS）
              </Title>
              <div className="mb-6">
                <label className="mb-1.5 block text-sm font-medium text-[var(--md-sys-color-on-surface-variant)]">
                  TVBox 配置接口地址（提取其中的苹果 CMS 采集站，检测后加入下方列表）
                </label>
                <div className="mb-2 flex gap-2">
                  <Input
                    value={cmsInspectUrl}
                    onChange={(e) => onCmsInspectUrlChange(e.target.value)}
                    placeholder="https://example.com/jsm.json"
                    className="flex-1"
                  />
                  <Button
                    onClick={onInspectCmsSource}
                    loading={cmsInspecting}
                    disabled={cmsInspecting}
                  >
                    检测并添加
                  </Button>
                </div>
                <div className="mb-2 flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-[var(--md-sys-color-on-surface-variant)]">
                    常用接口一键填入：
                  </span>
                  {CMS_SOURCE_PRESETS.map((preset) => (
                    <button
                      key={preset.url}
                      type="button"
                      onClick={() => onCmsInspectUrlChange(preset.url)}
                      disabled={cmsInspecting}
                      className="rounded-full border border-[var(--md-sys-color-outline-variant)] bg-[var(--md-sys-color-surface-container-high)] px-2.5 py-1 text-xs text-[var(--md-sys-color-on-surface-variant)] transition-colors hover:border-[var(--md-sys-color-primary)] hover:text-[var(--md-sys-color-on-surface)] disabled:opacity-40"
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
                <textarea
                  rows={3}
                  className="w-full rounded-[var(--md-sys-shape-corner)] border border-[var(--md-sys-color-outline)] bg-[var(--md-sys-color-surface-container-high)] px-3 py-2 text-sm text-[var(--md-sys-color-on-surface)] placeholder:text-[var(--md-sys-color-on-surface-variant)] focus:border-[var(--md-sys-color-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--md-sys-color-primary)]"
                  placeholder="https://raw.githubusercontent.com/qist/tvbox/master/jsm.json"
                  value={(settings.dataSourceConfig?.cmsSources || []).join(
                    '\n'
                  )}
                  onChange={(e) =>
                    onSettingsChange((prev) => ({
                      ...prev,
                      dataSourceConfig: {
                        ...prev.dataSourceConfig,
                        cmsSources: e.target.value
                          .split('\n')
                          .map((s) => s.trim())
                          .filter(Boolean),
                      },
                    }))
                  }
                  onBlur={onCmsSourcesBlur}
                />
                <p className="mt-1 text-xs text-[var(--md-sys-color-on-surface-variant)]">
                  留空则不启用。仅支持苹果 CMS（type 1）采集站，jar 与 JS 规则源不支持；编辑后失焦自动保存。
                </p>
              </div>
            </>
          )}

          <Title level={5} className="mb-4 mt-6">
            服务器 DASH 流
          </Title>
          <div className="mb-6">
            <Switch
              label="禁用服务器端 DASH 模式"
              checked={settings.dashDisabled}
              onChange={(e) =>
                onSettingsChange((prev) => ({
                  ...prev,
                  dashDisabled: e.target.checked,
                }))
              }
            />
            <p className="mt-1.5 text-xs text-[var(--md-sys-color-on-surface-variant)]">
              开启后服务器端解析只用 MP4，不影响 CLI 代理的 DASH 模式。
            </p>
          </div>

          <Title level={5} className="mb-4 mt-6">
            B站 默认解析参数
          </Title>
          <div className="mb-6 max-w-md">
            <Select
              label="添加影片时的默认解析模式（普通视频）"
              value={settings.bilibiliDefaultParseMode}
              options={[
                { label: 'MP4（默认，服务器中转直链）', value: 'mp4' },
                { label: 'DASH（服务器中转，高画质）', value: 'dash' },
              ]}
              onChange={(value) =>
                onSettingsChange((prev) => ({
                  ...prev,
                  bilibiliDefaultParseMode: value as 'mp4' | 'dash',
                }))
              }
            />
            <p className="mt-1.5 text-xs text-[var(--md-sys-color-on-surface-variant)]">
              添加 B站 影片时的默认解析模式，也是未单独配置影片的兜底。
            </p>
          </div>
          <div className="mb-6 max-w-md">
            <Select
              label="番剧/影视（大会员内容）默认模式"
              value={settings.bilibiliPgcDefaultMode}
              options={[
                { label: 'MP4（默认，服务器中转）', value: 'mp4' },
                { label: 'DASH（服务器中转，高画质）', value: 'dash' },
                {
                  label: '仅 CLI 模式（媒体流不经服务器转发）',
                  value: 'cliOnly',
                },
              ]}
              onChange={(value) =>
                onSettingsChange((prev) => ({
                  ...prev,
                  bilibiliPgcDefaultMode: value as 'mp4' | 'dash' | 'cliOnly',
                }))
              }
            />
            <p className="mt-1.5 text-xs text-[var(--md-sys-color-on-surface-variant)]">
              番剧/影视内容添加影片时套用的默认模式。选「仅 CLI 模式」时成员需各自运行 CLI，服务器不转发媒体流。
            </p>
          </div>

          <Title level={5} className="mb-4 mt-6">
            版本更新
          </Title>
          <div className="glass-card mb-6 p-4">
            {desktopManaged ? (
              /* 桌面 GUI 托管：整包版本由 GUI 更新链路维护，网页端更新入口整体禁用 */
              <div className="flex items-center gap-2.5">
                <div
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--md-sys-shape-corner)]"
                  style={{
                    backgroundColor:
                      'color-mix(in srgb, var(--md-sys-color-primary) 12%, transparent)',
                  }}
                >
                  <MonitorCog
                    className="h-4 w-4"
                    style={{ color: 'var(--md-sys-color-primary)' }}
                  />
                </div>
                <div className="min-w-0">
                  <Text className="text-sm font-medium">
                    版本更新由桌面端管理
                  </Text>
                  <Text type="secondary" className="mt-0.5 block text-xs">
                    请在 ZViewer Desktop 中更新。
                  </Text>
                </div>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between pb-3 mb-3 border-b border-[var(--md-sys-color-outline-variant)]">
                  <div className="flex-1 min-w-0 pr-3">
                    <Text className="text-sm font-medium">
                      接收最新构建版本更新
                    </Text>
                    <Text type="secondary" className="block text-xs mt-0.5">
                      开启后包含预发布构建，关闭则只更新正式版
                    </Text>
                  </div>
                  <Switch
                    checked={includePrerelease}
                    onChange={(e) => {
                      setIncludePrerelease(e.target.checked)
                      localStorage.setItem(
                        'update-include-prerelease',
                        String(e.target.checked)
                      )
                    }}
                  />
                </div>
                {/* 更新源：镜像产物仓库 vs GitHub */}
                <div className="pb-3 mb-3 border-b border-[var(--md-sys-color-outline-variant)]">
                  <div className="flex items-center justify-between">
                    <div className="flex-1 min-w-0 pr-3">
                      <Text className="text-sm font-medium">
                        使用镜像更新源
                      </Text>
                      <Text type="secondary" className="block text-xs mt-0.5">
                        从 GitCode 产物仓库（ZviewerRelease）读取清单与安装包，国内可直连；关闭则走 GitHub Release。镜像不可用时直接报错，不自动换源。
                      </Text>
                    </div>
                    <Switch
                      checked={settings.updateUseGitCode !== false}
                      onChange={(e) =>
                        onSettingsChange((prev) => ({
                          ...prev,
                          updateUseGitCode: e.target.checked,
                        }))
                      }
                    />
                  </div>
                </div>
                {/* CDN 加速配置 */}
                <div className="pb-3 mb-3 border-b border-[var(--md-sys-color-outline-variant)]">
                  <div className="flex items-center justify-between pb-3">
                    <div className="flex-1 min-w-0 pr-3">
                      <Text className="text-sm font-medium">更新 CDN 加速</Text>
                      <Text type="secondary" className="block text-xs mt-0.5">
                        {settings.updateUseGitCode !== false
                          ? '镜像源下无需代理'
                          : '开启后检测与下载走 CDN 代理'}
                      </Text>
                    </div>
                    <Switch
                      checked={settings.cdnAccelerate}
                      disabled={settings.updateUseGitCode !== false}
                      onChange={(e) =>
                        onSettingsChange((prev) => ({
                          ...prev,
                          cdnAccelerate: e.target.checked,
                        }))
                      }
                    />
                  </div>
                  {settings.cdnAccelerate &&
                    settings.updateUseGitCode === false && (
                      <div className="space-y-3">
                        <div>
                          <Text className="mb-1.5 block text-[10px] uppercase tracking-wide text-[var(--md-sys-color-on-surface-variant)]">
                            CDN 代理地址
                          </Text>
                          <Input
                            value={settings.cdnProxyUrl}
                            onChange={(e) =>
                              onSettingsChange((prev) => ({
                                ...prev,
                                cdnProxyUrl: e.target.value.trim(),
                              }))
                            }
                            placeholder="https://gh-proxy.com"
                          />
                          <Text
                            type="secondary"
                            className="block text-xs mt-1.5"
                          >
                            默认 https://gh-proxy.com，可换成自建代理。
                          </Text>
                        </div>
                      </div>
                    )}
                </div>
                {/* 更新进度条：下载/上传/解压/启动各阶段实时显示 */}
                {updateProgress && (
                  <div className="mb-3 rounded-[var(--md-sys-radius-small)] bg-[var(--md-sys-color-surface-container-high)] p-3">
                    <div className="flex items-center justify-between gap-2">
                      <Text className="text-xs font-medium text-[var(--md-sys-color-on-surface-variant)]">
                        {updateProgress.stage === 'downloading' &&
                          (updateProgress.message || '正在下载更新包…')}
                        {updateProgress.stage === 'extracting' &&
                          '正在解压更新包…'}
                        {updateProgress.stage === 'starting' &&
                          '正在启动更新脚本…'}
                        {updateProgress.stage === 'done' &&
                          (updateProgress.message || '更新已触发')}
                        {updateProgress.stage === 'error' &&
                          (updateProgress.message || '更新失败')}
                      </Text>
                      {updateProgress.stage === 'downloading' &&
                        updateProgress.total > 0 && (
                          <Text className="shrink-0 text-[10px] font-mono text-[var(--md-sys-color-on-surface-variant)]">
                            {formatBytes(updateProgress.received)} /{' '}
                            {formatBytes(updateProgress.total)}
                          </Text>
                        )}
                    </div>
                    {/* 进度条 */}
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--md-sys-color-surface-container-lowest)]">
                      {updateProgress.stage === 'downloading' ? (
                        updateProgress.total > 0 ? (
                          <div
                            className="h-full rounded-full bg-[var(--md-sys-color-primary)] transition-all duration-150"
                            style={{
                              width: `${Math.min(
                                100,
                                (updateProgress.received /
                                  updateProgress.total) *
                                  100
                              )}%`,
                            }}
                          />
                        ) : (
                          // 总大小未知时显示不确定进度动画
                          <div className="zen-indeterminate-bar h-full w-1/3 rounded-full bg-[var(--md-sys-color-primary)]" />
                        )
                      ) : (
                        <div
                          className={cn(
                            'h-full rounded-full transition-all duration-300',
                            updateProgress.stage === 'done' &&
                              'w-full bg-[var(--md-sys-color-primary)]',
                            updateProgress.stage === 'error' &&
                              'w-full bg-[var(--md-sys-color-error)]',
                            (updateProgress.stage === 'extracting' ||
                              updateProgress.stage === 'starting') &&
                              'w-1/2 bg-[var(--md-sys-color-primary)] zen-indeterminate-bar'
                          )}
                        />
                      )}
                    </div>
                  </div>
                )}
                {updateLoading ? (
                  <div className="py-4">
                    <Spinner tip="检查更新中..." size={24} />
                  </div>
                ) : updateInfo ? (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <Text className="text-sm">
                        当前版本：
                        <span className="font-mono text-[var(--md-sys-color-on-surface-variant)]">
                          {updateInfo.currentVersion}
                        </span>
                      </Text>
                      <Text className="text-sm">
                        远程版本：
                        <span className="font-mono text-[var(--md-sys-color-on-surface-variant)]">
                          {updateInfo.remoteVersion}
                        </span>
                      </Text>
                    </div>
                    {updateInfo.source && (
                      <Text type="secondary" className="text-xs">
                        更新来源：
                        {updateInfo.source === 'gitcode'
                          ? '镜像仓库（GitCode / ZviewerRelease）'
                          : 'GitHub'}
                      </Text>
                    )}
                    {updateInfo.isPrerelease && (
                      <div className="inline-flex rounded-full bg-[var(--md-sys-color-tertiary-container)] px-2 py-0.5">
                        <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--md-sys-color-on-tertiary-container)]">
                          预发布版本
                        </span>
                      </div>
                    )}
                    {updateInfo.publishedAt && (
                      <Text type="secondary" className="text-xs">
                        发布时间：
                        {new Date(updateInfo.publishedAt).toLocaleString(
                          'zh-CN'
                        )}
                      </Text>
                    )}
                    {updateInfo.assetSize > 0 && (
                      <Text type="secondary" className="text-xs">
                        构建产物：{updateInfo.assetName} (
                        {(updateInfo.assetSize / (1024 * 1024)).toFixed(1)}
                        MB)
                      </Text>
                    )}
                    {updateInfo.releaseNotes && (
                      <div className="max-h-32 overflow-y-auto rounded-[var(--md-sys-radius-small)] bg-[var(--md-sys-color-surface-container-high)] p-2">
                        <Text className="whitespace-pre-wrap text-xs leading-relaxed">
                          {updateInfo.releaseNotes
                            .split('\n')
                            .slice(0, 10)
                            .join('\n')}
                        </Text>
                      </div>
                    )}
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      <Button
                        variant="primary"
                        size="sm"
                        icon={<Download className="h-4 w-4" />}
                        onClick={handleApplyUpdate}
                        loading={applyLoading}
                        disabled={applyLoading || !updateInfo.hasUpdate}
                      >
                        {updateInfo.hasUpdate ? '一键更新' : '已是最新'}
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={checkUpdate}
                        disabled={updateLoading}
                      >
                        重新检测
                      </Button>
                      {updateInfo.releaseUrl && (
                        <a
                          href={updateInfo.releaseUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs text-[var(--md-sys-color-primary)] hover:underline"
                        >
                          查看发布
                        </a>
                      )}
                    </div>
                    {/* 分割线 */}
                    <div className="my-2 border-t border-[var(--md-sys-color-outline-variant)]" />
                    {/* 手动导入压缩包 */}
                    <div className="space-y-2">
                      <Text className="text-xs font-medium text-[var(--md-sys-color-on-surface-variant)]">
                        手动导入更新包
                      </Text>
                      <div className="flex items-center gap-2">
                        <input
                          ref={fileInputRef}
                          type="file"
                          accept=".zip,.tar.gz"
                          onChange={handleFileUpload}
                          className="hidden"
                        />
                        <Button
                          variant="secondary"
                          size="sm"
                          icon={<Upload className="h-4 w-4" />}
                          onClick={() => fileInputRef.current?.click()}
                          loading={uploadLoading}
                          disabled={uploadLoading}
                        >
                          选择压缩包
                        </Button>
                        <Text type="secondary" className="text-xs">
                          支持 .zip / .tar.gz 格式
                        </Text>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between py-2">
                      <Text type="secondary" className="text-sm">
                        未获取版本信息
                      </Text>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={checkUpdate}
                        disabled={updateLoading}
                      >
                        检查更新
                      </Button>
                    </div>
                    <div className="my-2 border-t border-[var(--md-sys-color-outline-variant)]" />
                    <div className="space-y-2">
                      <Text className="text-xs font-medium text-[var(--md-sys-color-on-surface-variant)]">
                        手动导入更新包
                      </Text>
                      <div className="flex items-center gap-2">
                        <input
                          ref={fileInputRef}
                          type="file"
                          accept=".zip,.tar.gz"
                          onChange={handleFileUpload}
                          className="hidden"
                        />
                        <Button
                          variant="secondary"
                          size="sm"
                          icon={<Upload className="h-4 w-4" />}
                          onClick={() => fileInputRef.current?.click()}
                          loading={uploadLoading}
                          disabled={uploadLoading}
                        >
                          选择压缩包
                        </Button>
                        <Text type="secondary" className="text-xs">
                          支持 .zip / .tar.gz 格式
                        </Text>
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          <Button
            variant="primary"
            size="sm"
            onClick={onSaveSettings}
            loading={savingSettings}
            disabled={savingSettings || editingMusicVolume}
          >
            保存
          </Button>
        </>
      )}
    </div>
  )
}
