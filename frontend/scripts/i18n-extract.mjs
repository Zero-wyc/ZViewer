/**
 * 前端文案抽取 / 替换工具（一次性 codemod，可重复跑）。
 *
 * 把源码里的中文文案换成 `t('中文原文')`，并同步生成 `src/i18n/locales/zh-CN.ts`。
 * key 就是中文原文，所以词条表的 key 与 value 相同——它同时充当「全部文案清单」。
 *
 * 用法：
 *   node scripts/i18n-extract.mjs                       # 只扫描 src，打印统计
 *   node scripts/i18n-extract.mjs --scope src/lib       # 限定目录/文件（可重复）
 *   node scripts/i18n-extract.mjs --write               # 真正改代码 + 重写中文词典
 *   node scripts/i18n-extract.mjs --check               # CI：词典是否与源码一致
 *   node scripts/i18n-extract.mjs --report out.json     # 未自动处理的清单落盘
 *
 * 刻意**不**自动处理的情况（会在报告里列出来，人工改）：
 * - 一个 JSX 元素里有多个子节点（`<span>已复制 {n} 项</span>`，要拆句或上 Trans）
 * - 带 `${}` 的模板字符串（要改成插值 `t('...{{x}}', { x })`）
 * - `=== '中文'` 这类与非界面值做比较的字面量
 * - 已被 `t()` 包住的（重复跑不会二次包裹）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FRONTEND = path.join(HERE, '..')
const SRC = path.join(FRONTEND, 'src')
const DICT_FILE = path.join(SRC, 'i18n', 'locales', 'zh-CN.ts')

const HAN = /[\u4e00-\u9fa5]/
const hasHan = (text) => HAN.test(text)

/** 这些 JSX 属性是给人看的文案，其余（className/style/href…）一律不碰 */
const TEXT_ATTRS = new Set([
  'title',
  'label',
  'placeholder',
  'alt',
  'aria-label',
  'aria-description',
  'hint',
  'description',
  'emptyText',
  'confirmText',
  'cancelText',
  'tooltip',
  'subtitle',
])

/** 不参与扫描的路径 */
const SKIP_PATH = [
  /[\\/]i18n[\\/]locales[\\/]/,
  /[\\/]__tests__[\\/]/,
  /\.test\.tsx?$/,
  /[\\/]node_modules[\\/]/,
  // 日志/调试工具：这些中文只进控制台与日志文件，不是界面文案
  /[\\/]lib[\\/]clientLogger\.ts$/,
  /[\\/]lib[\\/]media-debug\.ts$/,
  /[\\/]lib[\\/]mkv[\\/]/,
]

/** 词典里的分组顺序（按文件路径判定，稳定的分组便于 review） */
const BUCKETS = [
  'components/ui',
  'components',
  'hooks',
  'lib',
  'store',
  'pages',
  'modules',
  'common',
]

function bucketOf(file) {
  const rel = path.relative(SRC, file).split(path.sep).join('/')
  if (rel.startsWith('components/ui/')) return 'components/ui'
  if (rel.startsWith('components/')) return 'components'
  if (rel.startsWith('hooks/')) return 'hooks'
  if (rel.startsWith('lib/')) return 'lib'
  if (rel.startsWith('store/')) return 'store'
  if (rel.startsWith('pages/')) return 'pages'
  const m = rel.match(/^modules\/([^/]+)\//)
  if (m) return `modules/${m[1]}`
  return 'common'
}

function parseArgs(argv) {
  const scopes = []
  let write = false
  let check = false
  let report = null
  let dictOnly = false
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--write') write = true
    else if (arg === '--check') check = true
    else if (arg === '--dict-only') dictOnly = true
    else if (arg === '--scope') scopes.push(argv[++i])
    else if (arg === '--report') report = argv[++i]
    else if (arg === '--help' || arg === '-h') {
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0])
      process.exit(0)
    } else {
      console.error(`未知参数: ${arg}`)
      process.exit(2)
    }
  }
  return { scopes, write, check, report, dictOnly }
}

