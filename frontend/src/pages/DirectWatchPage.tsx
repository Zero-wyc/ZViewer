import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowLeft,
  Copy,
  Eye,
  Link2,
  CheckCircle2,
  Maximize,
  PictureInPicture,
  PictureInPicture2,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Space } from '@/components/ui/Space'
import { Title, Paragraph } from '@/components/ui/Typography'
import { Tag } from '@/components/ui/Tag'
import { Spinner } from '@/components/ui/Spinner'
import { message } from '@/components/ui/message'
import { ConnectionStatsPanel } from '@/components/ConnectionStatsPanel'

const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]

interface DirectSignalData {
  sdp: RTCSessionDescriptionInit
  candidates: RTCIceCandidateInit[]
}

type WatchStep = 'idle' | 'parsing' | 'gathering' | 'answer-ready' | 'connected'

declare global {
  interface HTMLVideoElement {
    requestPictureInPicture(): Promise<unknown>
  }
  interface Document {
    readonly pictureInPictureElement: HTMLVideoElement | null
    readonly pictureInPictureEnabled: boolean
    exitPictureInPicture(): Promise<void>
  }
}

function waitForIceGatheringComplete(
  pc: RTCPeerConnection,
  timeoutMs = 10000
): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') {
      resolve()
      return
    }

    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, timeoutMs)

    const onStateChange = () => {
      if (pc.iceGatheringState === 'complete') {
        cleanup()
        resolve()
      }
    }

    const cleanup = () => {
      clearTimeout(timer)
      pc.removeEventListener('icegatheringstatechange', onStateChange)
    }

    pc.addEventListener('icegatheringstatechange', onStateChange)
  })
}

function serializeSignal(data: DirectSignalData): string {
  return JSON.stringify(data, null, 2)
}

function parseSignal(text: string): DirectSignalData | null {
  try {
    const parsed = JSON.parse(text) as unknown
    if (
      parsed &&
      typeof parsed === 'object' &&
      'sdp' in parsed &&
      'candidates' in parsed &&
      Array.isArray((parsed as DirectSignalData).candidates)
    ) {
      return parsed as DirectSignalData
    }
  } catch {
    // ignore parse error
  }
  return null
}

