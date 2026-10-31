# 前端多语言（i18n）

界面文案统一走 `t()`，**key 就是中文原文**：

```tsx
import { t } from '@/i18n'

t('加入语音') // 直接取词条
t('已复制 {{n}} 项', { n: 3 }) // 带插值
```

- 全部词条集中在 [`locales/zh-CN.ts`](./locales/zh-CN.ts)，它由脚本从源码生成，**不要手改**。
- [`locales/en-US.ts`](./locales/en-US.ts) 是英文词条，同样由脚本生成（见下面「英文译文」）。
  任何缺词条的地方都会回退成中文原文，所以翻译可以分批补，不会露出 key 占位符。
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

## 英文译文

`locales/en-US.ts` 不从源码抽取，而是从**分块译文**合成：

```bash
npm run i18n:build          # 由 parts/*.en.json 合成 en-US.ts
npm run i18n:check          # 校验：词条表最新 + 译文占位符/标签一致 + 无孤儿词条
node scripts/i18n-translate.mjs --status   # 看覆盖率与哪些块还没翻
```

- 译文源文件在 `scripts/i18n-en/parts/*.en.json`，与 `*.zh.json` **等长且顺序一一对应**
  （只存英文数组，避免重复抄写中文 key）。
- `scripts/i18n-en/overrides.json` 放「只对英文有效」的条目：单复数形式
  （`{{count}} 集_one`）、纯标点（`」` → `”`）、以及个别需要改写语序的句子。
- 中文文案改动后：`npm run i18n:dict` → `npm run i18n:plan` → 补新条目的译文 →
  `npm run i18n:build`。重切块会让旧 `*.en.json` 错位，用
  `node scripts/i18n-en/remap.mjs` 按「中文原文 → 译文」重新分配（已翻的不丢）。

辅助脚本：

| 脚本 | 用途 |
| --- | --- |
| `scripts/peek-en.mjs "中文"` | 命令行查某条的中英对照 |
| `scripts/i18n-audit-args.mjs` | 找「插值实参引用了中文常量表却没包 `t()`」的地方（英文界面会漏中文） |
| `scripts/i18n-probe-runtime.mjs` | 打包后用真实 `i18n` 配置跑一遍取词，验证插值与复数 |

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
- **插值实参也要翻**：`t('{{who}} 申请{{playItem}}', { who, playItem })` 里 `playItem`
  若是常量表里的中文，要写成 `t(CONTROL_ACTION_TEXT[action])`，否则英文界面会半中半英。
- **`{{count}}` 会被当成复数**：i18next 见到该参数就查 `<key>_one` / `<key>_other`，
  找不到会整条回退成中文。`i18n/index.ts` 的 `withPlurals()` 已自动补齐，
  需要区分单复数时在 `overrides.json` 里写 `<key>_one`。
- `keySeparator: false`、`nsSeparator: false`：key 可以包含 `.` 和 `:`，不会被当成层级或命名空间。
