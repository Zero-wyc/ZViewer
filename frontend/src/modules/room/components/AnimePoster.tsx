import { useEffect, useState } from 'react'
import { apiFetch, getApiUrl } from '@/lib/api'

/** Use the authenticated media proxy when the source blocks direct images. */
export function AnimePoster({
  cover,
  title,
  kind,
  referer,
}: {
  cover?: string
  title: string
  kind: 'kazumi' | 'anisubs'
  referer: string
}) {
  const [failed, setFailed] = useState(false)
  const [proxied, setProxied] = useState<string>()
  useEffect(() => {
    if (!cover || !failed) return
    const controller = new AbortController()
    let objectUrl: string | undefined
    const params = new URLSearchParams({ url: cover, referer })
    void apiFetch(`${getApiUrl()}/api/stream/${kind}/proxy?${params}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (
          !response.ok ||
          !response.headers.get('content-type')?.startsWith('image/')
        )
          return
        const blob = await response.blob()
        if (controller.signal.aborted) return
        objectUrl = URL.createObjectURL(blob)
        setProxied(objectUrl)
      })
      .catch(() => {
        /* Keep the placeholder on failure. */
      })
    return () => {
      controller.abort()
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [cover, failed, kind, referer])
  if (!cover || (failed && !proxied)) return null
  return (
    <img
      src={proxied || cover}
      alt={title}
      loading="lazy"
      referrerPolicy="no-referrer"
      className="relative h-full w-full object-cover"
      onError={(event) => {
        if (proxied) event.currentTarget.style.visibility = 'hidden'
        else setFailed(true)
      }}
    />
  )
}
