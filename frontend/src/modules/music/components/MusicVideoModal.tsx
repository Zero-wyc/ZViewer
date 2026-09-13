/**
 * 添加视频弹窗（Hydrogen components/MusicVideo.vue 截图可见部分 1:1 复刻）。
 *
 * 黑色弹窗结构：标题（添加视频 / ADD VIDEO FOR {songName}）+ B站账号区
 * （未登录 NONE / 已登录头像+昵称+大会员水印 + 登录/退出按钮）+ BV号输入框
 * + 视频信息区（NONE / 封面+标题+UP主+分P chips）+ 右侧 搜索/删除 按钮列。
 *
 * 与 Hydrogen 的差异（Web 架构约束）：
 * - 登录复用 ZViewer 的 B站扫码链路（/api/stream/bilibili/*），二维码内嵌
 *   在账号区轮询（Hydrogen 为 Electron 窗口 API + session cookie）
 * - 无本地视频下载缓存与「视频插入点」时间段概念，删除按钮语义为
 *   确认清空当前搜索结果（Hydrogen 为删除本地缓存的音乐视频记录）
 */
import { useCallback, useEffect, useState } from 'react'
import {
  getBilibiliLoginStatus,
  getBilibiliUserInfo,
  getBilibiliQrCode,
  pollBilibiliQrCode,
  logoutBilibili,
  getBilibiliVideoView,
  type BilibiliVideoViewInfo,
} from '@/modules/bilibili/bilibiliApi'
import type { BilibiliUserInfo, BilibiliQrData } from '@/modules/bilibili/types'
import { message } from '@/components/ui/message'

/** 二维码轮询间隔（ms，Hydrogen 3s，ZViewer MoviePushPanel 为 2s） */
const QR_POLL_INTERVAL_MS = 2000

interface MusicVideoModalProps {
  /** 当前歌曲名（标题 ADD VIDEO FOR 后的粉色文字） */
  songName: string
  onClose: () => void
}

/** 从输入提取 BV 号：支持完整链接（含 /video/BVxxx）或裸 BV 号 */
function extractBvid(input: string): string | null {
  const text = input.trim()
  if (!text) return null
  const urlMatch = text.match(/video\/(BV[0-9A-Za-z]{10})/)
  if (urlMatch) return urlMatch[1]
  const bare = text.match(/^BV[0-9A-Za-z]{10}$/)
  if (bare) return bare[0]
  const embedded = text.match(/(BV[0-9A-Za-z]{10})/)
  return embedded ? embedded[1] : null
}

