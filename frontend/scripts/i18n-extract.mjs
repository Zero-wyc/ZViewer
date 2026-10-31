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
 * 带 `${}` 的模板串会自动改成插值形式：`已复制 ${n} 项` → `t('已复制 {{n}} 项', { n })`。
 *
 * 刻意**不**自动处理的情况（会在报告里列出来，人工改）：
 * - 一个 JSX 元素里有多个子节点（`<span>已复制 {n} 项</span>`，要拆句或上 Trans）
 * - 模块/类作用域里的常量（`const LABELS = { a: '中文' }`，渲染期才 t() 才不会定格语言）
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

/**
 * 是不是「不像界面文案」的大段内容：内联样式表、SQL、正则之类的模板串。
 *
 * 典型误伤是组件里 `const CSS = \`@keyframes ...\`` 这种上千字符的字符串——
 * 里面有中文注释，但不是给人读的界面文字，进词典只会污染清单。
 */
function looksLikeStylesheet(text) {
  if (text.length > 240) return true
  return /@keyframes|@media|@font-face|@supports/.test(text)
}

/** 这些 JSX 属性是给人看的文案，其余（className/style/href…）一律不碰 */
const TEXT_ATTRS = new Set([
  'title',
  'label',
  'placeholder',
  'alt',
  'aria-label',
  'aria-description',
  'ariaLabel',
  'hint',
  'description',
  'emptyText',
  'confirmText',
  'cancelText',
  'okText',
  'tooltip',
  'subtitle',
  // 业务组件里带文案的自定义属性（按本仓库既有写法归纳）
  'text',
  'tip',
  'sub',
  'name',
  'heading',
  'desc',
  'rowTitle',
  'mountLabel',
  'rootLabel',
  'serverPlaceholder',
  'searchPlaceholder',
  'noSourcesHint',
  'successMessage',
  'errorMessage',
  'titleCN',
  'info',
  'browseLabel',
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
  // 网易云表情别名表：key 是评论里出现的 `[大笑]` 协议 token，不是界面文字
  /[\\/]utils[\\/]neteaseEmoji\.ts$/,
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
 * 是否正处在 `t()` 的**词条参数**位置（第一个实参）。
 *
 * 只有这个位置是 key、不该再包一层；第二个实参（插值对象）里的中文
 * 是「值」，仍然需要 t()——`t('{{label}}（点击{{next}}）', { label: TABLE[m].label })`
 * 里那个 label 不包就是永远的中文。
 */
function isInsideTKey(node) {
  const start = node.getStart()
  const end = node.getEnd()
  for (let cur = node.parent; cur; cur = cur.parent) {
    if (!ts.isCallExpression(cur)) continue
    const callee = cur.expression.getText()
    if (callee !== 't' && callee !== 'translate' && callee !== 'i18next.t') continue
    const first = cur.arguments[0]
    if (first && start >= first.getStart() && end <= first.getEnd()) return true
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

/** 表达式里（任意深度）是否含 JSX —— 含了就不能当插值合并 */
function containsJsx(node) {
  let found = false
  const walk = (n) => {
    if (found) return
    if (ts.isJsxElement(n) || ts.isJsxFragment(n) || ts.isJsxSelfClosingElement(n)) {
      found = true
      return
    }
    ts.forEachChild(n, walk)
  }
  walk(node)
  return found
}

/**
 * JSX 插值能否安全地并进 t() 的插值参数。
 *
 * `{creating && <Spinner/>}`、`{cond && 'x'}` 这类在 JSX 里「条件不成立就什么都不渲染」，
 * 硬并进句子会变成 "false 完成" 或 " 完成"，所以一律拒绝；
 * 只放行「一定是值」的表达式（标识符、属性链、调用、拼接、带字面量兜底的 ??/||）。
 */
function isSafeInterpolation(expr) {
  if (!expr || containsJsx(expr)) return false
  if (ts.isIdentifier(expr)) return true
  if (ts.isStringLiteral(expr) || ts.isNumericLiteral(expr)) return true
  if (ts.isNoSubstitutionTemplateLiteral(expr) || ts.isTemplateExpression(expr)) return true
  if (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) return true
  if (ts.isCallExpression(expr)) return true
  if (ts.isNonNullExpression(expr) || ts.isAsExpression(expr) || ts.isParenthesizedExpression(expr)) {
    return isSafeInterpolation(expr.expression)
  }
  if (ts.isPrefixUnaryExpression(expr)) return true
  if (ts.isConditionalExpression(expr)) {
    return isSafeInterpolation(expr.whenTrue) && isSafeInterpolation(expr.whenFalse)
  }
  if (ts.isBinaryExpression(expr)) {
    const kind = expr.operatorToken.kind
    if (kind === ts.SyntaxKind.PlusToken) {
      return isSafeInterpolation(expr.left) && isSafeInterpolation(expr.right)
    }
    // 兜底只认字面量：`a ?? 0`、`name || '未知'` 是值；`a || b` 可能给布尔
    if (kind === ts.SyntaxKind.BarBarToken || kind === ts.SyntaxKind.QuestionQuestionToken) {
      const right = expr.right
      const literalFallback =
        ts.isStringLiteral(right) ||
        ts.isNumericLiteral(right) ||
        ts.isNoSubstitutionTemplateLiteral(right) ||
        ts.isTemplateExpression(right)
      return literalFallback && isSafeInterpolation(expr.left)
    }
    return false
  }
  return false
}

/**
 * 给模板串里的一个插值表达式起一个 i18next 占位符名。
 *
 * 优先用标识符名字（`${count}` → `count`、`${stat.label}` → `label`），
 * 复杂表达式（`${-v}`、`${a.b()}`）统一叫 `value`，重名再补序号。
 */
function placeholderName(expr, used) {
  let base = 'value'
  if (ts.isIdentifier(expr)) base = expr.text
  else if (ts.isPropertyAccessExpression(expr)) base = expr.name.text
  base = base.replace(/[^A-Za-z0-9_]/g, '')
  if (!base) base = 'value'
  base = base.charAt(0).toLowerCase() + base.slice(1)
  let name = base
  let i = 2
  while (used.has(name)) {
    name = `${base}${i}`
    i += 1
  }
  used.add(name)
  return name
}

/** 模板串 → { key: '已复制 {{n}} 项', vars: [{name,expr,text}] } */
function templateToKey(node) {
  const used = new Set()
  let key = node.head.text
  const vars = []
  for (const span of node.templateSpans) {
    const expr = span.expression
    const name = placeholderName(expr, used)
    vars.push({ name, expr, text: expr.getText() })
    key += `{{${name}}}` + span.literal.text
  }
  return { key, vars }
}

/**
 * 从一个初始化表达式里挖出「属性名 → 中文原文」。
 *
 * 用于识别「中文标签表」：`const THEMES = [{ label: '白', value: 'light' }]`。
 */
function collectChineseProps(value, props = new Map()) {
  const walk = (node) => {
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property)) continue
        const key = property.name
          .getText()
          .replace(/^['"]/, '')
          .replace(/['"]$/, '')
        if (ts.isStringLiteral(property.initializer) && hasHan(property.initializer.text)) {
          if (!props.has(key)) props.set(key, property.initializer.text)
        } else {
          walk(property.initializer)
        }
      }
    } else if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) walk(element)
    }
  }
  walk(value)
  return props
}

/** 模块作用域的「中文标签表」：const 名 → { 属性名: 中文原文 } */
function moduleScopeTables(sourceFile) {
  const tables = new Map()
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue
      const props = collectChineseProps(declaration.initializer)
      if (props.size > 0) tables.set(declaration.name.text, props)
    }
  }
  return tables
}

