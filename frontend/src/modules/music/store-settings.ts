/**
 * 音乐设置 store（Hydrogen settingsSchema / settingsDefaults 的 Web 适配）。
 *
 * 与 Hydrogen 的差异：
 * - 持久化：Electron 用主进程 settings 文件，这里用 zustand persist 落
 *   localStorage（key `zviewer-music-settings`）
 * - 保存时机：Hydrogen 是「离开页面保存」；Web 环境改为改动即生效即保存
 *   （设置页顶部的保存提示仅保留复刻样式，点击为即时保存的反馈）
 * - 仅保留 Web 环境有意义的「音乐」分组；本地目录 / 快捷键 / 退出行为等
 *   Electron 专属项不迁移
 * - coverBlur 默认 true：ZViewer 播放器覆盖层本就默认渲染毛玻璃封面背景
 *   （Hydrogen 默认 false），保持现有视觉，设置项用于关闭
 */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/** 音质档位（Hydrogen musicLevelOptions 九档，值与网易云 level 参数一致） */
export const MUSIC_LEVEL_OPTIONS = [
  { label: '标准', value: 'standard' },
  { label: '较高', value: 'higher' },
  { label: '极高', value: 'exhigh' },
  { label: '无损', value: 'lossless' },
  { label: 'Hi-Res', value: 'hires' },
  { label: '高清环绕声', value: 'jyeffect' },
  { label: '沉浸环绕声', value: 'sky' },
  { label: '杜比全景声', value: 'dolby' },
  { label: '超清母带', value: 'jymaster' },
] as const

export interface MusicSettings {
  /** 播放音质（网易云 level 参数；后端 stream 按档位降级取流） */
  level: string
  /**
   * 音源直连（直链模式）：开启后 <audio> 直连网易云 CDN 直链，
   * 服务器仅承担解析请求不再转发音频流；直链失效直接报错不回退
   */
  directSource: boolean
  /**
   * 播放器毛玻璃封面背景（歌词页背景封面模糊开关）：关闭后背景显示
   * 不模糊的封面（非纯色底），开启时模糊半径由 coverBlurLevel 决定
   */
  coverBlur: boolean
  /** 封面背景模糊度（px，0-100，默认 50；仅 coverBlur 开启时生效） */
  coverBlurLevel: number
  /** 播放页背景压暗（%，0=不压暗，100=全黑）：黑色遮罩盖在封面/视频背景之上、内容之下 */
  bgDim: number
  /** 歌词模糊（非当前行 blur，当前行保持清晰） */
  lyricBlur: boolean
  /** 歌词模糊浓度（非当前行模糊半径 px，0-10，0.5 步进；开关仍由 lyricBlur 控制） */
  lyricBlurLevel: number
  /** 当前歌词行高亮遮罩透明度（%，0-100，100=不透明黑条） */
  lyricMaskOpacity: number
  /** 当前歌词行高亮遮罩模糊度（px，0 关闭） */
  lyricMaskBlur: number
  /** 显示歌曲翻译（/lyric tlyric） */
  showSongTranslation: boolean
  /** 歌曲无缝衔接（预缓冲下一首音频） */
  gaplessPlayback: boolean
  /** 音频可视化（播放器底部 EQ 频谱动画） */
  audioVisualizer: boolean
  /** 搜索联想下拉条目数量 */
  searchAssistLimit: number
  /** 歌词字体大小（px） */
  lyricSize: number
  /** 歌词翻译字体大小（px） */
  tlyricSize: number
  /** 罗马歌词字体大小（px） */
  rlyricSize: number
  /** 歌词间奏倒计时判定阈值（秒） */
  lyricInterlude: number
  /**
   * 视频背景 CLI 高画质：开启后自定义视频背景走本地 CLI 代理（用户自己的
   * B站 Cookie），可获得大会员高画质 DASH 流；关闭/CLI 未连接时回退
   * 服务器端解析的 720P MP4 直链
   */
  musicVideoCli: boolean
  /**
   * 视频背景 CLI 分辨率（B站 qn，0=自动跟随账号默认；仅 CLI 高画质开启且
   * 本地代理已连接时生效）：120=4K / 116=1080P60 / 112=1080P 高码率 /
   * 80=1080P / 74=720P60 / 64=720P / 32=480P / 16=360P
   */
  musicVideoQn: number
  /** 视频背景画面适配：contain 完整显示（默认，黑边由模糊封面填充）/
   *  cover 裁切铺满（超出部分裁掉）/ fill 拉伸填充（拉伸铺满可能变形） */
  bgVideoFit: 'contain' | 'cover' | 'fill'
  /** 视频背景模糊度（px，0-40，默认 0=关闭）：播放视频背景时的模糊半径，
   *  模糊时视频元素同步放大补偿边缘羽化 */
  videoBlurLevel: number
  /**
   * 歌词页 UI 整体透明度（%，30-100，100=完全不透明）：作用于播放卡 /
   * 歌词面板 / 工具栏 / 提示等前景 UI 整体，背景（封面 / 视频 / 压暗）不受影响
   */
  uiOpacity: number
  /**
   * B站 封面形状（仅哔哩哔哩歌曲的歌词页封面生效）：original 原版
   * （默认 16:9 长方形）/ square 正方形（对封面居中裁剪呈正方形显示）
   */
  biliCoverShape: 'original' | 'square'
  /**
   * B站 视频自动连播（默认开启）：按顺序播放模式下，B站 队列条目播完
   * 到末尾时自动拉相关推荐续播；关闭后播完末尾自然停止
   */
  biliAutoContinue: boolean
  /**
   * B站 红心收藏目标（播放栏 B站 条目的红心一键收藏；收藏夹不存在时
   * 后端按名称自动创建），默认「Music」
   */
  biliLikeFavTitle: string
  /**
   * 顶部导航折叠（默认开启）：网易云四个分区（首页/私人漫游/云盘/
   * 我的音乐）合并为单个「网易云音乐」按钮，点击弹出分区选择面板；
   * 关闭后恢复完整五按钮排版（首页/私人漫游/云盘/我的音乐/哔哩哔哩）
   */
  musicNavCollapsed: boolean
  /**
   * B站 音源弹幕（默认开启）：一起听歌词页播放 B站 条目时按 cid 拉取
   * 官方弹幕并悬浮展示（复用一起看弹幕模块）；样式设置（显示区域/
   * 不透明度/字号/速度等）与一起看共用 danmakuStore 持久化
   */
  biliDanmakuEnabled: boolean
  /**
   * B站 弹幕层级（默认 UI 上方）：true = 弹幕悬浮于播放卡/歌词等前景
   * UI 之上；false = 弹幕仅铺在背景（封面/视频）之上、被前景 UI 遮挡。
   * 纯净模式下前景 UI 隐藏，两种层级均抬升至视频之上
   */
  biliDanmakuAboveUi: boolean
}

