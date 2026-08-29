import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Track } from '../core/types.ts';

// Windows 保留名。就算只在 macOS 用，产物也可能被同步到别处。
const RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/** 去掉 ASCII 控制字符（含 NUL 和 DEL）。写成过滤而不是正则字符类，源码里就不用出现控制字符本身 */
function stripControlChars(s: string): string {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (code > 0x1f && code !== 0x7f) out += ch;
  }
  return out;
}

/**
 * 把任意歌名/歌手名变成安全的目录名。
 * 每一条规则都对应一个真实会炸的场景，别删。
 */
export function sanitizeName(name: string, maxLen = 80): string {
  let s = name ?? '';

  // 中文歌名里的斜杠很常见（"爱/恨"），不换掉 mkdir 直接失败
  s = s.replace(/[/\\:*?"<>|]/g, '_');
  s = stripControlChars(s);
  // 折叠连续空白
  s = s.replace(/\s+/g, ' ').trim();
  // 开头的点会变成隐藏目录
  s = s.replace(/^\.+/, '');

  // 按码点截断，不能用 slice —— 那会把中文/emoji 切成半个代理对
  const points = [...s];
  if (points.length > maxLen) s = points.slice(0, maxLen).join('');

  // 截断可能又造出结尾空格，所以放在截断之后。
  // macOS 能创建结尾带空格或点的目录，但 Finder 显示异常，
  // 同步到 Windows / exFAT 会直接报错。
  s = s.replace(/[ .]+$/, '');

  if (!s) return 'unknown';
  if (RESERVED.has(s.toUpperCase())) return `_${s}`;
  return s;
}

/** 多歌手用 ", " 连接。周杰伦 / 费玉清 这种合唱很常见 */
export function artistLabel(track: Track): string {
  const names = track.artists.map((a) => a.name).filter(Boolean);
  return names.length ? names.join(', ') : '未知歌手';
}

/**
 * "01 晴天 - 周杰伦"。序号宽度按歌单总数定，
 * 100 首以上用 3 位，否则文件管理器里排序会乱（10 排在 2 前面）。
 */
export function trackDirName(index: number, track: Track, total = 99): string {
  const width = Math.max(2, String(Math.max(total, 1)).length);
  const prefix = String(index).padStart(width, '0');
  return sanitizeName(`${prefix} ${track.name} - ${artistLabel(track)}`);
}

/**
 * 目标目录已存在时的处理：只有 `info.json` 明确写着**另一首歌**才让路（追加 " (2)"），
 * 其余情况一律复用。
 *
 * 判断方向很关键。写成"证明是同一首才复用"会出事 —— `info.json` 只有勾了"简介"
 * 才会写，先下音频、事后补歌词的正常流程会被拆成 `xxx` 和 `xxx (2)` 两个目录，
 * 而幂等库只记得住最后那个，结果 audio 和 lyric 各躺一半、还都算"已下过"。
 * 反方向是安全的：目录名带歌单内的序号前缀，同一个歌单里两首不同的歌算不出同名。
 */
export function uniqueDir(parent: string, name: string, trackId?: string): string {
  const first = path.join(parent, name);
  if (!fs.existsSync(first)) return first;
  if (!isOtherTrack(first, trackId)) return first;

  for (let n = 2; n < 100; n++) {
    const candidate = path.join(parent, `${name} (${n})`);
    if (!fs.existsSync(candidate)) return candidate;
    if (!isOtherTrack(candidate, trackId)) return candidate;
  }
  // 一百个同名目录，不至于。兜底直接用第一个
  return first;
}

/** 有确凿证据说明这个目录属于别的歌才 true；没证据（没 info.json、读不了、坏了）一律不算 */
function isOtherTrack(dir: string, trackId?: string): boolean {
  if (!trackId) return false;
  try {
    const infoPath = path.join(dir, 'info.json');
    if (!fs.existsSync(infoPath)) return false;
    const info = JSON.parse(fs.readFileSync(infoPath, 'utf-8')) as { track?: { id?: string } };
    const found = info.track?.id;
    return !!found && found !== trackId;
  } catch {
    return false;
  }
}

/**
 * 歌单目录：`<destDir>/<清洗过的歌单名>`。
 *
 * 幂等库拿它当 key（"这首歌在这个位置已经齐了"），流水线拿它当落盘父目录，
 * `POST /api/download` 的 force 分支拿它清记录 —— 三处必须算出同一个字符串，
 * 所以只能有这一个实现。
 */
export function playlistDirPath(destDir: string, playlistName: string): string {
  return path.join(destDir, sanitizeName(playlistName, 120));
}

/** 网易的 type 字段就是扩展名，但兜底还是从 url 里猜一次 */
export function audioExt(type?: string, url?: string): string {
  const t = type?.trim().toLowerCase();
  if (t && /^[a-z0-9]{2,5}$/.test(t)) return t;
  if (url) {
    const m = url.split('?')[0].match(/\.([a-z0-9]{2,5})$/i);
    if (m) return m[1].toLowerCase();
  }
  return 'mp3';
}
