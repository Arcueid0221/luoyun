import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { CookieData } from './types.ts';
import { verbose, warn } from './logger.ts';

// neteasecli 支持多 profile，落云是单用户桌面工具，只留一份。
const CONFIG_DIR = path.join(os.homedir(), '.config', 'luoyun');
const SESSION_FILE = path.join(CONFIG_DIR, 'session.json');

interface SessionFile {
  cookies: CookieData;
  /** 'manual' | 'chrome' | 'safari' | ... 只用于 UI 显示 */
  source?: string;
  savedAt?: number;
}

function readSession(): SessionFile | null {
  if (!fs.existsSync(SESSION_FILE)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8')) as unknown;
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;
    // 兼容直接存 cookie map 的旧格式
    if (typeof obj.MUSIC_U === 'string') {
      return { cookies: obj as CookieData };
    }
    if (obj.cookies && typeof obj.cookies === 'object') {
      return obj as unknown as SessionFile;
    }
    return null;
  } catch {
    return null;
  }
}

// MUSIC_U 等于账号本身：能改密码、能清空歌单、能发评论。
// 所以文件 0600、目录 0700，而且永远不下发给前端。
function writeSession(session: SessionFile): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(CONFIG_DIR, 0o700);
  } catch {
    /* 目录已存在且属主不同时可能失败，不致命 */
  }
  fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(SESSION_FILE, 0o600);
  } catch {
    /* 同上 */
  }
}

/** 从用户粘贴的内容里挖出 MUSIC_U。接受裸值，也接受整条 Cookie 头。 */
export function parseMusicU(raw: string): CookieData {
  let s = raw.trim();

  // 从 devtools 复制常常带引号
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }

  if (s.includes('MUSIC_U=')) {
    const pairs: CookieData = {};
    for (const seg of s.split(';')) {
      const m = seg.trim().match(/^([^=\s]+)=(.*)$/);
      if (m) pairs[m[1]] = m[2].trim();
    }
    const musicU = pairs.MUSIC_U;
    if (!musicU) throw new Error('没能从粘贴的内容里解析出 MUSIC_U');
    // 只留有用的：MUSIC_U 是身份，__csrf 是部分 weapi 端点要的
    const out: CookieData = { MUSIC_U: musicU };
    if (pairs.__csrf) out.__csrf = pairs.__csrf;
    return out;
  }

  // 当作裸值
  if (!s) throw new Error('MUSIC_U 不能为空');
  if (/[;\s]/.test(s)) {
    throw new Error('MUSIC_U 里不该有分号或空白字符，请只粘贴 MUSIC_U 的值，或整条 Cookie');
  }
  return { MUSIC_U: s };
}

export interface CheckResult {
  valid: boolean;
  userId?: string;
  nickname?: string;
  avatarUrl?: string;
  error?: string;
}

export class AuthManager {
  private cookies: CookieData | null = null;
  private source: string | undefined;

  constructor() {
    const session = readSession();
    if (session) {
      this.cookies = session.cookies;
      this.source = session.source;
      verbose(`已加载会话（来源 ${this.source ?? 'unknown'}）`);
    }
  }

  /**
   * 主路径：用户手填 MUSIC_U。
   * 先验证再落盘 —— 存一个无效 cookie 只会让下一次启动误以为已登录。
   */
  async setMusicU(raw: string, source = 'manual'): Promise<CheckResult> {
    const cookies = parseMusicU(raw);

    const prevCookies = this.cookies;
    const prevSource = this.source;
    this.cookies = cookies;
    this.source = source;

    const result = await this.checkAuth();
    if (!result.valid) {
      this.cookies = prevCookies;
      this.source = prevSource;
      return result;
    }

    writeSession({ cookies, source, savedAt: Date.now() });
    return result;
  }

  /** 备用路径：从浏览器读 cookie。sweet-cookie 是 optional 依赖，装没装都要能跑。 */
  async importFromBrowser(profile?: string): Promise<CheckResult> {
    let getCookies: (options: Record<string, unknown>) => Promise<{
      cookies: Array<{ name: string; value: string; source?: { browser?: string } }>;
      warnings: string[];
    }>;
    try {
      // 用变量做 specifier：这个包默认不装，写成字面量 tsc 会报 TS2307
      const spec = '@steipete/sweet-cookie';
      const mod = (await import(spec)) as unknown as { getCookies: typeof getCookies };
      getCookies = mod.getCookies;
    } catch {
      throw new Error(
        '未安装 @steipete/sweet-cookie，无法从浏览器导入。请改用手填 MUSIC_U，或先 npm i @steipete/sweet-cookie',
      );
    }

    const options: Record<string, unknown> = {
      url: 'https://music.163.com/',
      names: ['MUSIC_U'],
    };
    if (profile) options.chromeProfile = profile;

    const { cookies: found, warnings } = await getCookies(options);

    const cookieData: CookieData = {};
    let browser: string | undefined;
    for (const c of found) {
      cookieData[c.name] = c.value;
      if (!browser && c.source?.browser) browser = c.source.browser;
    }
    for (const w of warnings) warn(`cookie 导入警告: ${w}`);

    if (!cookieData.MUSIC_U) {
      const parts = ['没能从浏览器里找到网易云的登录 cookie。'];
      if (warnings.length) {
        parts.push('', '警告：', ...warnings.map((w) => `  - ${w}`));
      }
      parts.push('', '建议改用手填：devtools → Application → Cookies → music.163.com → MUSIC_U');
      throw new Error(parts.join('\n'));
    }

    const prevCookies = this.cookies;
    const prevSource = this.source;
    this.cookies = cookieData;
    this.source = browser ?? 'browser';

    const result = await this.checkAuth();
    if (!result.valid) {
      this.cookies = prevCookies;
      this.source = prevSource;
      return result;
    }

    writeSession({ cookies: cookieData, source: this.source, savedAt: Date.now() });
    return result;
  }

  /** 拿当前 cookie 打一次 /nuser/account/get，这是唯一能确认 cookie 还活着的办法 */
  async checkAuth(): Promise<CheckResult> {
    if (!this.cookies?.MUSIC_U) {
      return { valid: false, error: '未登录' };
    }
    try {
      // 动态 import 断开 auth → api/user → client → auth 的循环依赖
      const { getUserProfile } = await import('./api/user.ts');
      const profile = await getUserProfile();
      return {
        valid: true,
        userId: profile.id,
        nickname: profile.nickname,
        avatarUrl: profile.avatarUrl,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : '会话已过期';
      return { valid: false, error: msg };
    }
  }

  isAuthenticated(): boolean {
    return !!this.cookies?.MUSIC_U;
  }

  /** 只给 client.ts 用。不要把返回值透给前端或日志。 */
  getCookieString(): string {
    if (!this.cookies) return '';
    return Object.entries(this.cookies)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  getSource(): string | undefined {
    return this.source;
  }

  logout(): void {
    this.cookies = null;
    this.source = undefined;
    try {
      fs.rmSync(SESSION_FILE, { force: true });
    } catch {
      /* 文件不在就算了 */
    }
  }
}

let instance: AuthManager | null = null;

export function getAuthManager(): AuthManager {
  if (!instance) instance = new AuthManager();
  return instance;
}
