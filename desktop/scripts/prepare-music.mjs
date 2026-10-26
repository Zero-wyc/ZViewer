// Install a pinned private music runtime, including the same Node used to build.
import { execFileSync } from 'node:child_process';
import { cpSync, copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
const source = fileURLToPath(new URL('../music-runtime/', import.meta.url));
const target = resolve(process.argv[2] || fileURLToPath(new URL('../../dist/win/ncm', import.meta.url)));
if (process.platform !== 'win32') throw new Error('Windows music runtime requires Windows Node');
execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm ci --omit=dev --ignore-scripts --no-audit --no-fund'], { cwd: source, stdio: 'inherit', windowsHide: true });
mkdirSync(target, { recursive: true });
copyFileSync(process.execPath, join(target, 'node.exe'));
for (const name of ['start.cjs', 'package.json', 'package-lock.json']) copyFileSync(join(source, name), join(target, name));
cpSync(join(source, 'node_modules'), join(target, 'node_modules'), { recursive: true });
const nodeLicense = resolve(process.execPath, '..', 'LICENSE');
if (existsSync(nodeLicense)) copyFileSync(nodeLicense, join(target, 'LICENSE-Node.txt'));
console.log('音乐运行组件已生成：' + target);
