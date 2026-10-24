#!/usr/bin/env node
/**
 * 极简 FTP 服务器（RFC 959 子集），专供 Go / Node 对拍。
 *
 * 覆盖：USER/PASS、FEAT、TYPE、STRU、OPTS、PWD、CWD、SIZE、MDTM、REST、
 *       PASV、EPSV、RETR、LIST / LIST -a、MLSD、QUIT。
 *
 * 两个刻意的「服务器怪癖」，用来验证客户端的回退链：
 *   1. /videos/nosize.mkv 的 SIZE 返回 550（模拟不支持 SIZE 的老服务器），
 *      客户端必须回退 CWD + LIST 才能 stat 成功；
 *   2. MLST=0 时不宣告 MLST 特性，客户端只能走 LIST -a / LIST，
 *      此时目录项没有可靠时间戳（Node 的 modifiedAt 是 undefined）。
 *
 * 用法：
 *   node mock-ftp.js <port> [--no-mlst] [--log=<path>]
 * 环境变量：FTP_LOG 指定命令日志（每行 `<命令> <参数>`），用于断言缓存命中。
 */

const net = require('net');
const fs = require('fs');

const port = Number(process.argv[2] || 2121);
const noMlst = process.argv.includes('--no-mlst');
const logArg = process.argv.find((a) => a.startsWith('--log='));
const logPath = logArg ? logArg.slice('--log='.length) : process.env.FTP_LOG || '';

if (logPath) {
  try {
    fs.writeFileSync(logPath, '');
  } catch {
    /* 忽略 */
  }
}
function logLine(line) {
  if (!logPath) return;
  try {
    fs.appendFileSync(logPath, line.replace(/\r?\n$/, '') + '\n');
  } catch {
    /* 忽略 */
  }
}

// ==================== 虚拟文件系统 ====================
// 内容按字节生成，保证两端拿到的字节完全一致。
function pattern(size) {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) buf[i] = i % 251;
  return buf;
}

const MTIME = '20240102030405'; // MLSD 事实里的 UTC 时间
const UNIX_DATE = 'Jan 02 03:04';

/**
 * 路径 -> { type, size, buf }
 * 目录的 size 只是占位（LIST 里显示 0）。
 */
const files = new Map();
function addFile(path, size, extra = {}) {
  files.set(path, { type: 'file', size, buf: extra.onlySize ? null : pattern(size), ...extra });
}
function addDir(path) {
  files.set(path, { type: 'dir' });
}

addDir('/');
addDir('/videos');
addDir('/videos/sub');
addFile('/videos/a.mkv', 1024 * 1024);
addFile('/videos/中文 名.mp4', 300 * 1024);
addFile('/videos/sub.srt', 512);
addFile('/videos/empty.txt', 0);
addFile('/videos/nosize.mkv', 4096, { noSize: true });
addFile('/videos/sub/b.mkv', 2048);
addFile('/readme.txt', 64);

