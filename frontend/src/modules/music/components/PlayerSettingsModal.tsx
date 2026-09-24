import { useEffect, useState } from 'react'
import { ExternalLink, MessagesSquare, MonitorSmartphone } from 'lucide-react'
import { getApiUrl } from '@/lib/api'
import { CLI_DEFAULT_PORT, useCliAgent } from '@/hooks/useCliAgent'
import { useAuthStore } from '@/store/authStore'
import { DEFAULT_DANMAKU_STYLE, useDanmakuStore } from '@/store/danmakuStore'
import {
  DanmakuAdvancedSettings,
  DanmakuStylePanel,
} from '@/modules/room/watch-together/DanmakuStylePanel'
import { FontPickerPanel } from '@/components/ui/FontPicker'
import { getBilibiliUserInfo } from '@/modules/bilibili/bilibiliApi'
import {
  normalizeBgVideoFit,
  normalizeBiliCoverShape,
  normalizeBiliLikeFavTitle,
  useMusicSettingsStore,
} from '../store-settings'
import { cn } from '@/lib/utils'
import { CloudModal } from './CloudModal'
import { TinySlider } from './TinySlider'

/** 黑底弹窗内嵌 MD3 弹幕设置面板的变量作用域覆盖：DanmakuStylePanel /
 *  DanmakuAdvancedSettings / Slider / Switch / FontPickerPanel 均消费
 *  --md-sys-color-* 令牌，弹窗为纯黑底，按弹窗白主题语言（primary=白，
 *  与弹窗 toggle/双按钮一致）覆写暗色值 */
const DANMAKU_PANEL_TOKEN_OVERRIDES = {
  '--md-sys-color-on-surface': '#ececf0',
  '--md-sys-color-on-surface-variant': '#c6c6ce',
  '--md-sys-color-outline': '#8f8f97',
  '--md-sys-color-outline-variant': 'rgba(255, 255, 255, 0.24)',
  '--md-sys-color-primary': '#ffffff',
  '--md-sys-color-on-primary': '#000000',
  '--md-sys-color-primary-container': 'rgba(255, 255, 255, 0.92)',
  '--md-sys-color-on-primary-container': '#0a0a0a',
  '--md-sys-color-secondary-container': 'rgba(255, 255, 255, 0.14)',
  '--md-sys-color-on-secondary-container': '#f2f2f5',
  '--md-sys-color-surface': '#141418',
  '--md-sys-color-surface-container-high': 'rgba(255, 255, 255, 0.08)',
  '--md-sys-color-surface-container-highest': 'rgba(255, 255, 255, 0.12)',
  '--glass-bg': 'rgba(255, 255, 255, 0.08)',
} as React.CSSProperties

/** 歌词页快捷设置弹窗（Hydrogen「添加到我的歌单」弹窗同视觉语言改版）：
 * 黑底 + 高斯模糊 backdrop，顶部「设置」标题后压超大 SETTING 水印字，
 * 四角白色方块点缀；承载「一起听设置」的背景项（封面模糊 / 背景压暗 /
 * 视频背景 CLI 高画质），与设置页同一设置项、改动即时持久化。
 * 点遮罩或 Esc 关闭。 */
