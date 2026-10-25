#!/usr/bin/env node
/**
 * 把 Node 侧的更新脚本模板原样导出到 Go 侧（`internal/updater/templates/`）。
 *
 * 为什么不让 Go 手抄一份文本：TS 模板字面量里的 `\` + 换行是 LineContinuation，
 * 编译后反斜杠与换行**都不存在**（bat 里的 PowerShell 续行因此拼成了一行）。
 * 手抄一定会抄成「看着像」但字节不同的版本，而这两个脚本会原样写进用户目录
 * 并被 cmd/bash 执行，差一个字符就是一个语法错误。
 *
 * 导出后由 Go 用 go:embed 读入，占位符渲染逻辑在 Go 侧重写。
 *
 * 用法：node backend-go/scripts/dump-updater-templates.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT, 'backend-go', 'internal', 'updater', 'templates');

/** 导出清单：Go 常量名 -> 文件名 */
const FILES = {
  APPLY_UPDATE_SH_TEMPLATE: 'apply-update.sh.tmpl',
  APPLY_UPDATE_BAT_TEMPLATE: 'apply-update.bat.tmpl',
  SH_STOP_DOCKER: 'sh-stop-docker.tmpl',
  SH_APPLY_DOCKER: 'sh-apply-docker.tmpl',
  SH_FINISH_DOCKER: 'sh-finish-docker.tmpl',
  SH_STOP_LINUX: 'sh-stop-linux.tmpl',
  SH_APPLY_LINUX: 'sh-apply-linux.tmpl',
  SH_FINISH_LINUX: 'sh-finish-linux.tmpl',
};

function main() {
  // ts-node 注册后才能 require TS 源码。
  require('ts-node').register({
    transpileOnly: true,
    compilerOptions: { module: 'commonjs' },
  });
  const templates = require(path.join(
    ROOT, 'backend', 'src', 'services', 'updater', 'script-templates.ts',
  ));

  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const [key, filename] of Object.entries(FILES)) {
    const value = templates[key];
    if (typeof value !== 'string') {
      throw new Error(`模板缺失或不是字符串: ${key}`);
    }
    // shell 脚本对 CR 零容忍，统一钉成 LF（.gitattributes 里也钉了）。
    const normalized = value.replace(/\r\n/g, '\n');
    fs.writeFileSync(path.join(OUT_DIR, filename), normalized, 'utf8');
    console.log(`  ${filename}: ${normalized.length} 字符`);
  }
  console.log(`已写入 ${path.relative(ROOT, OUT_DIR)}`);
}

main();
