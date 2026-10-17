import { X } from 'lucide-react'
import { CloudModal } from '../../components/CloudModal'
import type { BlockWord } from '../../utils/biliRegionFilter'
import { SCOPE_LABEL } from '../biliStorage'

/** 屏蔽词设置弹窗（黑底 SETTING 风格：高斯模糊 + 四角白方块 + 大字水印）。
 * 添加/删除即时持久化；关闭时由调用方重载列表使过滤生效。
 * 全局弹窗与分区弹窗共用（分区弹窗传 title + description 说明仅本分区生效） */
export function BlockWordsModal({
  title = '屏蔽词设置',
  description,
  words,
  input,
  onInputChange,
  onAdd,
  onRemove,
  onToggleScope,
  onClose,
}: {
  /** 弹窗标题（分区弹窗传「分区名」屏蔽词） */
  title?: string
  /** 说明文案（分区弹窗传「仅对该分区生效」提示）；缺省用全局默认 */
  description?: string
  words: BlockWord[]
  input: string
  onInputChange: (v: string) => void
  onAdd: () => void
  onRemove: (word: string) => void
  /** 切换词作用范围：全部 → 标题 → 标签 */
  onToggleScope: (word: string) => void
  onClose: () => void
}) {
  return (
    /* 遮罩/面板/进出动画（两段式展开/反向收起、渐进压暗、Esc、内容
       延后挂载闸门）统一由 CloudModal 承载 */
    <CloudModal
      width="min(380px, calc(100vw - 32px))"
      height="min(440px, calc(100vh - 120px))"
      onClose={onClose}
    >
      {(unfoldDone) => (
        <>
          {/* 标题行：超大 BLOCK 水印压在「屏蔽词设置」后面 */}
          <div
            className="relative shrink-0 border-b border-white/70 px-5 pb-3 pt-4"
            style={{ animation: 'cloud-add-title-in 0.2s 0.3s both' }}
          >
            <span
              aria-hidden="true"
              className="pointer-events-none absolute -left-1 top-2 select-none text-[56px] font-black leading-none tracking-tight text-[rgba(255,255,255,0.08)]"
            >
              BLOCK
            </span>
            <p className="relative text-center text-[17px] font-bold text-white">
              {title}
            </p>
          </div>
          {unfoldDone && (
            <div className="relative min-h-0 flex-1 overflow-y-auto px-5 py-4">
              <p className="mb-3 text-[13px] font-medium text-white/50">
                {description ??
                  '全局生效：命中屏蔽词的搜索结果将被隐藏；点击词上的范围徽标可单独设置匹配标题还是标签'}
              </p>
              {/* 添加输入行 */}
              <div className="mb-3 flex items-center gap-2">
                <input
                  autoFocus
                  value={input}
                  onChange={(e) => onInputChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') onAdd()
                  }}
                  placeholder="输入屏蔽词（逗号/空格分隔可批量）"
                  className="h-8 min-w-0 flex-1 rounded-full px-3 text-sm font-bold outline-none"
                  style={{
                    backgroundColor: 'rgba(255, 255, 255, 0.08)',
                    color: '#ffffff',
                    border: '0.5px solid rgba(255, 255, 255, 0.25)',
                  }}
                />
                <button
                  type="button"
                  onClick={onAdd}
                  className="shrink-0 rounded-full px-3 py-1.5 text-sm font-bold transition-opacity hover:opacity-70"
                  style={{ backgroundColor: '#ffffff', color: '#000000' }}
                >
                  添加
                </button>
              </div>
              {/* 已添加屏蔽词 chips */}
              {words.length === 0 ? (
                <p className="text-sm font-medium text-white/40">暂无屏蔽词</p>
              ) : (
                <div className="flex max-h-[220px] flex-wrap gap-2 overflow-y-auto zen-scroll">
                  {words.map((b) => (
                    <span
                      key={b.word}
                      className="flex items-center gap-1.5 rounded-full py-1 pl-3 pr-1.5 text-sm font-bold text-white"
                      style={{
                        backgroundColor: 'rgba(255, 255, 255, 0.12)',
                      }}
                    >
                      {b.word}
                      {/* 范围徽标：点击循环 全部 → 标题 → 标签 */}
                      <button
                        type="button"
                        onClick={() => onToggleScope(b.word)}
                        className="rounded-full px-1.5 py-0.5 text-[12px] font-bold transition-opacity hover:opacity-70"
                        style={{ backgroundColor: 'rgba(255, 255, 255, 0.22)' }}
                        title={`作用范围：${SCOPE_LABEL[b.scope]}（点击切换）`}
                        aria-label={`切换屏蔽词 ${b.word} 的作用范围，当前 ${SCOPE_LABEL[b.scope]}`}
                      >
                        {SCOPE_LABEL[b.scope]}
                      </button>
                      <button
                        type="button"
                        onClick={() => onRemove(b.word)}
                        className="flex h-4 w-4 items-center justify-center rounded-full transition-opacity hover:opacity-70"
                        style={{ backgroundColor: 'rgba(255, 255, 255, 0.18)' }}
                        title={`删除屏蔽词 ${b.word}`}
                        aria-label={`删除屏蔽词 ${b.word}`}
                      >
                        <X className="h-2.5 w-2.5" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </CloudModal>
  )
}