function walkFiles(target, out = []) {
  const stat = fs.statSync(target)
  if (stat.isFile()) {
    if (/\.tsx?$/.test(target) && !SKIP_PATH.some((re) => re.test(target))) out.push(target)
    return out
  }
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const full = path.join(target, entry.name)
    if (SKIP_PATH.some((re) => re.test(full))) continue
    if (entry.isDirectory()) walkFiles(full, out)
    else if (/\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

/** 该文件里是否已经占了 `t` 这个名字（参数、变量、catch…），占了就换别名 */
function bindsIdentifier(sourceFile, name) {
  let found = false
  const checkBindingName = (node) => {
    if (!node) return
    if (ts.isIdentifier(node) && node.text === name) found = true
    else if (ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) {
      for (const element of node.elements) {
        if (ts.isBindingElement(element)) checkBindingName(element.name)
      }
    }
  }
  const visit = (node) => {
    if (found) return
    if (ts.isVariableDeclaration(node)) checkBindingName(node.name)
    if (
      ts.isParameter(node) ||
      ts.isBindingElement(node) ||
      ts.isCatchClause(node)
    ) {
      checkBindingName(node.name ?? node.variableDeclaration?.name)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return found
}

function isInsideConsole(node) {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (ts.isCallExpression(cur)) {
      const callee = cur.expression.getText()
      if (callee === 'console' || callee.startsWith('console.')) return true
    }
  }
  return false
}

function isInsideT(node, name) {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (ts.isCallExpression(cur) && cur.expression.getText() === name) return true
  }
  return false
}

/**
 * 是否处在模块/类作用域（没被任何函数包住）。
 *
 * 这类字面量（常量表里的 label、枚举中文名）如果直接换成 t()，会在模块加载时
 * 就把当时的语言定格下来，切语言后不刷新——必须改成「存 key、渲染期再 t()」。
 * 所以这里不自动改，交给人工。
 */
function inModuleScope(node) {
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (ts.isFunctionLike(cur)) return false
    if (ts.isSourceFile(cur)) return true
  }
  return false
}

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
}

/** 单引号字面量转义（词典与代码里共用同一套写法） */
function quote(text) {
  // TS 的 StringLiteral.text 会把 \n 还原成真实换行，写回词典前必须再转义一次
  return `'${text
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')}'`
}

/** 把 JSX 文本的换行/缩进按 JSX 语义折叠成单个空格 */
function normalizeText(text) {
  return text.replace(/\s+/g, ' ').trim()
}

