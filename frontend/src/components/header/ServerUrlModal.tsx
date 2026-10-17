import { useState } from 'react'
import { Info, ShieldAlert } from 'lucide-react'
import {
  getCustomApiUrl,
  getCustomSocketUrl,
  getCustomFlvBaseUrl,
  getCustomRtmpPort,
  setCustomApiUrl,
  setCustomSocketUrl,
  setCustomFlvBaseUrl,
  setCustomRtmpPort,
  getApiUrl,
  getSocketUrl,
  getFlvBaseUrl,
  getRtmpPort,
} from '@/lib/api'
import { resetSocket } from '@/hooks/useSocket'
import { Modal } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { message } from '@/components/ui/message'

interface ServerUrlModalProps {
  onClose: () => void
}

/**
 * 自定义后端地址弹窗（打开时才挂载）。
 *
 * 挂载即从 localStorage 读取草稿值，避免同一页面会话中保存后再次
 * 打开仍显示旧值；保存后写入配置、重置 socket 并刷新页面。
 */
export function ServerUrlModal({ onClose }: ServerUrlModalProps) {
  const [customApiUrl, setCustomApiUrlState] = useState(getCustomApiUrl())
  const [customSocketUrl, setCustomSocketUrlState] =
    useState(getCustomSocketUrl())
  const [customFlvBaseUrl, setCustomFlvBaseUrlState] = useState(
    getCustomFlvBaseUrl()
  )
  const [customRtmpPort, setCustomRtmpPortState] = useState(getCustomRtmpPort())

  // 混合内容检测：HTTPS 页面 → HTTP 后端（浏览器会阻止此类请求）
  const isApiHttp = customApiUrl.startsWith('http://')
  const isSocketHttp = customSocketUrl.startsWith('http://')
  const isHttpsPage =
    typeof window !== 'undefined' && window.location.protocol === 'https:'
  const hasMixedContent = isHttpsPage && (isApiHttp || isSocketHttp)

  const handleSave = () => {
    setCustomApiUrl(customApiUrl)
    setCustomSocketUrl(customSocketUrl)
    setCustomFlvBaseUrl(customFlvBaseUrl)
    setCustomRtmpPort(customRtmpPort)
    // 地址变化后，旧的 socket 实例仍指向原 SOCKET_URL，强制重建。
    resetSocket()
    if (hasMixedContent) {
      message.warning(
        '已保存，但 HTTPS 页面无法访问 HTTP 后端。请配置反向代理或后端 HTTPS。'
      )
    } else {
      message.success('后端地址已保存，即将刷新页面生效')
    }
    onClose()
    // 刷新页面确保所有模块级 API_URL 缓存重新计算
    setTimeout(() => window.location.reload(), 600)
  }

  return (
    <Modal
      open={true}
      onClose={onClose}
      title="自定义后端地址"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" onClick={handleSave}>
            保存
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div
          className="rounded-lg p-3"
          style={{
            backgroundColor: 'var(--md-sys-color-surface-container-high)',
          }}
        >
          <div className="flex items-start gap-2">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-[var(--md-sys-color-primary)]" />
            <div className="space-y-1.5 text-xs leading-relaxed text-[var(--md-sys-color-on-surface-variant)]">
              <p className="font-medium text-[var(--md-sys-color-on-surface)]">
                只需填写一个域名即可
              </p>
              <p>
                填写你的服务器域名（例如{' '}
                <code className="rounded bg-[var(--md-sys-color-surface-container)] px-1 py-0.5">
                  example.com
                </code>
                ），其余三项留空将自动跟随。请确保已在服务器上配置反向代理（Nginx
                / Caddy），将以下路径统一转发到后端服务：
              </p>
              <ul className="ml-1 list-inside list-disc space-y-0.5">
                <li>
                  <code className="rounded bg-[var(--md-sys-color-surface-container)] px-1 py-0.5">
                    /api/*
                  </code>{' '}
                  → REST API（端口 3333）
                </li>
                <li>
                  <code className="rounded bg-[var(--md-sys-color-surface-container)] px-1 py-0.5">
                    /socket.io/*
                  </code>{' '}
                  → WebSocket 信令（端口 3333）
                </li>
                <li>
                  <code className="rounded bg-[var(--md-sys-color-surface-container)] px-1 py-0.5">
                    /live/*
                  </code>{' '}
                  → HTTP-FLV 拉流（端口 3335）
                </li>
              </ul>
              <p>
                反向代理需启用 HTTPS（SSL 证书），否则 HTTPS
                页面下的连接会被浏览器阻止。
              </p>
            </div>
          </div>
        </div>

        <Input
          label="服务器域名"
          value={customApiUrl}
          onChange={(e) => setCustomApiUrlState(e.target.value)}
          placeholder="例如: example.com"
          size="md"
        />
        <details className="text-xs text-[var(--md-sys-color-on-surface-variant)]">
          <summary className="cursor-pointer select-none font-medium">
            高级设置（通常无需修改）
          </summary>
          <div className="mt-3 space-y-3">
            <Input
              label="WebSocket / 信令地址（留空则跟随上方域名）"
              value={customSocketUrl}
              onChange={(e) => setCustomSocketUrlState(e.target.value)}
              placeholder="留空即可"
              size="md"
            />
            <Input
              label="HTTP-FLV 拉流基础地址（留空则自动推断）"
              value={customFlvBaseUrl}
              onChange={(e) => setCustomFlvBaseUrlState(e.target.value)}
              placeholder="留空即可"
              size="md"
            />
            <Input
              label="RTMP 推流端口（留空则使用默认 3334）"
              value={customRtmpPort}
              onChange={(e) => setCustomRtmpPortState(e.target.value)}
              placeholder="留空即可"
              size="md"
            />
          </div>
        </details>
        <div className="space-y-1 text-xs text-[var(--md-sys-color-on-surface-variant)]">
          <p>
            当前 API 地址:{' '}
            <code className="bg-[var(--md-sys-color-surface-container)] px-1 py-0.5 rounded">
              {getApiUrl()}
            </code>
          </p>
          <p>
            当前 WebSocket 地址:{' '}
            <code className="bg-[var(--md-sys-color-surface-container)] px-1 py-0.5 rounded">
              {getSocketUrl()}
            </code>
          </p>
          <p>
            当前 FLV 基础地址:{' '}
            <code className="bg-[var(--md-sys-color-surface-container)] px-1 py-0.5 rounded">
              {getFlvBaseUrl() || '(相对路径 /live)'}
            </code>
          </p>
          <p>
            当前 RTMP 端口:{' '}
            <code className="bg-[var(--md-sys-color-surface-container)] px-1 py-0.5 rounded">
              {getRtmpPort()}
            </code>
          </p>
        </div>

        {hasMixedContent && (
          <div
            className="rounded-lg border p-3"
            style={{
              borderColor: 'var(--md-sys-color-error)',
              backgroundColor:
                'rgba(var(--md-sys-color-error-container-rgb, 249, 233, 232), 0.95)',
              color: 'var(--md-sys-color-on-error-container)',
            }}
          >
            <div className="flex items-center gap-2 text-sm font-medium">
              <ShieldAlert className="h-4 w-4 shrink-0" />
              <span>检测到混合内容（HTTPS → HTTP）</span>
            </div>
            <p className="mt-1.5 text-xs leading-relaxed">
              当前页面为 HTTPS，但后端地址为 HTTP。浏览器会阻止 HTTPS 页面发起的
              HTTP 请求，API 和 WebSocket 连接均无法正常工作。
            </p>
            <p className="mt-2 text-xs font-medium">推荐方案：</p>
            <ul className="mt-1 list-inside list-disc space-y-0.5 text-xs">
              <li>
                使用反向代理（Nginx / Caddy）统一提供
                HTTPS，后端通过反向代理访问
              </li>
              <li>或为后端 Express 服务直接配置 HTTPS 证书</li>
              <li>
                或使用 Docker 部署，前端 Nginx 自动代理 /api 和 /socket.io
                到后端
              </li>
            </ul>
          </div>
        )}

        <div className="text-xs text-[var(--md-sys-color-on-surface-variant)]">
          提示：留空将使用环境变量或页面默认值，保存后会自动刷新页面使配置生效。
        </div>
      </div>
    </Modal>
  )
}
