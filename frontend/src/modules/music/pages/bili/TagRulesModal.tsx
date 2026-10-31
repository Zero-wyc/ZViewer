import { Ban, X } from 'lucide-react'
import { CloudModal } from '../../components/CloudModal'
import type { RegionTagRule } from '../../utils/biliRegionFilter'
import { REGION_ROLE_LABEL, REGION_SOURCE_LABEL } from '../biliStorage'
import { t } from '@/i18n'

/** 分类标签规则弹窗（多 tag 筛选；黑底 SETTING 风格，复用屏蔽词弹窗骨架）。
 *  每条规则两个独立徽标：属性（聚合/限定）+ 来源方式（搜索/标签/全部，
 *  仅聚合属性生效）；屏蔽词不在本弹窗设置（入口在分类条目右上角），即时持久化 */
export function TagRulesModal({
  title,
  rules,
  input,
  onInputChange,
  onAdd,
  onRemove,
  onToggleRole,
  onToggleSource,
  onClose,
}: {
  title: string
  rules: RegionTagRule[]
  input: string
  onInputChange: (v: string) => void
  onAdd: () => void
  onRemove: (word: string) => void
  /** 切换属性：聚合 ↔ 限定 */
  onToggleRole: (word: string) => void
  /** 切换来源方式：搜索 → 标签 → 全部（仅聚合属性生效） */
  onToggleSource: (word: string) => void
  onClose: () => void
}) {
  return (
    /* 遮罩/面板/进出动画（两段式展开/反向收起、渐进压暗、Esc、内容
       延后挂载闸门）统一由 CloudModal 承载 */
    <CloudModal
      width="min(380px, calc(100vw - 32px))"
      height="min(500px, calc(100vh - 120px))"
      onClose={onClose}
    >
      {(unfoldDone) => (
        <>
          {/* 标题行：超大 TAG 水印 */}
          <div
            className="relative shrink-0 border-b border-white/70 px-5 pb-3 pt-4"
            style={{ animation: 'cloud-add-title-in 0.2s 0.3s both' }}
          >
            <span
              aria-hidden="true"
              className="pointer-events-none absolute -left-1 top-2 select-none text-[56px] font-black leading-none tracking-tight text-[rgba(255,255,255,0.08)]"
            >
              TAG
            </span>
            <p className="relative text-center text-[17px] font-bold text-white">
              {title}
            </p>
          </div>
          {unfoldDone && (
            <div className="relative min-h-0 flex-1 overflow-y-auto px-5 py-4">
              {/* 说明（属性 × 方式两维；屏蔽词指引到分类条目右上角入口） */}
              <div className="mb-3 space-y-1.5 text-[13px] font-medium leading-relaxed text-white/50">
                <p>
                  {t('每个标签词由两个独立徽标控制，点击词右侧对应徽标切换：')}
                </p>
                <p>
                  <span
                    className="mr-1 inline-block rounded-full px-1.5 py-0.5 text-[12px] font-bold text-white"
                    style={{ backgroundColor: 'rgba(255, 255, 255, 0.22)' }}
                  >
                    {t('聚合')}
                  </span>
                  <span
                    className="mr-1.5 inline-block rounded-full px-1.5 py-0.5 text-[12px] font-bold text-white"
                    style={{ backgroundColor: 'rgba(255, 255, 255, 0.12)' }}
                  >
                    {t('限定')}
                  </span>
                  属性：聚合词的结果并入列表（多个聚合词合并显示）；限定词要求视频标签包含该词才显示
                </p>
                <p>
                  <span
                    className="mr-1 inline-block rounded-full px-1.5 py-0.5 text-[12px] font-bold text-white"
                    style={{ backgroundColor: 'rgba(255, 255, 255, 0.22)' }}
                  >
                    {t('搜索')}
                  </span>
                  <span
                    className="mx-1 inline-block rounded-full px-1.5 py-0.5 text-[12px] font-bold text-white"
                    style={{ backgroundColor: 'rgba(255, 255, 255, 0.22)' }}
                  >
                    {t('标签')}
                  </span>
                  <span
                    className="mr-1.5 inline-block rounded-full px-1.5 py-0.5 text-[12px] font-bold text-white"
                    style={{ backgroundColor: 'rgba(255, 255, 255, 0.12)' }}
                  >
                    {t('全部')}
                  </span>
                  方式（仅聚合词生效）：搜索 = 关键词搜索；标签 = B站 tag
                  检索；全部 = 两源都取
                </p>
                <p>
                  屏蔽词不在这里设置：点音乐分区列表中分类条目右上角的
                  <Ban className="mx-1 inline h-3 w-3 align-[-2px]" />
                  按钮单独管理
                </p>
              </div>
              {/* 添加输入行 */}
              <div className="mb-3 flex items-center gap-2">
                <input
                  autoFocus
                  value={input}
                  onChange={(e) => onInputChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') onAdd()
                  }}
                  placeholder={t('输入标签词（逗号/空格分隔可批量）')}
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
                  {t('添加')}
                </button>
              </div>
              {/* 已添加规则 chips（属性徽标 + 方式徽标两个独立按钮，点击各自切换） */}
              {rules.length === 0 ? (
                <p className="text-sm font-medium text-white/40">
                  {t('暂无标签词')}
                </p>
              ) : (
                <div className="zen-scroll flex max-h-[220px] flex-wrap gap-2 overflow-y-auto">
                  {rules.map((r) => (
                    <span
                      key={r.word}
                      className="flex items-center gap-1.5 rounded-full py-1 pl-3 pr-1.5 text-sm font-bold text-white"
                      style={{
                        backgroundColor: 'rgba(255, 255, 255, 0.12)',
                      }}
                    >
                      {r.word}
                      {/* 属性徽标：聚合 ↔ 限定 */}
                      <button
                        type="button"
                        onClick={() => onToggleRole(r.word)}
                        className="rounded-full px-1.5 py-0.5 text-[12px] font-bold transition-opacity hover:opacity-70"
                        style={{ backgroundColor: 'rgba(255, 255, 255, 0.22)' }}
                        title={t('属性：{{value}}（点击切换 聚合/限定）', {
                          value: REGION_ROLE_LABEL[r.role],
                        })}
                        aria-label={t(
                          '切换标签词 {{word}} 的属性，当前 {{value}}',
                          { word: r.word, value: REGION_ROLE_LABEL[r.role] }
                        )}
                      >
                        {REGION_ROLE_LABEL[r.role]}
                      </button>
                      {/* 方式徽标：搜索 → 标签 → 全部（仅聚合属性生效） */}
                      {r.role === 'aggregate' && (
                        <button
                          type="button"
                          onClick={() => onToggleSource(r.word)}
                          className="rounded-full px-1.5 py-0.5 text-[12px] font-bold transition-opacity hover:opacity-70"
                          style={{
                            backgroundColor: 'rgba(255, 255, 255, 0.22)',
                          }}
                          title={t(
                            '来源方式：{{value}}（点击切换 搜索/标签/全部）',
                            { value: REGION_SOURCE_LABEL[r.source] }
                          )}
                          aria-label={t(
                            '切换标签词 {{word}} 的来源方式，当前 {{value}}',
                            {
                              word: r.word,
                              value: REGION_SOURCE_LABEL[r.source],
                            }
                          )}
                        >
                          {REGION_SOURCE_LABEL[r.source]}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => onRemove(r.word)}
                        className="flex h-4 w-4 items-center justify-center rounded-full transition-opacity hover:opacity-70"
                        style={{ backgroundColor: 'rgba(255, 255, 255, 0.18)' }}
                        title={t('删除标签词 {{word}}', { word: r.word })}
                        aria-label={t('删除标签词 {{word}}', { word: r.word })}
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