function transformFile(file, options) {
  const source = fs.readFileSync(file, 'utf8')
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )

  const callName = bindsIdentifier(sourceFile, 't') ? 'translate' : 't'
  const edits = []
  const keys = []
  const skipped = []

  const addEdit = (start, end, text) => edits.push({ start, end, text })
  const addKey = (text) => {
    if (!keys.includes(text)) keys.push(text)
  }
  const skip = (node, reason, text) =>
    skipped.push({ file: path.relative(FRONTEND, file), line: lineOf(sourceFile, node), reason, text })

  /** JSX 元素是否只有一个「有内容」的子节点（多子节点不自动拆句） */
  const isSingleChildElement = (element) => {
    const meaningful = element.children.filter(
      (child) => !(ts.isJsxText(child) && !child.text.trim())
    )
    return meaningful.length === 1
  }

  const visit = (node) => {
    // 1) JSX 文本节点：<div>中文</div>
    if (ts.isJsxText(node)) {
      const text = normalizeText(node.text)
      if (!text || !hasHan(text)) return
      if (inModuleScope(node)) {
        // 不自动替换（会在模块加载时定格语言），但文案本身要进词典
        addKey(text)
        skip(node, 'module-scope', text)
        return
      }
      const parent = node.parent
      if (ts.isJsxElement(parent) || ts.isJsxFragment(parent)) {
        if (ts.isJsxElement(parent) && !isSingleChildElement(parent)) {
          skip(node, 'jsx-multi-child', text)
          return
        }
        addKey(text)
        addEdit(node.getStart(sourceFile), node.getEnd(), `{${callName}(${quote(text)})}`)
      }
      return
    }

    // 2) JSX 属性：title="中文"（白名单内才动）
    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText()
      const init = node.initializer
      if (init && ts.isStringLiteral(init) && hasHan(init.text)) {
        const text = init.text
        if (inModuleScope(node)) {
          skip(node, 'module-scope', text)
        } else if (!TEXT_ATTRS.has(name)) {
          skip(node, `jsx-attr:${name}`, text)
        } else {
          addKey(text)
          addEdit(init.getStart(sourceFile), init.getEnd(), `{${callName}(${quote(text)})}`)
        }
        return
      }
      // 非字符串初值（title={cond ? '中文' : ''}）继续往下走，处理里面的字面量
      ts.forEachChild(node, visit)
      return
    }

    // 3) 普通字符串字面量（含无插值的模板串）
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const text = node.text
      if (!hasHan(text)) return
      if (isInsideT(node, 't') || isInsideT(node, 'translate')) {
        addKey(text)
        return
      }
      if (inModuleScope(node)) {
        // 不自动替换（会在模块加载时定格语言），但文案本身要进词典
        addKey(text)
        skip(node, 'module-scope', text)
        return
      }
      const parent = node.parent
      if (ts.isJsxAttribute(parent)) return // 上面处理过（或明确跳过）
      if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return
      if (parent.name === node) return // 对象/属性名
      if (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) return
      if (ts.isCaseClause(parent)) {
        skip(node, 'switch-case', text)
        return
      }
      if (
        ts.isBinaryExpression(parent) &&
        ['===', '!==', '==', '!='].includes(parent.operatorToken.getText())
      ) {
        skip(node, 'comparison', text)
        return
      }
      if (isInsideConsole(node)) {
        skip(node, 'console', text)
        return
      }
      // 与后端返回的字符串做匹配（msg.includes('中文')）：这类是逻辑常量，翻译会直接坏掉
      if (
        ts.isCallExpression(parent) &&
        ts.isPropertyAccessExpression(parent.expression) &&
        ['includes', 'startsWith', 'endsWith', 'indexOf', 'lastIndexOf', 'match', 'split'].includes(
          parent.expression.name.getText()
        )
      ) {
        skip(node, 'string-match', text)
        return
      }
      addKey(text)
      addEdit(node.getStart(sourceFile), node.getEnd(), `${callName}(${quote(text)})`)
      return
    }

    // 4) 带插值的模板串：需要改写成 t('...{{x}}', { x })，人工来
    if (ts.isTemplateExpression(node) && hasHan(node.getText())) {
      skip(node, 'template-interpolation', normalizeText(node.getText()))
      return
    }

    ts.forEachChild(node, visit)
  }

  visit(sourceFile)

  // 收集已有 t('中文') 的 key（重复跑时词典保持一致）
  const collectExisting = (node) => {
    if (ts.isCallExpression(node) && node.expression.getText() === callName) {
      const arg = node.arguments[0]
      if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
        if (hasHan(arg.text)) addKey(arg.text)
      }
    }
    ts.forEachChild(node, collectExisting)
  }
  collectExisting(sourceFile)

  if (edits.length === 0) return { file, keys, skipped, changed: false }

  // 排序后从后往前替换，避免位置漂移
  edits.sort((a, b) => b.start - a.start)
  let output = source
  for (const edit of edits) {
    output = output.slice(0, edit.start) + edit.text + output.slice(edit.end)
  }

  // 补 import：放在最后一条顶层 import 之后
  const alreadyImported =
    /import\s*\{[^}]*\b(t|translate)\b[^}]*\}\s*from\s*'@\/i18n'/.test(output)
  if (!alreadyImported) {
    const importLine =
      callName === 't'
        ? "import { t } from '@/i18n'\n"
        : "import { t as translate } from '@/i18n'\n"
    let insertAt = 0
    const reparsed = ts.createSourceFile(file, output, ts.ScriptTarget.Latest, true)
    for (const stmt of reparsed.statements) {
      if (ts.isImportDeclaration(stmt)) insertAt = stmt.getEnd()
    }
    if (insertAt > 0) {
      // 放到该语句所在行的下一行开头，避免插到分号后面把两行粘在一起
      const newline = output.indexOf('\n', insertAt)
      insertAt = newline === -1 ? output.length : newline + 1
    }
    output = output.slice(0, insertAt) + importLine + output.slice(insertAt)
  }

  return { file, keys, skipped, changed: true, output }
}

