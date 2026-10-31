# 前端多语言（i18n）

界面文案统一走 `t()`，**key 就是中文原文**：

```tsx
import { t } from '@/i18n'

t('加入语音') // 直接取词条
t('已复制 {{n}} 项', { n: 3 }) // 带插值
```

- 全部词条集中在 [`locales/zh-CN.ts`](./locales/zh-CN.ts)，它由脚本从源码生成，**不要手改**。
- `locales/en-US.ts` 是空壳：缺词条时回退到 `zh-CN`，所以翻译可以一条条补，不用等齐。
- 语言切换在「个人中心 → 界面语言」，存在 `store/languageStore.ts`；`App` 顶层订阅它，
  切语言时整树重渲染（不用 `useTranslation()` 也能生效）。

## 改完文案要重新抽取

```bash
npm run i18n:extract --scope src/modules/room --write   # 只处理某个目录
npm run i18n:extract --write                            # 全量
npm run i18n:dict                                       # 只重建词条表
npm run i18n:check                                      # 校验词条表是否最新（CI 会跑）
```

脚本（`scripts/i18n-extract.mjs`）会把源码里的中文换成 `t('…')`，支持：

| 源码写法 | 处理结果 |
| --- | --- |
| `title="中文"`、`<div>中文</div>` | `t('中文')` |
| `` `共 ${n} 条` `` | `t('共 {{n}} 条', { n })` |
| `<span>已复制 {n} 项</span>` | `<span>{t('已复制 {{n}} 项', { n })}</span>` |
| `TABLE[k].label`（中文标签表） | `t(TABLE[k].label)` |

## 刻意不自动改的地方

| 原因 | 说明 |
| --- | --- |
| `module-scope` | 模块作用域常量（标签表）**值就是 key**，定义处不能 `t()`（会在模块加载时定格语言），只在渲染处包 |
| `console` | 日志，不是界面文字 |
| `comparison` / `string-match` | 与后端返回串、接口字段比较的字面量，翻译了逻辑就坏 |
| `stylesheet` | 内联样式表等超长字符串 |
| `jsx-multi-child` | 一句话被 `<strong>`/`<code>` 切开：改成 `<Trans i18nKey="…<strong>{{x}}</strong>…">` |

## 陷阱

- **模块作用域里不要直接调 `t()`**：`const LABELS = { a: t('中文') }` 会在模块加载时定死语言。
  存中文原文当 key，渲染时 `t(LABELS.a)`。
- **`<Trans>` 的 `i18nKey` 要写全标签**，例如
  `i18nKey="确定要删除用户 <strong>{{name}}</strong> 吗？"`，配 `components={{ strong: <strong /> }}`。
- **别翻译逻辑常量**：`msg.includes('未提供认证令牌')` 里的中文是后端协议的一部分。
- `keySeparator: false`、`nsSeparator: false`：key 可以包含 `.` 和 `:`，不会被当成层级或命名空间。