export function PlayerSettingsModal({ onDismiss }: { onDismiss: () => void }) {
  const coverBlur = useMusicSettingsStore((s) => s.coverBlur)
  const coverBlurLevel = useMusicSettingsStore((s) => s.coverBlurLevel)
  const videoBlurLevel = useMusicSettingsStore((s) => s.videoBlurLevel)
  const bgDim = useMusicSettingsStore((s) => s.bgDim)
  const uiOpacity = useMusicSettingsStore((s) => s.uiOpacity)
  /** UI 毛玻璃模糊浓度（px，0-40，默认 12） */
  const uiBlurLevel = useMusicSettingsStore((s) => s.uiBlurLevel)
  const musicVideoCli = useMusicSettingsStore((s) => s.musicVideoCli)
  /** CLI 高画质分辨率（B站 qn，0=自动）：仅 CLI 已连接时可选 */
  const musicVideoQn = useMusicSettingsStore((s) => s.musicVideoQn)
  const bgVideoFit = normalizeBgVideoFit(
    useMusicSettingsStore((s) => s.bgVideoFit)
  )
  const biliCoverShape = normalizeBiliCoverShape(
    useMusicSettingsStore((s) => s.biliCoverShape)
  )
  /** B站 红心收藏目标（播放栏 B站 条目红心一键收藏的收藏夹名） */
  const biliLikeFavTitle = normalizeBiliLikeFavTitle(
    useMusicSettingsStore((s) => s.biliLikeFavTitle)
  )
  const lyricBlur = useMusicSettingsStore((s) => s.lyricBlur)
  const lyricBlurLevel = useMusicSettingsStore((s) => s.lyricBlurLevel)
  const setSettings = useMusicSettingsStore((s) => s.set)

  // ===== CLI 高画质代理（BilibiliParseSettings 同构面板）：连接状态检测 +
  //       配置页入口（CLI 开关状态即 musicVideoCli 设置项本身）。
  //       CLI 在服务器全局注册：配置页只需服务器地址（附带当前用户名归属），
  //       房间内开启开关即自动使用，无需按房间连接 =====
  const cliAgent = useCliAgent()
  const cliAvailable = cliAgent.available
  const username = useAuthStore((s) => s.user?.username)
  const openCliSetup = () => {
    const url = new URL(`http://127.0.0.1:${CLI_DEFAULT_PORT}/`)
    url.searchParams.set('server', getApiUrl())
    if (username) url.searchParams.set('user', username)
    window.open(url.toString(), '_blank', 'noopener,noreferrer')
  }

  // ===== B站 大会员状态（CLI 已连接时拉取）：过滤分辨率档位——普通账号
  //       最高 1080P，会员档（4K/1080P60/高码率）仅大会员可见 =====
  const [biliVip, setBiliVip] = useState(false)
  useEffect(() => {
    if (!(musicVideoCli && cliAvailable)) return
    let cancelled = false
    void getBilibiliUserInfo().then((info) => {
      if (cancelled) return
      const vip = info?.vipStatus === 1
      setBiliVip(vip)
      // 已选会员档但账号非大会员：回落自动，避免选择框悬空值
      if (!vip) {
        const s = useMusicSettingsStore.getState()
        if (s.musicVideoQn > 80) s.set({ musicVideoQn: 0 })
      }
    })
    return () => {
      cancelled = true
    }
  }, [musicVideoCli, cliAvailable])

  // ===== B站 弹幕设置（复用一起看弹幕设置组件）：总开关即 biliDanmakuEnabled
  //       设置项；样式面板与一起看共用 danmakuStore（跨页持久化生效） =====
  const biliDanmakuEnabled = useMusicSettingsStore((s) => s.biliDanmakuEnabled)
  const biliDanmakuAboveUi = useMusicSettingsStore((s) => s.biliDanmakuAboveUi)
  const danmakuStyle = useDanmakuStore((s) => s.style)
  const setDanmakuStyle = useDanmakuStore((s) => s.setStyle)
  const setDanmakuFilters = useDanmakuStore((s) => s.setFilters)
  const setDanmakuAdvanced = useDanmakuStore((s) => s.setAdvancedStyle)
  const resetDanmakuStyle = useDanmakuStore((s) => s.resetStyle)
  const [danmakuAdvancedOpen, setDanmakuAdvancedOpen] = useState(false)
  const [danmakuFontOpen, setDanmakuFontOpen] = useState(false)

  // ===== 红心收藏夹行内编辑态（点击名称胶囊 → 输入框，Enter/失焦保存，
  //       Escape 放弃；空白提交由归一化回退默认「Music」） =====
  const [favTitleEditing, setFavTitleEditing] = useState(false)
  const [favTitleDraft, setFavTitleDraft] = useState(biliLikeFavTitle)
  const commitFavTitle = () => {
    setSettings({ biliLikeFavTitle: normalizeBiliLikeFavTitle(favTitleDraft) })
    setFavTitleEditing(false)
  }

  return (
    /* 遮罩 + 面板 + 进出动画（宽→高展开/反向收起、渐进压暗、Esc、
       内容延后挂载闸门 unfoldDone）统一由 CloudModal 承载，此处只写内容 */
    <CloudModal
      width="min(340px, calc(100vw - 32px))"
      height="min(674px, calc(100vh - 120px))"
      onClose={onDismiss}
    >
      {(unfoldDone) => (
        <>
          {/* 标题行：超大 SETTING 水印压在「设置」后面（左对齐、允许溢出裁剪） */}
          <div className="relative border-b border-white/70 px-5 pb-3 pt-4">
            <span
              aria-hidden="true"
              className="pointer-events-none absolute -left-1 top-2 select-none text-[56px] font-black leading-none tracking-tight text-[rgba(255,255,255,0.08)]"
            >
              SETTING
            </span>
            <p className="relative text-center text-[15px] font-bold text-white">
              设置
            </p>
          </div>
          {/* 背景设置项（与「一起听设置」同一 store，即时持久化）；
            展开动画结束后挂载（动画期间零渲染），内容超出面板高度滚动 */}
          {unfoldDone && (
            <div className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain py-1">
              {/* 毛玻璃封面背景（歌词页背景封面模糊开关） */}
              <div className="flex items-center justify-between gap-3 px-5 py-3.5">
                <span className="text-[13px] font-bold text-white">
                  毛玻璃封面背景
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={coverBlur}
                  aria-label="毛玻璃封面背景"
                  onClick={() => setSettings({ coverBlur: !coverBlur })}
                  className="relative h-5 w-9 shrink-0 rounded-full transition-colors"
                  style={{
                    backgroundColor: coverBlur
                      ? '#ffffff'
                      : 'rgba(255, 255, 255, 0.22)',
                  }}
                >
                  <span
                    className="absolute top-0.5 h-4 w-4 rounded-full transition-all duration-200"
                    style={{
                      left: coverBlur ? '18px' : '2px',
                      backgroundColor: coverBlur ? '#000000' : '#ffffff',
                    }}
                  />
                </button>
              </div>
              {/* 封面模糊度（毛玻璃开启时的模糊半径；拖到 0 视为关闭，
              与歌词模糊/模糊浓度的联动语义一致） */}
              <div className="px-5 py-3.5">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-[13px] font-bold text-white">
                    封面模糊度
                  </span>
                  <span className="text-[12px] font-bold tabular-nums text-white/70">
                    {coverBlur ? `${coverBlurLevel}px` : '关闭'}
                  </span>
                </div>
                <TinySlider
                  value={coverBlurLevel}
                  min={0}
                  max={100}
                  step={1}
                  onChange={(v) =>
                    setSettings({ coverBlurLevel: v, coverBlur: v > 0 })
                  }
                />
              </div>
              {/* 视频背景模糊（仅作用于视频背景：模糊半径 px，0=关闭；
                模糊时视频元素放大补偿边缘羽化） */}
              <div className="px-5 py-3.5">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-[13px] font-bold text-white">
                    视频背景模糊
                  </span>
                  <span className="text-[12px] font-bold tabular-nums text-white/70">
                    {videoBlurLevel > 0 ? `${videoBlurLevel}px` : '关闭'}
                  </span>
                </div>
                <TinySlider
                  value={videoBlurLevel}
                  min={0}
                  max={40}
                  step={1}
                  onChange={(v) => setSettings({ videoBlurLevel: v })}
                />
              </div>
              {/* 背景压暗（滑块） */}
              <div className="px-5 py-3.5">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-[13px] font-bold text-white">
                    背景压暗
                  </span>
                  <span className="text-[12px] font-bold tabular-nums text-white/70">
                    {bgDim > 0 ? `${bgDim}%` : '关闭'}
                  </span>
                </div>
                <TinySlider
                  value={bgDim}
                  min={0}
                  max={100}
                  step={1}
                  onChange={(v) => setSettings({ bgDim: v })}
                />
              </div>
              {/* UI 透明度（滑块）：播放卡/歌词面板作为一个整体图层随滑块
              淡出（底色+文字一起），面板背后的冰霜层不参与淡出——毛玻璃
              模糊全程保留（模糊与透明度同时成立的分层方案） */}
              <div className="px-5 py-3.5">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-[13px] font-bold text-white">
                    UI 透明度
                  </span>
                  <span className="text-[12px] font-bold tabular-nums text-white/70">
                    {uiOpacity < 100 ? `${uiOpacity}%` : '默认'}
                  </span>
                </div>
                <TinySlider
                  value={uiOpacity}
                  min={30}
                  max={100}
                  step={5}
                  onChange={(v) => setSettings({ uiOpacity: v })}
                />
              </div>
              {/* UI 模糊浓度（滑块）：播放卡/歌词面板冰霜层的 backdrop 模糊
              半径，0=面板完全透亮（无毛玻璃），默认 12px */}
              <div className="px-5 py-3.5">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-[13px] font-bold text-white">
                    UI 模糊浓度
                  </span>
                  <span className="text-[12px] font-bold tabular-nums text-white/70">
                    {uiBlurLevel > 0 ? `${uiBlurLevel}px` : '关闭'}
                  </span>
                </div>
                <TinySlider
                  value={uiBlurLevel}
                  min={0}
                  max={40}
                  step={1}
                  onChange={(v) => setSettings({ uiBlurLevel: v })}
                />
              </div>
              {/* CLI 高画质代理（BilibiliParseSettings 同构面板，黑底弹窗配色：
              标题行+连接状态点 → 关闭/启用双按钮 → 状态说明 → 配置页入口；
              CLI 开关即 musicVideoCli 设置项，改回开关语义并即时持久化） */}
              <div
                className="mx-5 my-3 rounded-lg p-3"
                style={{
                  backgroundColor: 'rgba(255, 255, 255, 0.06)',
                  border: '0.5px solid rgba(255, 255, 255, 0.12)',
                }}
              >
                <div className="flex items-center gap-1.5">
                  <div
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
                    style={{
                      background:
                        'linear-gradient(135deg, rgba(255,255,255,0.16), rgba(255,255,255,0.05))',
                    }}
                  >
                    <MonitorSmartphone
                      className="h-3 w-3"
                      style={{ color: 'rgba(255, 255, 255, 0.85)' }}
                    />
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="text-[10px] font-bold leading-tight text-white">
                      CLI 高画质代理
                    </span>
                    <span className="text-[8px] font-medium uppercase tracking-wide text-white/40">
                      LOCAL PROXY
                    </span>
                  </div>
                  {/* 连接状态（图示同语义：已连接发光 / 启用未连报错色 / 未启用灰） */}
                  <div className="flex items-center gap-1">
                    <span
                      className="inline-block h-1 w-1 rounded-full"
                      style={{
                        backgroundColor: cliAvailable
                          ? '#ffffff'
                          : musicVideoCli
                            ? '#ff6b6b'
                            : 'rgba(255, 255, 255, 0.3)',
                        boxShadow: cliAvailable
                          ? '0 0 4px rgba(255, 255, 255, 0.9)'
                          : 'none',
                      }}
                    />
                    <span className="text-[9px] font-medium text-white/50">
                      {cliAvailable
                        ? '已连接'
                        : musicVideoCli
                          ? '未连接'
                          : '未启用'}
                    </span>
                  </div>
                </div>
                {/* 关闭 / 启用（选中白底黑字，与弹窗 toggle 语言一致） */}
                <div className="mt-2 grid grid-cols-2 gap-1">
                  <button
                    type="button"
                    onClick={() => setSettings({ musicVideoCli: false })}
                    className={cn(
                      'rounded-md py-1 text-[10px] font-semibold transition-all',
                      !musicVideoCli
                        ? 'bg-white text-black shadow-sm'
                        : 'bg-white/10 text-white/60 hover:bg-white/15'
                    )}
                  >
                    关闭
                  </button>
                  <button
                    type="button"
                    onClick={() => setSettings({ musicVideoCli: true })}
                    className={cn(
                      'rounded-md py-1 text-[10px] font-semibold transition-all',
                      musicVideoCli
                        ? 'bg-white text-black shadow-sm'
                        : 'bg-white/10 text-white/60 hover:bg-white/15'
                    )}
                  >
                    启用
                  </button>
                </div>
                <div className="mt-1 text-[9px] leading-snug text-white/50">
                  {musicVideoCli
                    ? cliAvailable
                      ? `已连接本地代理 ${cliAgent.agentInfo?.version ?? ''}`
                      : '已启用但未检测到本地 CLI，请先启动本地代理以获取高画质视频背景'
                    : '使用本地 zcontrol-cli 获取大会员等高画质视频背景'}
                </div>
                {/* 分辨率选择（仅 CLI 已连接时生效）：变更即重解析视频背景；
                  实际档位受账号大会员权限限制，超出时 B站 自动降档 */}
                {musicVideoCli && cliAvailable && (
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <span className="text-[10px] font-semibold text-white/70">
                      分辨率
                    </span>
                    <select
                      value={musicVideoQn}
                      onChange={(e) =>
                        setSettings({ musicVideoQn: Number(e.target.value) })
                      }
                      className="max-w-[60%] flex-1 rounded-md bg-white/10 px-2 py-1 text-[10px] font-semibold text-white outline-none transition-colors hover:bg-white/15 focus:bg-white/15"
                      style={{
                        border: '0.5px solid rgba(255, 255, 255, 0.2)',
                        colorScheme: 'dark',
                      }}
                      title="视频背景清晰度（实际档位受账号权限限制）"
                    >
                      <option value={0}>自动（跟随账号）</option>
                      {(biliVip
                        ? [
                            [120, '4K 超清'],
                            [116, '1080P 60帧'],
                            [112, '1080P 高码率'],
                          ]
                        : []
                      )
                        .concat([
                          [80, '1080P 高清'],
                          [64, '720P 高清'],
                          [32, '480P 清晰'],
                          [16, '360P 流畅'],
                        ] as Array<[number, string]>)
                        .map(([qn, label]) => (
                          <option key={qn} value={qn}>
                            {label}
                          </option>
                        ))}
                    </select>
                  </div>
                )}
                <button
                  type="button"
                  onClick={openCliSetup}
                  className="mt-2 flex w-full items-center justify-center gap-1 rounded-md bg-white/5 px-2 py-1 text-[10px] font-semibold text-white/60 transition-colors hover:bg-white/10"
                  style={{ border: '0.5px solid rgba(255, 255, 255, 0.2)' }}
                >
                  <ExternalLink className="h-3 w-3" />
                  打开 CLI 配置页
                </button>
              </div>
              {/* 背景显示方式（视频背景的画面适配方式，点击循环切换） */}
              <div className="flex items-center justify-between gap-3 px-5 py-3.5">
                <span className="min-w-0">
                  <span className="block text-[13px] font-bold text-white">
                    背景显示方式
                  </span>
                  <span className="mt-0.5 block text-[11px] font-medium text-white/50">
                    视频背景铺满屏幕的方式
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setSettings({
                      bgVideoFit:
                        bgVideoFit === 'contain'
                          ? 'cover'
                          : bgVideoFit === 'cover'
                            ? 'fill'
                            : 'contain',
                    })
                  }
                  className="w-[76px] shrink-0 rounded-full px-2 py-1.5 text-xs font-bold transition-opacity hover:opacity-70"
                  style={{ backgroundColor: '#ffffff', color: '#000000' }}
                  title="点击切换：完整显示 → 裁切铺满 → 拉伸填充"
                  aria-label="切换背景显示方式"
                >
                  {bgVideoFit === 'contain'
                    ? '完整显示'
                    : bgVideoFit === 'cover'
                      ? '裁切铺满'
                      : '拉伸填充'}
                </button>
              </div>
              {/* B站封面形状（仅哔哩哔哩歌曲的歌词页封面生效，点击循环切换） */}
              <div className="flex items-center justify-between gap-3 px-5 py-3.5">
                <span className="min-w-0">
                  <span className="block text-[13px] font-bold text-white">
                    B站封面形状
                  </span>
                  <span className="mt-0.5 block text-[11px] font-medium text-white/50">
                    哔哩哔哩歌曲封面的显示裁剪方式
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setSettings({
                      biliCoverShape:
                        biliCoverShape === 'original' ? 'square' : 'original',
                    })
                  }
                  className="w-[76px] shrink-0 rounded-full px-2 py-1.5 text-xs font-bold transition-opacity hover:opacity-70"
                  style={{ backgroundColor: '#ffffff', color: '#000000' }}
                  title="点击切换：原版（长方形）↔ 正方形（居中裁剪）"
                  aria-label="切换 B站封面形状"
                >
                  {biliCoverShape === 'original' ? '原版' : '正方形'}
                </button>
              </div>
              {/* 红心收藏夹（播放栏 B站 条目红心一键收藏的目标收藏夹；
              点击名称胶囊进入编辑，不存在时后端自动创建同名收藏夹） */}
              <div className="flex items-center justify-between gap-3 px-5 py-3.5">
                <span className="min-w-0">
                  <span className="block text-[13px] font-bold text-white">
                    红心收藏夹
                  </span>
                  <span className="mt-0.5 block text-[11px] font-medium text-white/50">
                    点击红心收藏 B站 视频的目标收藏夹，不存在时自动创建
                  </span>
                </span>
                {favTitleEditing ? (
                  <input
                    autoFocus
                    value={favTitleDraft}
                    onChange={(e) => setFavTitleDraft(e.target.value)}
                    onBlur={commitFavTitle}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitFavTitle()
                      if (e.key === 'Escape') setFavTitleEditing(false)
                    }}
                    className="h-[30px] w-[130px] shrink-0 rounded-full px-3 text-xs font-bold outline-none"
                    style={{ backgroundColor: '#ffffff', color: '#000000' }}
                    aria-label="红心收藏夹名称"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setFavTitleDraft(biliLikeFavTitle)
                      setFavTitleEditing(true)
                    }}
                    className="min-w-[76px] max-w-[130px] shrink-0 truncate rounded-full px-3 py-1.5 text-xs font-bold transition-opacity hover:opacity-70"
                    style={{ backgroundColor: '#ffffff', color: '#000000' }}
                    title="点击编辑收藏夹名称（留空恢复默认 Music）"
                    aria-label="编辑红心收藏夹名称"
                  >
                    {biliLikeFavTitle}
                  </button>
                )}
              </div>
              {/* 歌词模糊（非当前行 blur，当前行保持清晰） */}
              <div className="flex items-center justify-between gap-3 px-5 py-3.5">
                <span className="text-[13px] font-bold text-white">
                  歌词模糊
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={lyricBlur}
                  aria-label="歌词模糊"
                  onClick={() => setSettings({ lyricBlur: !lyricBlur })}
                  className="relative h-5 w-9 shrink-0 rounded-full transition-colors"
                  style={{
                    backgroundColor: lyricBlur
                      ? '#ffffff'
                      : 'rgba(255, 255, 255, 0.22)',
                  }}
                >
                  <span
                    className="absolute top-0.5 h-4 w-4 rounded-full transition-all duration-200"
                    style={{
                      left: lyricBlur ? '18px' : '2px',
                      backgroundColor: lyricBlur ? '#000000' : '#ffffff',
                    }}
                  />
                </button>
              </div>
              {/* 歌词模糊浓度：拖到 0 视为关闭（联动上方开关与设置页） */}
              <div className="px-5 py-3.5">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-[13px] font-bold text-white">
                    歌词模糊浓度
                  </span>
                  <span className="text-[12px] font-bold tabular-nums text-white/70">
                    {lyricBlurLevel > 0 ? `${lyricBlurLevel}px` : '关闭'}
                  </span>
                </div>
                <TinySlider
                  value={lyricBlurLevel}
                  min={0}
                  max={10}
                  step={0.5}
                  onChange={(v) =>
                    setSettings({ lyricBlurLevel: v, lyricBlur: v > 0 })
                  }
                />
              </div>
              {/* B站弹幕（复用一起看弹幕设置：总开关 + 样式面板 + 高级设置 +
              字体选择；样式与一起看共用 danmakuStore 持久化，跨页生效） */}
              <div
                className="mx-5 my-3 rounded-lg p-3"
                style={{
                  backgroundColor: 'rgba(255, 255, 255, 0.06)',
                  border: '0.5px solid rgba(255, 255, 255, 0.12)',
                }}
              >
                <div className="flex items-center gap-1.5">
                  <div
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
                    style={{
                      background:
                        'linear-gradient(135deg, rgba(255,255,255,0.16), rgba(255,255,255,0.05))',
                    }}
                  >
                    <MessagesSquare
                      className="h-3 w-3"
                      style={{ color: 'rgba(255, 255, 255, 0.85)' }}
                    />
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="text-[10px] font-bold leading-tight text-white">
                      B站弹幕
                    </span>
                    <span className="text-[8px] font-medium uppercase tracking-wide text-white/40">
                      DANMAKU
                    </span>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={biliDanmakuEnabled}
                    aria-label="B站弹幕"
                    onClick={() =>
                      setSettings({ biliDanmakuEnabled: !biliDanmakuEnabled })
                    }
                    className="relative h-5 w-9 shrink-0 rounded-full transition-colors"
                    style={{
                      backgroundColor: biliDanmakuEnabled
                        ? '#ffffff'
                        : 'rgba(255, 255, 255, 0.22)',
                    }}
                  >
                    <span
                      className="absolute top-0.5 h-4 w-4 rounded-full transition-all duration-200"
                      style={{
                        left: biliDanmakuEnabled ? '18px' : '2px',
                        backgroundColor: biliDanmakuEnabled
                          ? '#000000'
                          : '#ffffff',
                      }}
                    />
                  </button>
                </div>
                {/* 弹幕层级（UI 上方 = 悬浮于播放卡/歌词等前景 UI 之上；
                UI 底部 = 仅铺在背景之上、被前景 UI 遮挡；纯净模式下
                前景 UI 隐藏，两种层级均显示在视频之上） */}
                {biliDanmakuEnabled && (
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <span className="text-[10px] font-bold text-white">
                      弹幕层级
                    </span>
                    <div className="grid shrink-0 grid-cols-2 gap-1">
                      <button
                        type="button"
                        onClick={() =>
                          setSettings({ biliDanmakuAboveUi: true })
                        }
                        className={cn(
                          'rounded-md px-2.5 py-1 text-[10px] font-semibold transition-all',
                          biliDanmakuAboveUi
                            ? 'bg-white text-black shadow-sm'
                            : 'bg-white/10 text-white/60 hover:bg-white/15'
                        )}
                      >
                        UI 上方
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setSettings({ biliDanmakuAboveUi: false })
                        }
                        className={cn(
                          'rounded-md px-2.5 py-1 text-[10px] font-semibold transition-all',
                          !biliDanmakuAboveUi
                            ? 'bg-white text-black shadow-sm'
                            : 'bg-white/10 text-white/60 hover:bg-white/15'
                        )}
                      >
                        UI 底部
                      </button>
                    </div>
                  </div>
                )}
                {/* 弹幕样式设置（仅启用时展开；MD3 令牌暗色覆盖使白主题组件
                融入黑底弹窗，primary=白与弹窗按钮语言一致） */}
                {biliDanmakuEnabled && (
                  <div className="mt-2" style={DANMAKU_PANEL_TOKEN_OVERRIDES}>
                    <DanmakuStylePanel
                      style={danmakuStyle}
                      setStyle={setDanmakuStyle}
                      resetStyle={resetDanmakuStyle}
                      advancedOpen={danmakuAdvancedOpen}
                      onAdvancedToggle={() => {
                        setDanmakuAdvancedOpen((v) => !v)
                        setDanmakuFontOpen(false)
                      }}
                    />
                    {danmakuAdvancedOpen && (
                      <div className="mt-2 border-t border-white/10 pt-2">
                        <DanmakuAdvancedSettings
                          style={danmakuStyle}
                          setStyle={setDanmakuStyle}
                          setFilters={setDanmakuFilters}
                          setAdvancedStyle={setDanmakuAdvanced}
                          onFontPanelToggle={() =>
                            setDanmakuFontOpen((v) => !v)
                          }
                        />
                        {danmakuFontOpen && (
                          <div className="mt-2 max-h-44 overflow-y-auto rounded-md border border-white/10 bg-black/30 p-1">
                            <FontPickerPanel
                              value={
                                danmakuStyle.advanced.fontFamily ===
                                DEFAULT_DANMAKU_STYLE.advanced.fontFamily
                                  ? ''
                                  : danmakuStyle.advanced.fontFamily
                              }
                              onChange={(v) =>
                                setDanmakuAdvanced({
                                  fontFamily:
                                    v ||
                                    DEFAULT_DANMAKU_STYLE.advanced.fontFamily,
                                })
                              }
                            />
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </CloudModal>
  )
}