function children(dir) {
  const prefix = dir.endsWith('/') ? dir : dir + '/';
  const out = [];
  for (const [path, entry] of files) {
    if (!path.startsWith(prefix) || path === dir) continue;
    const rest = path.slice(prefix.length);
    if (rest.includes('/')) continue;
    out.push({ name: rest, path, ...entry });
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

function lookup(path) {
  // 去掉结尾斜杠（根目录除外）
  let normalized = path;
  while (normalized.length > 1 && normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  return files.get(normalized) || null;
}

function mlsdLines(dir) {
  const lines = ['type=cdir;modify=' + MTIME + '; .'];
  for (const entry of children(dir)) {
    const facts = [entry.type === 'dir' ? 'type=dir' : 'type=file'];
    if (entry.type === 'file') facts.push('size=' + entry.size);
    facts.push('modify=' + MTIME);
    facts.push('perm=' + (entry.type === 'dir' ? 'flcdmpe' : 'r'));
    lines.push(facts.join(';') + '; ' + entry.name);
  }
  return lines;
}

function unixLines(dir) {
  return children(dir).map((entry) => {
    const mode = entry.type === 'dir' ? 'drwxr-xr-x' : '-rw-r--r--';
    const size = entry.type === 'dir' ? 0 : entry.size;
    return `${mode}    1 ftp      ftp      ${String(size).padStart(8, ' ')} ${UNIX_DATE} ${entry.name}`;
  });
}

// ==================== 连接处理 ====================
const CREDENTIALS = [
  { user: 'ftp-user', pass: 'ftp-secret' },
  { user: 'anonymous', pass: 'anonymous@' },
];

const server = net.createServer((socket) => {
  socket.setEncoding('latin1');
  let buffer = '';
  let cwd = '/';
  let authenticated = false;
  let user = '';
  let restOffset = 0;
  /** 当前 PASV/EPSV 监听器与其上已建立的数据连接 */
  let dataServer = null;
  let dataSocket = null;

  const send = (line) => socket.write(line + '\r\n');

  function closeDataServer() {
    if (dataServer) {
      try {
        dataServer.close();
      } catch {
        /* 忽略 */
      }
      dataServer = null;
    }
    if (dataSocket) {
      try {
        dataSocket.destroy();
      } catch {
        /* 忽略 */
      }
      dataSocket = null;
    }
  }

  function openDataServer(cb) {
    closeDataServer();
    const ds = net.createServer((conn) => {
      dataSocket = conn;
      conn.on('error', () => {});
    });
    ds.listen(0, '127.0.0.1', () => {
      dataServer = ds;
      cb(ds.address().port);
    });
    ds.on('error', () => {});
  }

  function waitDataSocket(cb, tries = 0) {
    if (dataSocket) {
      cb(dataSocket);
      return;
    }
    if (tries > 100) {
      cb(null);
      return;
    }
    setTimeout(() => waitDataSocket(cb, tries + 1), 10);
  }

  function transfer(payload, done) {
    waitDataSocket((conn) => {
      if (!conn) {
        send('425 Can not open data connection');
        return;
      }
      conn.end(payload, () => {
        send('226 Transfer complete');
        closeDataServer();
        if (done) done();
      });
    });
  }

  function sizeOf(path) {
    const entry = lookup(path);
    if (!entry || entry.type !== 'file' || entry.noSize) return null;
    return entry.size;
  }

  send('220 ZViewer mock FTP ready');

  socket.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\r\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      handle(line);
    }
  });
  socket.on('error', () => {});

  function handle(line) {
    const space = line.indexOf(' ');
    const command = (space < 0 ? line : line.slice(0, space)).toUpperCase();
    const arg = space < 0 ? '' : line.slice(space + 1);
    logLine(command + (arg ? ' ' + arg : ''));

    switch (command) {
      case 'USER':
        user = arg;
        send('331 Password required');
        return;
      case 'PASS': {
        const ok = CREDENTIALS.some((c) => c.user === user && c.pass === arg);
        authenticated = ok;
        send(ok ? '230 Logged in' : '530 Login incorrect.');
        return;
      }
      case 'FEAT': {
        if (noMlst) {
          send('211-Features:');
          send(' SIZE');
          send(' MDTM');
          send(' REST STREAM');
          send('211 End');
          return;
        }
        send('211-Features:');
        send(' MLST type*;size*;modify*;');
        send(' SIZE');
        send(' MDTM');
        send(' REST STREAM');
        send('211 End');
        return;
      }
      case 'OPTS':
      case 'TYPE':
      case 'STRU':
      case 'PBSZ':
      case 'PROT':
        send('200 OK');
        return;
      case 'PWD':
        send('257 "' + cwd + '" is the current directory');
        return;
      case 'CWD': {
        const entry = lookup(arg.startsWith('/') ? arg : cwd + '/' + arg);
        if (!entry || entry.type !== 'dir') {
          send('550 Failed to change directory');
          return;
        }
        cwd = arg.startsWith('/') ? arg : cwd + '/' + arg;
        if (cwd.length > 1) cwd = cwd.replace(/\/+$/, '');
        send('250 Directory changed');
        return;
      }
      case 'SIZE': {
        if (!authenticated) {
          send('530 Not logged in');
          return;
        }
        const target = arg.startsWith('/') ? arg : cwd + '/' + arg;
        const size = sizeOf(target);
        if (size === null) {
          send('550 SIZE not supported for this file');
          return;
        }
        send('213 ' + size);
        return;
      }
      case 'MDTM': {
        const target = arg.startsWith('/') ? arg : cwd + '/' + arg;
        const entry = lookup(target);
        if (!entry) {
          send('550 No such file');
          return;
        }
        send('213 ' + MTIME + '.000');
        return;
      }
      case 'REST': {
        const value = Number(arg);
        restOffset = Number.isFinite(value) && value >= 0 ? value : 0;
        send('350 Restarting at ' + restOffset);
        return;
      }
      case 'PASV': {
        openDataServer((dataPort) => {
          const high = dataPort >> 8;
          const low = dataPort & 255;
          send(`227 Entering Passive Mode (127,0,0,1,${high},${low})`);
        });
        return;
      }
      case 'EPSV': {
        openDataServer((dataPort) => {
          send('229 Entering Extended Passive Mode (|||' + dataPort + '|)');
        });
        return;
      }
      case 'RETR': {
        const target = arg.startsWith('/') ? arg : cwd + '/' + arg;
        const entry = lookup(target);
        if (!entry || entry.type !== 'file') {
          closeDataServer();
          send('550 No such file');
          return;
        }
        const offset = restOffset;
        restOffset = 0;
        send('150 Opening BINARY mode data connection');
        const payload = entry.buf ? entry.buf.slice(offset) : Buffer.alloc(Math.max(0, entry.size - offset));
        transfer(payload);
        return;
      }
      case 'LIST':
      case 'MLSD': {
        // LIST 允许带参数（如 -a），也允许带路径；这里只按 cwd 处理
        let dir = cwd;
        const target = arg && !arg.startsWith('-') ? arg : '';
        if (target) {
          const entry = lookup(target.startsWith('/') ? target : cwd + '/' + target);
          if (entry && entry.type === 'dir') dir = target.startsWith('/') ? target : cwd + '/' + target;
        }
        if (command === 'MLSD' && noMlst) {
          closeDataServer();
          send('502 Command not implemented');
          return;
        }
        send('150 Here comes the directory listing');
        const lines = command === 'MLSD' ? mlsdLines(dir) : unixLines(dir);
        // 真实服务器用 CRLF，且末尾带换行
        transfer(Buffer.from(lines.join('\r\n') + '\r\n', 'utf8'));
        return;
      }
      case 'QUIT':
        send('221 Bye');
        closeDataServer();
        socket.end();
        return;
      default:
        send('502 Command not implemented');
    }
  }
});

server.listen(port, '127.0.0.1', () => {
  // 与 mock-alist 一致：输出一个可被脚本锚定的启动行
  process.stdout.write(`mock ftp listening on 127.0.0.1:${port}${noMlst ? ' (LIST only)' : ''}\n`);
});
