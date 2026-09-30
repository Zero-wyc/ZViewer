/**
 * sql.js 数据库持久化保护层。
 *
 * 背景：TypeORM sqljs 驱动的默认持久化是 `fs.promises.writeFile` 整文件
 * 非原子覆盖（SqljsDriver.save）。Windows 上写入窗口内进程终止（Ctrl+C、
 * --kill-others、崩溃）会留下 truncate 后未写入的全零文件，加载时报
 * 「file is not a database」。本项目已发生两次（2026-08-26、2026-09-30，
 * 后者导致 9/5 之后的增量数据丢失）。
 *
 * 本模块提供三层保护：
 *
 * 1. **原子写回**（autoSaveCallback）：写 `${DATABASE_PATH}.tmp` 后
 *    rename 覆盖目标文件，任何时刻磁盘上的 dev.sqlite 都是完整的旧版
 *    或完整的新版，不再有中间态。
 * 2. **启动滚动备份**（ensureDatabaseFile）：每次启动时若库文件头部
 *    合法，复制一份到 `config/db-backups/`，保留最近 MAX_BACKUPS 份。
 *    即使写回再损坏，损失也被限制在两次启动之间。
 * 3. **启动自愈**（ensureDatabaseFile）：库文件头部非法时，把坏件改名
 *    保留（dev.sqlite.corrupt-{ts}），自动用最近一份头部合法的备份
 *    （db-backups/ → 旧命名 dev.sqlite.bak-*）恢复，保证服务能起来。
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR, DATABASE_PATH } from './paths';

/** SQLite 文件头 16 字节 magic。 */
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'ascii');

/** 滚动备份目录与保留份数。 */
const BACKUP_DIR = path.join(CONFIG_DIR, 'db-backups');
const MAX_BACKUPS = 10;

/** sql.js export 的最小合法长度（空库也有 4KB+，短于此视为异常拒绝写盘）。 */
const MIN_DB_BYTES = 4096;

/** 检查文件是否以合法 SQLite magic 开头。 */
function hasValidSqliteHeader(filePath: string): boolean {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const head = Buffer.alloc(SQLITE_MAGIC.length);
      const read = fs.readSync(fd, head, 0, head.length, 0);
      return read === head.length && head.equals(SQLITE_MAGIC);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

/** 时间戳（文件名安全格式）。 */
function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 在候选目录中找最近一份头部合法的数据库备份。
 *
 * 搜索顺序：config/db-backups/*.sqlite（新→旧）→ config/dev.sqlite.bak-*
 * （旧命名，历史手工备份）。头部非法的备份跳过。
 */
function findLatestGoodBackup(): string | null {
  const candidates: { file: string; mtime: number }[] = [];
  try {
    for (const name of fs.readdirSync(BACKUP_DIR)) {
      if (!name.endsWith('.sqlite')) continue;
      const file = path.join(BACKUP_DIR, name);
      const st = fs.statSync(file);
      if (!st.isFile()) continue;
      candidates.push({ file, mtime: st.mtimeMs });
    }
  } catch {
    /* db-backups 不存在 */
  }
  try {
    for (const name of fs.readdirSync(CONFIG_DIR)) {
      if (!name.startsWith('dev.sqlite.bak-')) continue;
      const file = path.join(CONFIG_DIR, name);
      const st = fs.statSync(file);
      if (!st.isFile()) continue;
      candidates.push({ file, mtime: st.mtimeMs });
    }
  } catch {
    /* ignore */
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates.find((c) => hasValidSqliteHeader(c.file))?.file ?? null;
}

/**
 * 启动时滚动备份 + 损坏自愈。必须在 AppDataSource.initialize() 之前调用。
 *
 * 返回一段描述本次动作的日志（由调用方打印），便于在启动横幅中呈现。
 */
export function ensureDatabaseFile(): void {
  if (!fs.existsSync(DATABASE_PATH)) {
    console.log('[db-persistence] 数据库文件不存在，将创建全新数据库');
    return;
  }

  if (hasValidSqliteHeader(DATABASE_PATH)) {
    // 头部合法：滚动备份
    try {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
      const backupPath = path.join(BACKUP_DIR, `dev-${stamp()}.sqlite`);
      fs.copyFileSync(DATABASE_PATH, backupPath);
      // 只统计本模块产出的滚动备份（dev-*.sqlite），不清理旧命名手工备份
      const rolling = fs
        .readdirSync(BACKUP_DIR)
        .filter((n) => /^dev-\d{8}-\d{6}\.sqlite$/.test(n))
        .sort()
        .reverse();
      for (const stale of rolling.slice(MAX_BACKUPS)) {
        fs.unlinkSync(path.join(BACKUP_DIR, stale));
      }
      console.log(`[db-persistence] 已创建启动备份: ${backupPath}`);
    } catch (err) {
      console.error('[db-persistence] 滚动备份失败（不影响启动）:', err);
    }
    return;
  }

  // 头部非法：坏件改名保留，尝试自愈
  const corruptPath = `${DATABASE_PATH}.corrupt-${stamp()}`;
  try {
    fs.renameSync(DATABASE_PATH, corruptPath);
  } catch (err) {
    console.error('[db-persistence] 坏件改名失败，放弃自愈:', err);
    return;
  }
  console.error(
    `[db-persistence] ⚠️ 数据库文件头部非法（疑似非原子写回时进程终止导致全零/截断），\n` +
      `  坏件已保留: ${corruptPath}`
  );

  const backup = findLatestGoodBackup();
  if (backup) {
    fs.copyFileSync(backup, DATABASE_PATH);
    console.error(
      `[db-persistence] 已自动从最近的好备份恢复: ${backup}\n` +
        `  自上次备份以来的增量数据无法找回；坏件如需人工抢救可用 SQLite 工具尝试。`
    );
  } else {
    console.error(
      '[db-persistence] 未找到可用的历史备份，将以全新数据库启动。'
    );
  }
}

let saving = false;

/**
 * 原子写回（供 DataSource 的 autoSaveCallback 使用）。
 *
 * 写临时文件后 rename 覆盖目标；任何异常只记日志不上抛——单次保存
 * 失败不应打断业务查询，下一笔写入会再次触发 autoSave。
 */
export async function atomicSaveDatabase(db: Uint8Array): Promise<void> {
  if (saving) return; // 上一笔尚未落盘：跳过，后续 autoSave 会再触发
  saving = true;
  try {
    if (!db || db.length < MIN_DB_BYTES) {
      console.error(
        `[db-persistence] 拒绝写盘：export 长度异常（${db?.length ?? 0} 字节）`
      );
      return;
    }
    const tmpPath = `${DATABASE_PATH}.tmp`;
    await fs.promises.writeFile(tmpPath, Buffer.from(db));
    await fs.promises.rename(tmpPath, DATABASE_PATH);
  } catch (err) {
    console.error('[db-persistence] 原子写回失败:', err);
  } finally {
    saving = false;
  }
}