function scriptKindOf(file) {
  return file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
}

/** `@/modules/music/x`、`../x` 这类说明符能不能对上某个真实文件 */
function specifierMatches(fromFile, specifier, targetFile) {
  const normalize = (p) => p.replace(/[\\/]/g, '/').replace(/\.tsx?$/, '')
  let expected = null
  if (specifier.startsWith('@/')) expected = path.join(SRC, specifier.slice(2))
  else if (specifier.startsWith('.')) expected = path.resolve(path.dirname(fromFile), specifier)
  else return false
  return normalize(targetFile) === normalize(expected)
}

/**
 * 本文件用到的中文标签表：本地定义的 + 从别处 import 进来的。
 *
 * 跨文件这一步是必需的——`MUSIC_LEVEL_OPTIONS` 定义在 store-settings.ts、
 * 渲染在 MusicSettingsPage.tsx，只看单文件会漏掉全部跨模块的表。
 */
function resolveTables(sourceFile, file, tableIndex) {
  const tables = moduleScopeTables(sourceFile)
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue
    const clause = statement.importClause
    const bindings = clause?.namedBindings
    if (!bindings || !ts.isNamedImports(bindings)) continue
    const specifier = statement.moduleSpecifier.text
    for (const element of bindings.elements) {
      const importedName = (element.propertyName ?? element.name).text
      const localName = element.name.text
      if (tables.has(localName)) continue
      const candidates = tableIndex.get(importedName)
      if (!candidates) continue
      const hit = candidates.find((candidate) => specifierMatches(file, specifier, candidate.file))
      if (hit) tables.set(localName, hit.props)
    }
  }
  return tables
}

