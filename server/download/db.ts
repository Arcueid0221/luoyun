import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { DownloadPart, Quality } from '../core/types.ts';
import { verbose } from '../core/logger.ts';

const DB_DIR = path.join(os.homedir(), '.config', 'luoyun');
const DB_FILE = path.join(DB_DIR, 'downloads.db');

export interface DownloadRecord {
  trackId: string;
  /**
   * 判重位置：**歌单目录**（`playlistDirPath()` 的结果），不是用户选的根目录。
   *
   * 用根目录做 key 是错的：同一首歌出现在两个歌单里时，第二个歌单会因为
   * 第一个歌单的目录还在磁盘上而被判成"已下过"，于是那首歌在第二个歌单里
   * 永远缺席。按歌单目录记，两份各下一次 —— 这正是"每个歌单是一份自洽的备份"
   * 想要的行为。
   */
  destDir: string;
  parts: DownloadPart[];
  quality: Quality;
  /** 实际落盘目录（歌单目录下的那个歌曲子目录），用于存在性校验 */
  fileDir: string;
  bytes?: number;
}

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  fs.mkdirSync(DB_DIR, { recursive: true, mode: 0o700 });
  db = new DatabaseSync(DB_FILE);
  // 库里躺着"下过哪些歌、落在哪个目录"，不是密钥但也没必要给同机器的别人看
  try {
    fs.chmodSync(DB_FILE, 0o600);
  } catch {
    /* 属主不同时可能失败，不致命 */
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS downloads (
      track_id TEXT    NOT NULL,
      dest_dir TEXT    NOT NULL, -- 歌单目录，不是根目录；见 DownloadRecord.destDir
      parts    TEXT    NOT NULL,
      quality  TEXT    NOT NULL,
      file_dir TEXT    NOT NULL,
      bytes    INTEGER,
      done_at  INTEGER NOT NULL,
      PRIMARY KEY (track_id, dest_dir)
    );
  `);
  verbose(`幂等库 ${DB_FILE}`);
  return db;
}

function encodeParts(parts: DownloadPart[]): string {
  return [...new Set(parts)].sort().join(',');
}

function decodeParts(s: string): Set<string> {
  return new Set(s.split(',').filter(Boolean));
}

interface Row {
  parts: string;
  quality: string;
  file_dir: string;
}

/**
 * 三个条件全满足才算已完成，少一个都会让用户拿不到文件：
 *   1. 有记录且 quality 相同
 *   2. 记录里的 parts 是本次请求 parts 的超集（上次只下音频，这次要歌词，得补）
 *   3. file_dir 真的还在磁盘上（用户手动删了就该重下）
 */
export function isDone(
  trackId: string,
  destDir: string,
  parts: DownloadPart[],
  quality: Quality,
): boolean {
  const row = getDb()
    .prepare('SELECT parts, quality, file_dir FROM downloads WHERE track_id = ? AND dest_dir = ?')
    .get(trackId, destDir) as Row | undefined;

  if (!row) return false;
  if (row.quality !== quality) return false;

  const have = decodeParts(row.parts);
  for (const p of parts) {
    if (!have.has(p)) return false;
  }

  return fs.existsSync(row.file_dir);
}

export function markDone(rec: DownloadRecord): void {
  // parts 取并集：这次只补了歌词，也不能把上次的音频记录抹掉
  const existing = getDb()
    .prepare('SELECT parts, quality FROM downloads WHERE track_id = ? AND dest_dir = ?')
    .get(rec.trackId, rec.destDir) as Row | undefined;

  const merged =
    existing && existing.quality === rec.quality
      ? [...new Set([...decodeParts(existing.parts), ...rec.parts])]
      : [...rec.parts];

  getDb()
    .prepare(
      `INSERT OR REPLACE INTO downloads
       (track_id, dest_dir, parts, quality, file_dir, bytes, done_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      rec.trackId,
      rec.destDir,
      encodeParts(merged as DownloadPart[]),
      rec.quality,
      rec.fileDir,
      rec.bytes ?? 0,
      Date.now(),
    );
}

/** 给"重试这一首"用。destDir 同样是歌单目录 */
export function forget(trackId: string, destDir: string): void {
  getDb().prepare('DELETE FROM downloads WHERE track_id = ? AND dest_dir = ?').run(trackId, destDir);
}

/**
 * 给"整个目录全部重下"用（`POST /api/download/forget`）。
 *
 * 记录按歌单目录存，但页面传过来的是用户选的**根**目录，所以这里必须连
 * 子目录一起清，否则"忘记这个目录"会漏掉根目录下所有歌单。
 * 用 `instr(x, prefix) = 1` 做前缀匹配而不是 `LIKE`：目录名里的 `%` 和 `_`
 * 在 LIKE 里是通配符，转义比换个函数麻烦。
 */
export function forgetDir(destDir: string): void {
  const prefix = destDir.endsWith(path.sep) ? destDir : destDir + path.sep;
  getDb()
    .prepare('DELETE FROM downloads WHERE dest_dir = ? OR instr(dest_dir, ?) = 1')
    .run(destDir, prefix);
}
