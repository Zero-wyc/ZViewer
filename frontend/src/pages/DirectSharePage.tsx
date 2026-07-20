import { useCallback, useEffect, useRef, useState } from 'react'
import { Copy, Monitor, Power, Link2, CheckCircle2 } from 'lucide-react'
import { PageBackButton } from '@/components/PageBackButton'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Space } from '@/components/ui/Space'
import { Title, Paragraph } from '@/components/ui/Typography'
import { Tag } from '@/components/ui/Tag'
import { message } from '@/components/ui/message'
import { ConnectionStatsPanel } from '@/modules/screen-sharing/components/ConnectionStatsPanel'

const ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }]

interface DirectSignalData {
  sdp: RTCSessionDescriptionInit
  candidates: RTCIceCandidateInit[]
}

type ShareStep =
  'idle' | 'gathering' | 'offer-ready' | 'connecting' | 'connected'

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

function DirectSharePage() {
  const [step, setStep] = useState<ShareStep>('idle')
  const [offerCode, setOfferCode] = useState('')
  const [answerCode, setAnswerCode] = useState('')
  const [isSharing, setIsSharing] = useState(false)
  const [peerConnection, setPeerConnection] =
    useState<RTCPeerConnection | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)
  const localVideoRef = useRef<HTMLVideoElement | null>(null)
  const pcRef = useRef<RTCPeerConnection | null>(null)
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
    localStreamRef.current?.getTracks().forEach((track) => track.stop())
    localStreamRef.current = null
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null
    }
    candidateQueueRef.current = []
    setIsSharing(false)
    setPeerConnection(null)
  }, [])

  useEffect(() => {
    return () => {
      cleanup()
    }
  }, [cleanup])

  const handleStartDirectShare = async () => {
    if (pcRef.current) {
      message.warning('已经开始共享')
      return
    }

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      })
      localStreamRef.current = stream
      setIsSharing(true)

      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream
      }

      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
      pcRef.current = pc
      setPeerConnection(pc)
      candidateQueueRef.current = []

      stream.getTracks().forEach((track) => {
        pc.addTrack(track, stream)
      })

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
          console.log('[DirectSharePage] connection state:', pc.connectionState)
        }
      }

      stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        cleanup()
        setStep('idle')
        setOfferCode('')
        setAnswerCode('')
      })

      setStep('gathering')
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      await waitForIceGatheringComplete(pc)

      const signal: DirectSignalData = {
        sdp: pc.localDescription?.toJSON() ?? offer,
        candidates: candidateQueueRef.current,
      }

      setOfferCode(serializeSignal(signal))
      setStep('offer-ready')
    } catch (err) {
      console.error('[DirectSharePage] start error:', err)
      message.error('启动直连共享失败')
      cleanup()
      setStep('idle')
    }
  }

  const handleCopyOffer = () => {
    navigator.clipboard.writeText(offerCode).then(() => {
      message.success('直连码已复制')
    })
  }

  const handleConnectAnswer = async () => {
    const pc = pcRef.current
    if (!pc) {
      message.warning('请先启动直连共享')
      return
    }

    const signal = parseSignal(answerCode.trim())
    if (!signal) {
      message.error('无效的应答码')
      return
    }

    try {
      setStep('connecting')
      await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp))
      for (const candidate of signal.candidates) {
        await pc.addIceCandidate(new RTCIceCandidate(candidate))
      }
      message.success('已应用观看端应答，等待连接建立')
    } catch (err) {
      console.error('[DirectSharePage] apply answer error:', err)
      message.error('应用应答失败')
      setStep('offer-ready')
    }
  }

  const handleStopSharing = () => {
    cleanup()
    setStep('idle')
    setOfferCode('')
    setAnswerCode('')
    message.info('已结束直连共享')
  }

  return (
    <div className="flex-1 flex items-center justify-center p-6">
      <Card className="relative w-full max-w-2xl text-center">
        <PageBackButton to="/" />

        <Title level={3} className="pt-8">
          直连共享
        </Title>
        <Paragraph type="secondary">
          无需服务器，通过手动交换 SDP/ICE 实现一对一 P2P 共享。
        </Paragraph>

        <Space direction="vertical" className="mt-4 w-full">
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Tag color="success">直连模式</Tag>
            {step !== 'idle' && (
              <Tag color={isSharing ? 'cyan' : 'default'}>
                {isSharing ? '共享中' : '未共享'}
              </Tag>
            )}
            {step === 'connected' && (
              <Tag color="success">
                <CheckCircle2 className="h-3 w-3 inline mr-1" />
                已连接
              </Tag>
            )}
          </div>

          {!isSharing ? (
            <Button
              variant="primary"
              icon={<Monitor className="h-5 w-5" />}
              block
              onClick={handleStartDirectShare}
            >
              启动直连共享
            </Button>
          ) : (
            <>
              <video
                ref={localVideoRef}
                autoPlay
                muted
                playsInline
                className="w-full rounded-lg bg-black"
                style={{ maxHeight: 320 }}
              />
              <Button
                variant="danger"
                icon={<Power className="h-5 w-5" />}
                block
                onClick={handleStopSharing}
              >
                结束共享
              </Button>
            </>
          )}

          {step === 'gathering' && (
            <Paragraph type="secondary">正在收集网络候选地址…</Paragraph>
          )}

          {offerCode && (
            <div className="text-left">
              <Paragraph className="m-0 mb-1 text-sm font-medium">
                <Link2 className="h-4 w-4 inline mr-1" />
                直连码（发送给观看端）
              </Paragraph>
              <textarea
                readOnly
                value={offerCode}
                rows={6}
                className="w-full rounded-lg border border-slate-300 bg-slate-50 p-3 font-mono text-xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              <Button
                variant="primary"
                icon={<Copy className="h-4 w-4" />}
                block
                className="mt-2"
                onClick={handleCopyOffer}
              >
                复制直连码
              </Button>
            </div>
          )}

          {offerCode && (
            <div className="text-left">
              <Paragraph className="m-0 mb-1 text-sm font-medium">
                观看端应答码（粘贴回传）
              </Paragraph>
              <textarea
                value={answerCode}
                onChange={(e) => setAnswerCode(e.target.value)}
                rows={6}
                placeholder="请将观看端返回的应答码粘贴到此处"
                className="w-full rounded-lg border border-slate-300 bg-white p-3 font-mono text-xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              <Button
                variant="primary"
                icon={<Link2 className="h-4 w-4" />}
                block
                className="mt-2"
                loading={step === 'connecting'}
                disabled={!answerCode.trim() || step === 'connecting'}
                onClick={handleConnectAnswer}
              >
                完成连接
              </Button>
            </div>
          )}

          <Paragraph type="secondary" className="text-xs">
            提示：将直连码通过即时通讯工具发送给对方，对方生成应答码后粘贴回此处即可建立连接。
          </Paragraph>
        </Space>

        {isSharing && (
          <ConnectionStatsPanel pc={peerConnection} mode="direct" />
        )}
      </Card>
    </div>
  )
}

export default DirectSharePage