function transformFile(file, tableIndex = new Map()) {
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

  /**
   * 字符串/模板串通用的「不该动」判定，返回跳过原因（null 表示可以替换）。
   *
   * 这些规则对模板串同样成立，所以抽出来共用，避免两处漂移。
   */
  const literalSkipReason = (node) => {
    // 模块加载时求值会定格语言，必须人工改成「存 key、渲染期 t()」
    if (inModuleScope(node)) return 'module-scope'
    const parent = node.parent
    if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return 'non-ui'
    if (parent.name === node) return 'non-ui' // 对象 key / 属性名
    if (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) return 'non-ui'
    // JSX 属性里只有白名单属性算文案（className/href 之类不碰）
    let attr = parent
    if (ts.isJsxExpression(attr)) attr = attr.parent
    if (ts.isJsxAttribute(attr) && !TEXT_ATTRS.has(attr.name.getText())) {
      return `jsx-attr:${attr.name.getText()}`
    }
    if (ts.isCaseClause(parent)) return 'switch-case'
    if (
      ts.isBinaryExpression(parent) &&
      ['===', '!==', '==', '!='].includes(parent.operatorToken.getText())
    ) {
      return 'comparison'
    }
    if (isInsideConsole(node)) return 'console'
    // 与后端返回的字符串做匹配（msg.includes('中文')）：这类是逻辑常量，翻译会直接坏掉
    if (
      ts.isCallExpression(parent) &&
      ts.isPropertyAccessExpression(parent.expression) &&
      ['includes', 'startsWith', 'endsWith', 'indexOf', 'lastIndexOf', 'match', 'split'].includes(
        parent.expression.name.getText()
      )
    ) {
      return 'string-match'
    }
    return null
  }

  /** 模板串 → t(...) 调用串；不该动时返回 null（顶层会记一条 skip）。 */
  const buildTemplate = (node, depth = 0) => {
    const { key, vars } = templateToKey(node)
    if (!hasHan(key)) return null
    if (looksLikeStylesheet(key)) {
      if (depth === 0) skip(node, 'stylesheet', key.slice(0, 60))
      return null
    }
    const reason = literalSkipReason(node)
    if (reason) {
      if (depth === 0) {
        addKey(key)
        skip(node, reason, key)
      }
      return null
    }
    addKey(key)
    const args = vars.map((v) => {
      const rendered = renderExpr(v.expr, depth)
      return rendered === v.name ? v.name : `${v.name}: ${rendered}`
    })
    const objectLiteral = args.length ? `, { ${args.join(', ')} }` : ''
    return `${callName}(${quote(key)}${objectLiteral})`
  }

  /**
   * 渲染一个插值表达式，顺带把里面嵌着的中文字面量也包成 t()。
   *
   * 没有这一步，`${directLink ? '直链' : '服务器中转'}` 这种「叶子文案」
   * 会跟着整个模板串一起被替换、但自己永远翻不到。
   */
  const renderExpr = (expr, depth) => {
    const base = expr.getStart(sourceFile)
    const inner = []
    const walk = (n) => {
      if (n !== expr) {
        if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
          const text = n.text
          if (hasHan(text) && !isInsideTKey(n)) {
            if (!literalSkipReason(n)) {
              addKey(text)
              inner.push({
                start: n.getStart(sourceFile) - base,
                end: n.getEnd() - base,
                text: `${callName}(${quote(text)})`,
              })
            }
            return
          }
        } else if (ts.isTemplateExpression(n) && depth < 3) {
          const nested = buildTemplate(n, depth + 1)
          if (nested) {
            inner.push({
              start: n.getStart(sourceFile) - base,
              end: n.getEnd() - base,
              text: nested,
            })
            return
          }
        }
      }
      ts.forEachChild(n, walk)
    }
    walk(expr)
    if (inner.length === 0) return expr.getText()
    let out = expr.getText()
    inner.sort((a, b) => b.start - a.start)
    for (const edit of inner) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end)
    return out
  }

  /**
   * JSX 多子节点能否整体合并成一个 t()。
   *
   * 只有「文本 + 表达式」混排、且没有嵌套元素时才成立：
   *   <span>已复制 {n} 项</span>  →  <span>{t('已复制 {{n}} 项', { n })}</span>
   * 带 `<strong>`/`<code>` 的句子要拆句或上 `<Trans>`，这里不动，交给人工。
   *
   * 返回 true 表示「这个元素已处理/已记录」，外面不要再往下递归，
   * 否则同一个元素的多个文本子节点会各提一次编辑、互相踩位置。
   */
  const flattenJsxChildren = (element) => {
    const children = element.children
    const meaningful = children.filter((child) => !(ts.isJsxText(child) && !child.text.trim()))
    if (meaningful.length < 2) return false
    let hasText = false
    for (const child of meaningful) {
      if (ts.isJsxText(child)) {
        if (hasHan(normalizeText(child.text))) hasText = true
        continue
      }
      if (!ts.isJsxExpression(child)) return false // 嵌套元素/自闭合：交给人工
      const expr = child.expression
      if (!expr) return false // {/* 注释 */}
      if (!isSafeInterpolation(expr)) return false
    }
    if (!hasText) return false

    // 拼 key：文本按 JSX 语义折叠空白，表达式变成 {{name}}
    const used = new Set()
    const vars = []
    let key = ''
    for (const child of children) {
      if (ts.isJsxText(child)) key += child.text.replace(/\s+/g, ' ')
      else if (ts.isJsxExpression(child) && child.expression) {
        const name = placeholderName(child.expression, used)
        vars.push({ name, expr: child.expression })
        key += `{{${name}}}`
      }
    }
    key = key.replace(/\s+/g, ' ').trim()
    if (!hasHan(key)) return false

    if (inModuleScope(element)) {
      addKey(key)
      skip(element, 'module-scope', key)
      return true
    }
    addKey(key)
    const args = vars.map((v) => {
      const rendered = renderExpr(v.expr, 0)
      return rendered === v.name ? v.name : `${v.name}: ${rendered}`
    })
    const objectLiteral = args.length ? `, { ${args.join(', ')} }` : ''
    addEdit(
      children[0].getStart(sourceFile),
      children[children.length - 1].getEnd(),
      `{${callName}(${quote(key)}${objectLiteral})}`
    )
    return true
  }

  /**
   * 本文件模块作用域里的「中文标签表」（含 import 进来的）：表名 → { 属性名: 中文原文 }。
   *
   * 这些表**不能**在定义处调 t()（会在模块加载时把语言定格），正确做法是
   * 存中文原文当 key、在渲染处 t()。所以这里先把表结构摸清楚，
   * 再在下面把读取点包成 t(X.label)。
   */
  const tableProps = resolveTables(sourceFile, file, tableIndex)
  if (process.env.I18N_DEBUG) {
    const local = moduleScopeTables(sourceFile)
    console.log(
      `[debug] ${path.relative(FRONTEND, file)} 表: ${[...tableProps.keys()].join(',') || '(无)'}` +
        ` 本地: ${[...local.keys()].join(',') || '(无)'}`
    )
  }

  /** 局部别名：`const spec = CHANNEL_SPECS[kind]` → spec 指向 CHANNEL_SPECS */
  const aliasToTable = new Map()
  const resolveTableName = (expr) => {
    if (!expr) return null
    if (ts.isIdentifier(expr)) {
      if (tableProps.has(expr.text)) return expr.text
      return aliasToTable.get(expr.text) ?? null
    }
    if (
      ts.isElementAccessExpression(expr) ||
      ts.isPropertyAccessExpression(expr) ||
      ts.isCallExpression(expr)
    ) {
      return resolveTableName(expr.expression)
    }
    if (
      ts.isParenthesizedExpression(expr) ||
      ts.isAsExpression(expr) ||
      ts.isNonNullExpression(expr)
    ) {
      return resolveTableName(expr.expression)
    }
    return null
  }

  const MAP_LIKE = new Set(['map', 'forEach', 'filter', 'find', 'findLast', 'some', 'every'])
  const bindAliases = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const table = resolveTableName(node.initializer)
      if (table) aliasToTable.set(node.name.text, table)
    }
    // TABLE.map((f) => …)：回调参数 f 指向 TABLE
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      MAP_LIKE.has(node.expression.name.getText())
    ) {
      const table = resolveTableName(node.expression.expression)
      if (table) {
        const callback = node.arguments[0]
        if (callback && ts.isArrowFunction(callback)) {
          for (const param of callback.parameters) {
            if (ts.isIdentifier(param.name)) aliasToTable.set(param.name.text, table)
          }
        }
      }
    }
    ts.forEachChild(node, bindAliases)
  }
  bindAliases(sourceFile)

  /** 把「读标签表」的地方包成 t(X.label)；返回 true 表示已经生成编辑 */
  const wrapMemberRead = (node) => {
    const prop = node.name.getText()
    const table = resolveTableName(node.expression)
    if (!table) return false
    const text = tableProps.get(table)?.get(prop)
    if (!text) return false
    if (inModuleScope(node)) return false
    if (isInsideTKey(node)) return false
    // `X?.label ?? t('全部')`：只包前半段会把兜底链切断，要连兜底一起包
    let target = node
    let cursor = node
    while (
      cursor.parent &&
      ts.isBinaryExpression(cursor.parent) &&
      ['??', '||'].includes(cursor.parent.operatorToken.getText()) &&
      cursor.parent.left === cursor
    ) {
      cursor = cursor.parent
      target = cursor
    }
    if (isInsideTKey(target)) return false
    addKey(text)
    addEdit(target.getStart(sourceFile), target.getEnd(), `${callName}(${target.getText()})`)
    return true
  }

  /** `<Trans i18nKey="...">` 的 key 不是字面量节点，单独登记；其 children 不再递归 */
  const isTransKey = (node) => {
    if (!ts.isJsxElement(node) && !ts.isJsxSelfClosingElement(node)) return false
    const opening = ts.isJsxElement(node) ? node.openingElement : node
    if (opening.tagName.getText() !== 'Trans') return false
    for (const attr of opening.attributes.properties) {
      if (!ts.isJsxAttribute(attr) || attr.name.getText() !== 'i18nKey') continue
      const init = attr.initializer
      if (init && ts.isStringLiteral(init) && hasHan(init.text)) addKey(init.text)
    }
    return true
  }

  const visit = (node) => {
    // 0) 读中文标签表的地方：spec.timeoutText → t(spec.timeoutText)
    if (ts.isPropertyAccessExpression(node) && wrapMemberRead(node)) return

    if (isTransKey(node)) return

    // 1) JSX 元素：先试「文本 + 表达式」整体合并成一个 t()
    if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
      if (flattenJsxChildren(node)) return
      ts.forEachChild(node, visit)
      return
    }

    // 2) JSX 文本节点：<div>中文</div>
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
      if (!ts.isJsxElement(parent) && !ts.isJsxFragment(parent)) return
      // 同一元素里有 **两个以上** 中文文本节点，说明一句话被子元素切开了
      // （`共 <strong>3</strong> 条`）：必须拆句或上 <Trans>，不自动动。
      const hanTexts = parent.children.filter(
        (child) => ts.isJsxText(child) && hasHan(normalizeText(child.text))
      )
      if (hanTexts.length > 1) {
        skip(node, 'jsx-multi-child', text)
        return
      }
      // 只包文本本身。兄弟节点是图标/表达式时句子依然完整，可以安全地只换这一段；
      // 同一行上的前后空格属于版面（`<b>x</b> 文字`），替换掉会把词粘在一起，要留在外面。
      const raw = node.text
      const leadRaw = raw.match(/^\s*/)[0]
      const trailRaw = raw.match(/\s*$/)[0]
      const lead = leadRaw && !leadRaw.includes('\n') ? ' ' : ''
      const trail = trailRaw && !trailRaw.includes('\n') ? ' ' : ''
      addKey(text)
      addEdit(
        node.getStart(sourceFile),
        node.getEnd(),
        `${lead}{${callName}(${quote(text)})}${trail}`
      )
      return
    }

    // 3) JSX 属性：title="中文"（白名单内才动）
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

    // 4) 普通字符串字面量（含无插值的模板串）
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const text = node.text
      if (!hasHan(text)) return
      if (looksLikeStylesheet(text)) {
        skip(node, 'stylesheet', text.slice(0, 60))
        return
      }
      if (isInsideTKey(node)) {
        addKey(text)
        return
      }
      const parent = node.parent
      if (ts.isJsxAttribute(parent)) {
        // 整个属性由上面分支处理（或已明确跳过）
        if (inModuleScope(node)) addKey(text)
        return
      }
      const reason = literalSkipReason(node)
      if (reason) {
        // 这些字面量本身是界面文案，只是不能自动替换：登记进词典保证清单完整
        addKey(text)
        skip(node, reason, text)
        return
      }
      addKey(text)
      addEdit(node.getStart(sourceFile), node.getEnd(), `${callName}(${quote(text)})`)
      return
    }

    // 5) 带插值的模板串：`已复制 ${n} 项` → t('已复制 {{n}} 项', { n })
    if (ts.isTemplateExpression(node)) {
      const replacement = buildTemplate(node)
      if (replacement === null) return
      addEdit(node.getStart(sourceFile), node.getEnd(), replacement)
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

/** 不需要、也不该自动替换的跳过原因（报告里单独列出，不算待办） */
const EXPECTED_SKIPS = new Set([
  // 标签表定义处：值就是 key，渲染期由 t() 包装，定义处包了反而会定格语言
  'module-scope',
  // 日志/控制台
  'console',
  // 内联样式表、超长字符串
  'stylesheet',
  // 与后端返回串、接口字段做比较的字面量：翻译了逻辑就坏
  'comparison',
  'string-match',
  'switch-case',
  // 不是界面文字（import 路径、对象 key 等）
  'non-ui',
])

function main() {
  const { scopes, write, check, report, dictOnly } = parseArgs(process.argv.slice(2))
  const targets = scopes.length > 0 ? scopes : ['src']
  // 词典是「全部文案的清单」：不论 --scope 限定到哪，key 一律全量扫描 src 收集；
  // 只有**落盘改代码**受 --scope 限制。否则按目录分批 --write 会把词典截成只剩该目录。
  const inScope = new Set()
  for (const target of targets) walkFiles(path.resolve(FRONTEND, target), []).forEach((f) => inScope.add(f))
  const files = []
  walkFiles(path.resolve(FRONTEND, 'src'), files)

  // 先建一份全局「中文标签表」索引：`表名 → [{ 所属文件, 属性 }]`。
  // 有了它，引用别的模块里的表（MUSIC_LEVEL_OPTIONS 之类）也能认出读取点。
  const tableIndex = new Map()
  for (const file of files) {
    const sf = ts.createSourceFile(
      file,
      fs.readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      scriptKindOf(file)
    )
    for (const [name, props] of moduleScopeTables(sf)) {
      if (!tableIndex.has(name)) tableIndex.set(name, [])
      tableIndex.get(name).push({ file, props })
    }
  }

  const allKeys = []
  const skipped = []
  let changedFiles = 0

  for (const file of files.sort()) {
    const result = transformFile(file, tableIndex)
    for (const key of result.keys) allKeys.push({ bucket: bucketOf(file), key })
    // 统计/报告只反映本次 scope（默认就是整个 src）
    if (inScope.has(file)) skipped.push(...result.skipped)
    if (!result.changed) continue
    if (!inScope.has(file)) continue
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
    const sorted = Object.entries(byReason).sort((a, b) => b[1] - a[1])
    const pending = sorted.filter(([reason]) => !EXPECTED_SKIPS.has(reason))
    const expected = sorted.filter(([reason]) => EXPECTED_SKIPS.has(reason))
    if (pending.length > 0) {
      console.log('需要人工处理的：')
      for (const [reason, count] of pending) console.log(`  ${reason}: ${count}`)
    }
    if (expected.length > 0) {
      console.log('按设计保留（不算待办）：')
      for (const [reason, count] of expected) console.log(`  ${reason}: ${count}`)
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