export function MusicVideoModal({ songName, onClose }: MusicVideoModalProps) {
  const [biliUser, setBiliUser] = useState<BilibiliUserInfo | null>(null)
  const [loginStatusLoaded, setLoginStatusLoaded] = useState(false)
  // 扫码登录态：null=非登录流程；显示二维码 + 轮询状态文字
  const [qrLogin, setQrLogin] = useState<BilibiliQrData | null>(null)
  const [qrStatusText, setQrStatusText] = useState('')
  const [videoUrl, setVideoUrl] = useState('')
  const [videoInfo, setVideoInfo] = useState<BilibiliVideoViewInfo | null>(null)
  const [selectedCid, setSelectedCid] = useState<number | null>(null)
  const [searching, setSearching] = useState(false)

  // 打开时加载账号状态（Hydrogen 打开弹窗时校验已存 cookie 同语义）
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const loggedIn = await getBilibiliLoginStatus()
      if (cancelled) return
      if (loggedIn) {
        const info = await getBilibiliUserInfo()
        if (!cancelled) setBiliUser(info)
      }
      if (!cancelled) setLoginStatusLoaded(true)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // 二维码轮询：2s 一次；status 2=登录成功（后端已存 cookie）、3=过期重新生成
  useEffect(() => {
    if (!qrLogin) return
    let cancelled = false
    const poll = async () => {
      try {
        const result = await pollBilibiliQrCode(qrLogin.qrcodeKey)
        if (cancelled) return
        if (result.status === 2) {
          setQrLogin(null)
          setQrStatusText('')
          message.success('B站 登录成功')
          const info = await getBilibiliUserInfo()
          if (!cancelled) setBiliUser(info)
          return
        }
        if (result.status === 3) {
          setQrStatusText('二维码已过期，正在重新生成...')
          const fresh = await getBilibiliQrCode()
          if (!cancelled) setQrLogin(fresh)
          return
        }
        setQrStatusText(
          result.status === 1 ? '已扫码，请在手机上确认' : '请使用 B站 App 扫码'
        )
      } catch (err) {
        if (!cancelled)
          setQrStatusText(
            err instanceof Error ? err.message : '二维码状态获取失败'
          )
      }
    }
    void poll()
    const timer = setInterval(poll, QR_POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [qrLogin])

  /** 登录 / 退出（Hydrogen loginOrLogout 同语义） */
  const handleLoginOrLogout = useCallback(async () => {
    if (biliUser) {
      try {
        await logoutBilibili()
        setBiliUser(null)
        message.success('已退出登录')
      } catch (err) {
        message.error(err instanceof Error ? err.message : '退出失败')
      }
      return
    }
    if (qrLogin) return
    try {
      const qr = await getBilibiliQrCode()
      setQrLogin(qr)
      setQrStatusText('请使用 B站 App 扫码')
    } catch (err) {
      message.error(err instanceof Error ? err.message : '获取二维码失败')
    }
  }, [biliUser, qrLogin])

  /** 搜索（Hydrogen search/checkUrl 同语义：取 BV → x/web-interface/view） */
  const handleSearch = useCallback(async () => {
    const bvid = extractBvid(videoUrl)
    if (!bvid) {
      message.info('请输入视频链接或BV号')
      return
    }
    setSearching(true)
    try {
      const info = await getBilibiliVideoView(bvid)
      setVideoInfo(info)
      setSelectedCid(info.pages.length > 0 ? info.pages[0].cid : info.cid)
    } catch (err) {
      message.error(err instanceof Error ? err.message : '获取视频信息失败')
    } finally {
      setSearching(false)
    }
  }, [videoUrl])

  /** 删除（Hydrogen deleteConfirm 简化：确认后清空表单） */
  const handleDelete = useCallback(() => {
    if (!videoInfo) return
    setVideoInfo(null)
    setSelectedCid(null)
    setVideoUrl('')
    message.info('已清空当前视频')
  }, [videoInfo])

  return (
    <div
      className="absolute left-1/2 top-1/2 z-[999] h-[600px] w-[450px] -translate-x-1/2 -translate-y-1/2"
      style={{ backgroundColor: 'rgba(44, 50, 51, 1)' }}
    >
      {/* 关闭 X（Hydrogen .close 内联 SVG） */}
      <button
        type="button"
        aria-label="关闭"
        className="absolute right-[15px] top-[16px] h-[25px] w-[25px] transition-opacity hover:opacity-80 active:opacity-60"
        onClick={onClose}
      >
        <svg viewBox="0 0 24 24" className="h-full w-full" aria-hidden="true">
          <line
            x1="5"
            y1="5"
            x2="19"
            y2="19"
            stroke="white"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <line
            x1="19"
            y1="5"
            x2="5"
            y2="19"
            stroke="white"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      </button>

      {/* 标题区（.set-video-title） */}
      <div
        className="flex flex-col text-left text-white"
        style={{ backgroundColor: 'rgba(0, 0, 0, 0.75)', padding: '10px 15px' }}
      >
        <span
          style={{
            fontFamily: "'SourceHanSansCN-Bold', sans-serif",
            fontSize: 18,
            lineHeight: '18px',
          }}
        >
          添加视频
        </span>
        <span
          className="overflow-hidden text-ellipsis whitespace-nowrap"
          style={{
            fontFamily: "'Bender-Bold', 'SourceHanSansCN-Bold', sans-serif",
            fontSize: 16,
            width: '90%',
          }}
        >
          ADD VIDEO FOR{' '}
          <span style={{ color: 'pink' }}>{songName || 'Music'}</span>
        </span>
      </div>

      {/* 内容区（.set-video-info） */}
      <div style={{ padding: '10px 15px' }}>
        <div className="flex flex-row justify-between">
          {/* B站账号区（.bili-account .account-info） */}
          <div
            className="relative select-none overflow-hidden"
            style={{
              width: '80%',
              height: 80,
              backgroundColor: 'rgba(0, 0, 0, 0.55)',
            }}
          >
            <span
              className="absolute left-0 top-0 w-full"
              style={{
                height: 12,
                lineHeight: '12px',
                paddingLeft: 4,
                backgroundColor: 'rgba(0, 0, 0, 0.75)',
                color: 'rgba(255, 255, 255, 0.8)',
                fontFamily: "'Bender-Bold', sans-serif",
                fontSize: 8,
                textAlign: 'left',
              }}
            >
              BILIBILI ACCOUNT
            </span>
            {qrLogin ? (
              // 扫码登录：二维码 + 状态文字内嵌在账号区
              <div className="flex h-full w-full items-center gap-3 px-3 pt-2">
                <img
                  src={qrLogin.qrDataUrl}
                  alt="登录二维码"
                  className="h-[64px] w-[64px]"
                />
                <span
                  className="flex-1"
                  style={{
                    color: 'rgba(255, 255, 255, 0.8)',
                    fontFamily: "'SourceHanSansCN-Bold', sans-serif",
                    fontSize: 11,
                  }}
                >
                  {qrStatusText}
                </span>
              </div>
            ) : loginStatusLoaded && biliUser ? (
              <div className="flex h-full w-full flex-row items-center">
                <img
                  src={biliUser.avatar}
                  alt=""
                  className="ml-[14px] mt-[9px] h-[45px] w-[45px]"
                  style={{ border: '1px solid rgba(255, 255, 255, 0.1)' }}
                />
                <div
                  className="ml-[12px] mt-[9px] flex flex-col text-left"
                  style={{
                    color: 'rgba(255, 255, 255, 0.9)',
                    fontFamily: "'SourceHanSansCN-Bold', sans-serif",
                    fontSize: 11,
                  }}
                >
                  <span className="truncate">{biliUser.name}</span>
                  <span>
                    大会员：{biliUser.vipStatus ? '已激活' : '未激活'}
                  </span>
                </div>
                <div
                  className="absolute bottom-[8px] right-[30px]"
                  style={{
                    color: 'rgba(255, 255, 255, 0.8)',
                    fontFamily: "'Bender-Bold', sans-serif",
                    fontSize: 8,
                  }}
                >
                  BILIBILI VIP
                  <span
                    className="absolute -right-[20px] bottom-[3px] block h-[3px] w-[14px]"
                    style={{
                      backgroundColor: biliUser.vipStatus
                        ? 'rgba(255, 192, 203, 0.9)'
                        : 'rgba(255, 255, 255, 0.6)',
                    }}
                  />
                </div>
              </div>
            ) : (
              <span
                className="block w-full"
                style={{
                  color: 'rgba(255, 255, 255, 0.8)',
                  fontFamily: "'Bender-Bold', sans-serif",
                  fontSize: 14,
                  lineHeight: '80px',
                  textAlign: 'center',
                }}
              >
                NONE
              </span>
            )}
          </div>
          {/* 登录/退出按钮（.account-button） */}
          <button
            type="button"
            className="hover:bg-black/35 active:bg-black/65"
            style={{
              width: '18%',
              height: 80,
              backgroundColor: 'rgba(0, 0, 0, 0.55)',
              color: 'rgba(255, 255, 255, 0.9)',
              fontFamily: "'SourceHanSansCN-Bold', sans-serif",
              fontSize: 14,
              transition: '0.2s',
            }}
            onClick={() => void handleLoginOrLogout()}
          >
            {biliUser ? '退出' : '登录'}
          </button>
        </div>

        {/* 链接输入框（.video-url） */}
        <div className="mt-[10px]">
          <input
            type="text"
            spellCheck={false}
            value={videoUrl}
            placeholder="请输入视频链接或BV号"
            onChange={(e) => setVideoUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleSearch()
            }}
            className="w-full outline-none"
            style={{
              padding: '0 12px',
              height: 30,
              backgroundColor: 'rgba(0, 0, 0, 0.55)',
              color: 'rgba(255, 255, 255, 0.8)',
              fontFamily: "'Bender-Bold', 'SourceHanSansCN-Bold', sans-serif",
              fontSize: 12,
              border: 'none',
            }}
          />
        </div>

        {/* 视频信息 + 搜索/删除（.video-add） */}
        <div className="flex flex-row justify-between">
          {/* 视频信息区（.video-info） */}
          <div
            className="relative"
            style={{
              marginTop: 10,
              padding: '10px 15px',
              width: '80%',
              height: 220,
              backgroundColor: 'rgba(0, 0, 0, 0.55)',
            }}
          >
            <div
              style={{
                color: 'rgba(255, 255, 255, 0.9)',
                fontFamily: "'SourceHanSansCN-Bold', sans-serif",
                fontSize: 20,
                lineHeight: '22px',
                textAlign: 'left',
              }}
            >
              视频信息
            </div>
            <div
              style={{
                color: 'rgba(255, 255, 255, 0.6)',
                fontFamily: "'Bender-Bold', sans-serif",
                fontSize: 10,
                textAlign: 'left',
              }}
            >
              VIDEO INFO
            </div>
            {videoInfo ? (
              <div className="mt-[6px] flex w-full flex-col">
                <div className="flex flex-row items-center">
                  <img
                    src={videoInfo.pic}
                    alt=""
                    className="mr-[10px] self-start"
                    style={{
                      height: 60,
                      border: '1px solid rgba(255, 255, 255, 0.1)',
                    }}
                    onError={(e) => {
                      e.currentTarget.style.visibility = 'hidden'
                    }}
                  />
                  <div className="flex min-w-0 flex-col text-left">
                    <span
                      className="line-clamp-2"
                      style={{
                        marginBottom: 4,
                        color: 'rgba(255, 255, 255, 0.9)',
                        fontFamily: "'SourceHanSansCN-Bold', sans-serif",
                        fontSize: 12,
                        wordBreak: 'break-all',
                      }}
                    >
                      {videoInfo.title}
                    </span>
                    <span
                      className="truncate"
                      style={{
                        color: 'rgba(255, 255, 255, 0.6)',
                        fontFamily: "'SourceHanSansCN-Bold', sans-serif",
                        fontSize: 10,
                        wordBreak: 'break-all',
                      }}
                    >
                      UP：{videoInfo.upName}
                    </span>
                  </div>
                </div>
                {/* 分 P 列表（多 P 时横滚 chips） */}
                {videoInfo.pages.length > 1 && (
                  <div className="mt-[10px] flex flex-row overflow-x-auto overflow-y-hidden pb-[6px]">
                    {videoInfo.pages.map((p) => (
                      <div
                        key={p.cid}
                        className="mr-[10px] shrink-0 hover:bg-white/5"
                        style={{
                          width: 70,
                          border: '1px solid rgba(255, 255, 255, 0.1)',
                          backgroundColor:
                            selectedCid === p.cid
                              ? 'rgba(255, 255, 255, 0.1)'
                              : undefined,
                          cursor: 'pointer',
                        }}
                        onClick={() => setSelectedCid(p.cid)}
                        title={p.part}
                      >
                        <span
                          className="block truncate"
                          style={{
                            color: 'rgba(255, 255, 255, 0.6)',
                            fontFamily: "'SourceHanSansCN-Bold', sans-serif",
                            fontSize: 10,
                            lineHeight: '30px',
                            textAlign: 'center',
                          }}
                        >
                          {p.part || `P${p.page}`}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <span
                className="absolute left-0 top-0 h-full w-full text-center"
                style={{
                  color: 'rgba(255, 255, 255, 0.8)',
                  fontFamily:
                    "'Bender-Bold', 'SourceHanSansCN-Bold', sans-serif",
                  fontSize: 14,
                  lineHeight: '200px',
                }}
              >
                {searching ? '搜索中...' : 'NONE'}
              </span>
            )}
          </div>
          {/* 搜索/删除按钮列（.video-other） */}
          <div
            className="flex w-[18%] flex-col justify-between"
            style={{ marginTop: 10 }}
          >
            <button
              type="button"
              className="hover:bg-black/35 active:bg-black/65"
              style={{
                width: '100%',
                height: '48%',
                backgroundColor: 'rgba(0, 0, 0, 0.55)',
                color: 'rgba(255, 255, 255, 0.9)',
                fontFamily: "'SourceHanSansCN-Bold', sans-serif",
                fontSize: 14,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transition: '0.2s',
              }}
              onClick={() => void handleSearch()}
            >
              搜索
            </button>
            <button
              type="button"
              className="hover:bg-black/35 active:bg-black/65"
              style={{
                width: '100%',
                height: '48%',
                backgroundColor: 'rgba(0, 0, 0, 0.55)',
                color: 'rgba(255, 255, 255, 0.9)',
                fontFamily: "'SourceHanSansCN-Bold', sans-serif",
                fontSize: 14,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transition: '0.2s',
              }}
              onClick={handleDelete}
            >
              删除
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