function DirectWatchPage() {
  const navigate = useNavigate()
  const [step, setStep] = useState<WatchStep>('idle')
  const [offerCode, setOfferCode] = useState('')
  const [answerCode, setAnswerCode] = useState('')
  const [hasRemoteStream, setHasRemoteStream] = useState(false)
  const [peerConnection, setPeerConnection] =
    useState<RTCPeerConnection | null>(null)
  const [isPictureInPicture, setIsPictureInPicture] = useState(false)
  const [isPiPSupported] = useState(
    () => typeof document !== 'undefined' && document.pictureInPictureEnabled
  )
  const pcRef = useRef<RTCPeerConnection | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const candidateQueueRef = useRef<RTCIceCandidateInit[]>([])

  const cleanup = useCallback(() => {
    const pc = pcRef.current
    if (pc) {
      pc.onicecandidate = null
      pc.ontrack = null
      pc.onconnectionstatechange = null
      pc.close()
      pcRef.current = null
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null
    }
    candidateQueueRef.current = []
    setHasRemoteStream(false)
    setPeerConnection(null)
  }, [])

  useEffect(() => {
    return () => {
      cleanup()
    }
  }, [cleanup])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    const handleEnterPiP = () => setIsPictureInPicture(true)
    const handleLeavePiP = () => setIsPictureInPicture(false)

    video.addEventListener(
      'enterpictureinpicture' as keyof HTMLVideoElementEventMap,
      handleEnterPiP
    )
    video.addEventListener(
      'leavepictureinpicture' as keyof HTMLVideoElementEventMap,
      handleLeavePiP
    )

    return () => {
      video.removeEventListener(
        'enterpictureinpicture' as keyof HTMLVideoElementEventMap,
        handleEnterPiP
      )
      video.removeEventListener(
        'leavepictureinpicture' as keyof HTMLVideoElementEventMap,
        handleLeavePiP
      )
    }
  }, [])

  const handleCreateAnswer = async () => {
    const signal = parseSignal(offerCode.trim())
    if (!signal) {
      message.error('无效的直连码')
      return
    }

    cleanup()
    setStep('parsing')

    try {
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
      pcRef.current = pc
      setPeerConnection(pc)
      candidateQueueRef.current = []

      pc.ontrack = (event) => {
        const remoteStream = event.streams[0]
        if (remoteStream && videoRef.current) {
          videoRef.current.srcObject = remoteStream
          setHasRemoteStream(true)
        }
      }

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          candidateQueueRef.current.push(event.candidate.toJSON())
        }
      }

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') {
          setStep('connected')
          message.success('直连已建立')
        } else if (
          pc.connectionState === 'failed' ||
          pc.connectionState === 'closed' ||
          pc.connectionState === 'disconnected'
        ) {
          console.log('[DirectWatchPage] connection state:', pc.connectionState)
        }
      }

      await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp))

      for (const candidate of signal.candidates) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate))
        } catch (err) {
          console.warn('[DirectWatchPage] add candidate warning:', err)
        }
      }

      setStep('gathering')
      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)
      await waitForIceGatheringComplete(pc)

      const answerSignal: DirectSignalData = {
        sdp: pc.localDescription?.toJSON() ?? answer,
        candidates: candidateQueueRef.current,
      }

      setAnswerCode(serializeSignal(answerSignal))
      setStep('answer-ready')
    } catch (err) {
      console.error('[DirectWatchPage] create answer error:', err)
      message.error('处理直连码失败')
      cleanup()
      setStep('idle')
    }
  }

  const handleCopyAnswer = () => {
    navigator.clipboard.writeText(answerCode).then(() => {
      message.success('应答码已复制')
    })
  }

  const handleFullscreen = () => {
    const video = videoRef.current
    if (!video) return
    video
      .requestFullscreen()
      .then(() => {
        // 全屏由浏览器原生控制
      })
      .catch((err) => {
        console.error('[DirectWatchPage] fullscreen error:', err)
        message.error('无法进入全屏模式')
      })
  }

  const handleTogglePictureInPicture = async () => {
    const video = videoRef.current
    if (!video) return

    try {
      if (document.pictureInPictureElement === video) {
        await document.exitPictureInPicture()
      } else {
        await video.requestPictureInPicture()
      }
    } catch (err) {
      console.error('[DirectWatchPage] picture-in-picture error:', err)
      message.error('画中画模式不可用')
    }
  }

  const handleReset = () => {
    cleanup()
    setStep('idle')
    setOfferCode('')
    setAnswerCode('')
  }

  const showVideo = step === 'answer-ready' || step === 'connected'

  return (
    <div className="flex-1 flex items-center justify-center p-6">
      <Card className="relative w-full max-w-2xl text-center">
        <Button
          variant="ghost"
          size="sm"
          icon={<ArrowLeft className="h-4 w-4" />}
          onClick={() => navigate('/')}
          className="absolute left-4 top-4"
        >
          返回
        </Button>
        <Title level={3}>直连观看</Title>
        <Paragraph type="secondary">
          粘贴分享端提供的直连码，生成应答码并回传即可建立 P2P 连接。
        </Paragraph>

        <Space direction="vertical" className="mt-4 w-full">
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Tag color="success">直连模式</Tag>
            {step === 'connected' && (
              <Tag color="success">
                <CheckCircle2 className="h-3 w-3 inline mr-1" />
                已连接
              </Tag>
            )}
            {showVideo && !hasRemoteStream && (
              <Tag color="primary">等待画面</Tag>
            )}
          </div>

          {!showVideo ? (
            <div className="text-left">
              <Paragraph className="m-0 mb-1 text-sm font-medium">
                <Link2 className="h-4 w-4 inline mr-1" />
                分享端直连码
              </Paragraph>
              <textarea
                value={offerCode}
                onChange={(e) => setOfferCode(e.target.value)}
                rows={8}
                placeholder="请将分享端提供的直连码粘贴到此处"
                className="w-full rounded-lg border border-slate-300 bg-white p-3 font-mono text-xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              <Button
                variant="primary"
                icon={<Eye className="h-5 w-5" />}
                block
                className="mt-2"
                loading={step === 'parsing' || step === 'gathering'}
                disabled={
                  !offerCode.trim() ||
                  step === 'parsing' ||
                  step === 'gathering'
                }
                onClick={handleCreateAnswer}
              >
                解析并生成应答码
              </Button>
              {(step === 'parsing' || step === 'gathering') && (
                <Paragraph type="secondary" className="mt-2">
                  {step === 'parsing'
                    ? '正在解析直连码…'
                    : '正在收集网络候选地址…'}
                </Paragraph>
              )}
            </div>
          ) : (
            <>
              <video
                ref={videoRef}
                autoPlay
                playsInline
                className="w-full rounded-lg bg-black"
                style={{
                  maxHeight: 320,
                  display: hasRemoteStream ? 'block' : 'none',
                }}
              />
              {!hasRemoteStream && <Spinner tip="正在接收画面…" size={32} />}
              {hasRemoteStream && (
                <Space wrap className="justify-center">
                  <Button
                    icon={<Maximize className="h-4 w-4" />}
                    onClick={handleFullscreen}
                  >
                    全屏
                  </Button>
                  {isPiPSupported && (
                    <Button
                      icon={
                        isPictureInPicture ? (
                          <PictureInPicture2 className="h-4 w-4" />
                        ) : (
                          <PictureInPicture className="h-4 w-4" />
                        )
                      }
                      onClick={handleTogglePictureInPicture}
                    >
                      {isPictureInPicture ? '退出画中画' : '画中画'}
                    </Button>
                  )}
                </Space>
              )}
            </>
          )}

          {answerCode && (
            <div className="text-left">
              <Paragraph className="m-0 mb-1 text-sm font-medium">
                应答码（回传给分享端）
              </Paragraph>
              <textarea
                readOnly
                value={answerCode}
                rows={6}
                className="w-full rounded-lg border border-slate-300 bg-slate-50 p-3 font-mono text-xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              <Button
                variant="primary"
                icon={<Copy className="h-4 w-4" />}
                block
                className="mt-2"
                onClick={handleCopyAnswer}
              >
                复制应答码
              </Button>
            </div>
          )}

          {showVideo && (
            <Button
              icon={<Link2 className="h-4 w-4" />}
              block
              onClick={handleReset}
            >
              重新连接
            </Button>
          )}

          <Paragraph type="secondary" className="text-xs">
            提示：将应答码复制后发送给分享端，分享端粘贴完成连接。
          </Paragraph>
        </Space>

        {showVideo && (
          <ConnectionStatsPanel pc={peerConnection} mode="direct" />
        )}
      </Card>
    </div>
  )
}

export default DirectWatchPage