export const DEFAULT_MUSIC_SETTINGS: MusicSettings = {
  level: 'lossless',
  directSource: false,
  coverBlur: true,
  coverBlurLevel: 50,
  bgDim: 0,
  lyricBlur: false,
  lyricBlurLevel: 2.5,
  lyricMaskOpacity: 100,
  lyricMaskBlur: 0,
  showSongTranslation: true,
  gaplessPlayback: false,
  audioVisualizer: false,
  searchAssistLimit: 8,
  lyricSize: 20,
  tlyricSize: 14,
  rlyricSize: 12,
  lyricInterlude: 13,
  musicVideoCli: false,
  musicVideoQn: 0,
  bgVideoFit: 'contain',
  videoBlurLevel: 0,
  uiOpacity: 100,
  biliCoverShape: 'original',
  biliAutoContinue: true,
  biliLikeFavTitle: 'Music',
  musicNavCollapsed: true,
  biliDanmakuEnabled: true,
  biliDanmakuAboveUi: true,
}

interface MusicSettingsState extends MusicSettings {
  /** 局部更新（改动即持久化） */
  set: (patch: Partial<MusicSettings>) => void
  /** 恢复全部默认 */
  reset: () => void
}

export const useMusicSettingsStore = create<MusicSettingsState>()(
  persist(
    (set) => ({
      ...DEFAULT_MUSIC_SETTINGS,
      set: (patch) => set(patch),
      reset: () => set({ ...DEFAULT_MUSIC_SETTINGS }),
    }),
    { name: 'zviewer-music-settings', version: 1 }
  )
)

/** 数字设置收敛（≥1 整数，非法回退默认值） */
export function normalizeNumberSetting(
  value: number,
  fallback: number
): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(1, Math.round(value))
}

/** 音质档位合法性（非法值回退默认无损） */
export function normalizeMusicLevel(level: string): string {
  return MUSIC_LEVEL_OPTIONS.some((o) => o.value === level)
    ? level
    : DEFAULT_MUSIC_SETTINGS.level
}

/** 视频背景画面适配合法性（非法值回退完整显示） */
export function normalizeBgVideoFit(fit: string): MusicSettings['bgVideoFit'] {
  return fit === 'cover' || fit === 'fill' ? fit : 'contain'
}

/** B站 封面形状合法性（非法值回退原版） */
export function normalizeBiliCoverShape(
  shape: string
): MusicSettings['biliCoverShape'] {
  return shape === 'square' ? 'square' : 'original'
}

/** B站 红心收藏夹名称合法性（空白回退默认「Music」） */
export function normalizeBiliLikeFavTitle(title: string): string {
  const trimmed = typeof title === 'string' ? title.trim() : ''
  return trimmed || DEFAULT_MUSIC_SETTINGS.biliLikeFavTitle
}
