export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return '未知错误';
}

const UNITS = ['B', 'KB', 'MB', 'GB'];

export function formatBytes(bytes?: number): string {
  if (!bytes || bytes < 0) return '—';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${UNITS[unit]}`;
}

/** 网易给的是毫秒 */
export function formatDuration(ms?: number): string {
  if (!ms || ms < 0) return '—';
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** /Users/xxx/Music/luoyun → ~/Music/luoyun，路径栏窄，省下来的字都是正文 */
export function tildify(filePath: string, home?: string): string {
  if (!home || !filePath.startsWith(home)) return filePath;
  return `~${filePath.slice(home.length)}`;
}

export function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

