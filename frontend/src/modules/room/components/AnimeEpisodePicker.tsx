import { useState } from 'react'
import { CheckSquare, Plus, Play } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import type { AniSubsEpisode } from '@/modules/anisubs'

export interface AnimeEpisodeSelection {
  sourceId: string
  episode: AniSubsEpisode
  title: string
}

interface Props {
  episodes: AniSubsEpisode[]
  sourceId: string
  title: string
  disabled?: boolean
  onSelect: (episode: AniSubsEpisode) => void
  onSelectMany: (items: AnimeEpisodeSelection[]) => Promise<string[]>
}

export function AnimeEpisodePicker({
  episodes,
  sourceId,
  title,
  disabled,
  onSelect,
  onSelectMany,
}: Props) {
  const [multiSelect, setMultiSelect] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [adding, setAdding] = useState(false)
  const busy = disabled || adding

  const toggle = (id: string) => {
    setSelected((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const addSelected = async () => {
    setAdding(true)
    try {
      const added = await onSelectMany(
        episodes
          .filter((episode) => selected.has(episode.id))
          .map((episode) => ({
            sourceId,
            episode,
            title: `${title} - ${episode.title}`,
          }))
      )
      setSelected((previous) => {
        const next = new Set(previous)
        added.forEach((id) => next.delete(id))
        return next
      })
    } finally {
      setAdding(false)
    }
  }

  return (
    <div className="mt-2">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant={multiSelect ? 'primary' : 'secondary'}
          icon={<CheckSquare className="h-4 w-4" />}
          disabled={busy}
          onClick={() => {
            setMultiSelect(!multiSelect)
            setSelected(new Set())
          }}
        >
          {multiSelect ? '退出多选' : '多选'}
        </Button>
        {multiSelect && (
          <>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                setSelected(new Set(episodes.map((episode) => episode.id)))
              }
            >
              全选
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || selected.size === 0}
              onClick={() => setSelected(new Set())}
            >
              清空
            </Button>
          </>
        )}
      </div>
      <div className="grid max-h-[200px] grid-cols-1 gap-1.5 overflow-y-auto sm:grid-cols-2">
        {episodes.map((episode) => (
          <div key={episode.id}>
            {multiSelect ? (
              <label className="flex min-h-9 cursor-pointer items-center gap-2 rounded border p-2 text-xs has-[:checked]:border-[var(--md-sys-color-primary)] has-[:checked]:bg-[var(--md-sys-color-primary-container)]">
                <input
                  type="checkbox"
                  className="shrink-0 accent-[var(--md-sys-color-primary)]"
                  checked={selected.has(episode.id)}
                  disabled={busy}
                  onChange={() => toggle(episode.id)}
                />
                <span className="min-w-0 break-words">{episode.title}</span>
              </label>
            ) : (
              <button
                type="button"
                className="flex min-h-9 w-full items-center gap-2 rounded border border-transparent p-2 text-left text-xs hover:border-[var(--md-sys-color-primary)] disabled:opacity-60"
                disabled={busy}
                onClick={() => onSelect(episode)}
              >
                <Play className="h-3 w-3 shrink-0" />
                <span className="min-w-0 break-words">{episode.title}</span>
              </button>
            )}
          </div>
        ))}
      </div>
      {multiSelect && (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs">已选 {selected.size} 集</span>
          <Button
            size="sm"
            variant="primary"
            icon={<Plus className="h-4 w-4" />}
            loading={adding}
            disabled={busy || selected.size === 0}
            onClick={() => void addSelected()}
          >
            添加所选
          </Button>
        </div>
      )}
    </div>
  )
}
