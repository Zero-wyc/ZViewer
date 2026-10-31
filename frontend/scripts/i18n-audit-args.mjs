/**
 * 审计 `t('…{{x}}…', { x })` 里的插值实参是否也被翻译了。
 *
 * 第一实参是 key（中文原文），第二实参里的值**同样要翻**——否则英文界面会
 * 出现「User wants to 暂停」这种半中半英。自动 codemod 只处理字面量，
 * 引用常量表（CONTROL_ACTION_TEXT[action]、META[..].label 之类）的地方要
 * 人工补 t()，这个脚本负责把它们列出来。
 *
 * 数据值（用户名、码率、分辨率…）不该翻，所以这里只看「引用了含中文的
 * 模块级常量表」的实参，不报普通变量与属性访问。
 *
 *   node scripts/i18n-audit-args.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const ROOT = path.resolve(import.meta.dirname, '../src')
const SKIP = [/[\\/]i18n[\\/]locales[\\/]/, /[\\/]__tests__[\\/]/, /[\\/]lib[\\/]mkv[\\/]/]
const HAN = /[\u4e00-\u9fa5]/

const files = []
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else if (/\.tsx?$/.test(entry.name) && !SKIP.some((re) => re.test(full))) files.push(full)
  }
}
walk(ROOT)

const isT = (node) =>
  ts.isCallExpression(node) && ['t', 'translate'].includes(node.expression.getText())

/** 值是否已经翻译过 / 本身是代码而非文案 */
function safe(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return true
  if (ts.isNumericLiteral(node) || node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) return true
  if (isT(node)) return true
  if (ts.isTemplateExpression(node)) return node.templateSpans.every((span) => safe(span.expression))
  if (ts.isConditionalExpression(node)) return safe(node.whenTrue) && safe(node.whenFalse)
  if (ts.isBinaryExpression(node)) return safe(node.left) && safe(node.right)
  if (ts.isParenthesizedExpression(node)) return safe(node.expression)
  return false
}

/** 子树里有没有中文字符串字面量 */
function hasHanLiteral(node) {
  let found = false
  const visit = (n) => {
    if (found) return
    if (ts.isStringLiteral(n) && HAN.test(n.text)) {
      found = true
      return
    }
    ts.forEachChild(n, visit)
  }
  visit(node)
  return found
}

const sources = new Map()
for (const file of files) {
  sources.set(
    file,
    ts.createSourceFile(
      file,
      fs.readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    )
  )
}

// 第一遍：模块作用域里「值含中文」的常量名（对象 / 数组 / 字符串都算）
const chineseConsts = new Map()
for (const [file, sourceFile] of sources) {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue
      if (hasHanLiteral(declaration.initializer)) {
        const names = chineseConsts.get(file) ?? new Set()
        names.add(declaration.name.text)
        chineseConsts.set(file, names)
      }
    }
  }
}

const findings = []
for (const [file, sourceFile] of sources) {
  const local = chineseConsts.get(file) ?? new Set()
  const visit = (node) => {
    if (ts.isCallExpression(node) && isT(node) && node.arguments.length >= 2) {
      const key = node.arguments[0]
      const vars = node.arguments[1]
      if (ts.isStringLiteral(key) && ts.isObjectLiteralExpression(vars)) {
        for (const property of vars.properties) {
          if (!ts.isPropertyAssignment(property)) continue
          if (safe(property.initializer)) continue
          const text = property.initializer.getText()
          const hit = [...local].find((name) => new RegExp(`\\b${name}\\b`).test(text))
          if (!hit) continue
          const line = sourceFile.getLineAndCharacterOfPosition(property.getStart(sourceFile)).line + 1
          findings.push({
            file: path.relative(ROOT, file).replace(/\\/g, '/'),
            line,
            key: key.text,
            expr: text,
            table: hit,
          })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
}

if (findings.length === 0) {
  console.log('引用中文常量表的插值实参都包了 t()')
} else {
  console.log(`引用了中文常量表但没包 t() 的插值实参 ${findings.length} 处：`)
  for (const item of findings) {
    console.log(`  ${item.file}:${item.line}  ${item.expr}  ← ${item.table}`)
    console.log(`    key: ${item.key}`)
  }
}