/** 生成 zh-CN.ts 的内容（与手写风格一致，带分组注释） */
function renderDict(allKeys) {
  // 同一条文案在多个模块出现时只登记一次，归到第一次出现的分组
  const firstBucket = new Map()
  for (const { bucket, key } of allKeys) {
    if (!firstBucket.has(key)) firstBucket.set(key, bucket)
  }
  const groups = new Map()
  for (const [key, bucket] of firstBucket) {
    if (!groups.has(bucket)) groups.set(bucket, new Set())
    groups.get(bucket).add(key)
  }
  const ordered = [...groups.keys()].sort((a, b) => {
    const ai = BUCKETS.indexOf(a)
    const bi = BUCKETS.indexOf(b)
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi) || a.localeCompare(b)
  })
  const lines = []
  for (const bucket of ordered) {
    const keys = [...groups.get(bucket)].sort((a, b) => a.localeCompare(b, 'zh-CN'))
    lines.push(`  // ===== ${bucket}（${keys.length} 条） =====`)
    for (const key of keys) lines.push(`  ${quote(key)}: ${quote(key)},`)
    lines.push('')
  }
  const total = firstBucket.size
  return `/**
 * 中文词条清单（默认语言，key 与 value 相同）。
 *
 * 这个文件由 \`node scripts/i18n-extract.mjs --write\` 从源码生成，**不要手改**：
 * 要改文案直接改代码里的中文，再跑一次脚本；\`npm run i18n:check\` 会校验它是否最新。
 *
 * 它的作用是「一眼看全所有界面文字」——交给翻译、审文案、查重复都只看这一份；
 * 运行时也加载它（key 与 value 相同，等于把中文原文显式登记一遍）。
 *
 * 当前共 ${total} 条。
 */
const zhCN: Record<string, string> = {
${lines.join('\n').trimEnd()}
}

export default zhCN
`
}

function main() {
  const { scopes, write, check, report, dictOnly } = parseArgs(process.argv.slice(2))
  const targets = scopes.length > 0 ? scopes : ['src']
  // 词典是「全部文案的清单」：--dict-only / --check 一律全量扫描 src，
  // 不受本次改造范围（--scope）限制。
  const scanTargets = dictOnly || check ? ['src'] : targets
  const files = []
  for (const target of scanTargets) walkFiles(path.resolve(FRONTEND, target), files)

  const allKeys = []
  const skipped = []
  let changedFiles = 0

  for (const file of files.sort()) {
    const result = transformFile(file)
    for (const key of result.keys) allKeys.push({ bucket: bucketOf(file), key })
    skipped.push(...result.skipped)
    if (!result.changed) continue
    changedFiles += 1
    // 统一写成 LF：Windows 上自动检出常把工作区文件变成 CRLF，
    // 原样写回会让 git 认为整文件都改了。
    const output = result.output.replace(/\r\n/g, '\n')
    if (write && !dictOnly) fs.writeFileSync(file, output, 'utf8')
    else if (!check) {
      // 只扫描时不落盘，但要让人知道改哪些文件
      console.log(`  待改: ${path.relative(FRONTEND, file)}`)
    }
  }

  const uniqueKeys = [...new Set(allKeys.map((item) => item.key))]
  console.log(`\n扫描文件 ${files.length} 个，${write ? '已改' : '待改'} ${changedFiles} 个`)
  console.log(`文案 ${uniqueKeys.length} 条（去重后），出现 ${allKeys.length} 次`)
  if (skipped.length > 0) {
    const byReason = {}
    for (const item of skipped) byReason[item.reason] = (byReason[item.reason] ?? 0) + 1
    console.log('需要人工处理的：')
    for (const [reason, count] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${reason}: ${count}`)
    }
  }

  if (write || dictOnly) {
    const dict = renderDict(allKeys.filter((item) => uniqueKeys.includes(item.key)))
    fs.writeFileSync(DICT_FILE, dict, 'utf8')
    console.log(`词典已更新: ${path.relative(FRONTEND, DICT_FILE)}`)
  }

  if (check) {
    const expected = renderDict(allKeys.filter((item) => uniqueKeys.includes(item.key)))
    const current = fs.existsSync(DICT_FILE) ? fs.readFileSync(DICT_FILE, 'utf8') : ''
    const same = current.replace(/\r\n/g, '\n').trim() === expected.trim()
    if (!same) {
      console.error('\n词典与源码不一致：请运行 node scripts/i18n-extract.mjs --write')
      process.exit(1)
    }
    console.log('词典与源码一致')
  }

  if (report) {
    fs.writeFileSync(report, JSON.stringify({ skipped, keys: uniqueKeys }, null, 2), 'utf8')
    console.log(`报告已写入: ${report}`)
  }
}

main()
