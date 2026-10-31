/**
 * 运行时冒烟：直接加载 `src/i18n/index.ts`，确认真实配置下中英取值正确。
 *
 *   node --experimental-strip-types scripts/i18n-probe-runtime.mjs
 */
import { i18next, t } from '../src/i18n/index.ts'

const samples = [
  ['创建房间', {}],
  ['{{count}} 集', { count: 3 }],
  ['{{count}} 集', { count: 1 }],
  ['后端已自动重启（第 {{count}} 次），服务已恢复', { count: 2 }],
  ['{{who}} 申请{{playItem}}', { who: 'Alice', playItem: 'Change track' }],
  ['房主已同意{{value}}', { value: 'Pause' }],
  ['设置(离开页面以保存设置或', {}],
  ['保存)', {}],
  ['」', {}],
]

for (const [key, vars] of samples) {
  const zh = i18next.getFixedT('zh-CN')(key, vars)
  const en = i18next.getFixedT('en-US')(key, vars)
  console.log(`${key} ${JSON.stringify(vars)}\n  zh: ${zh}\n  en: ${en}`)
}

await i18next.changeLanguage('en-US')
console.log(`\n切到英文后 t('一起听') = ${t('一起听')}`)
