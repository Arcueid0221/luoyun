import { getAuthManager, type CheckResult } from '../core/auth.ts';
import { clearDescriptionCache } from '../core/api/album.ts';
import { HttpError, type Route } from '../http.ts';
import type { AuthStatus, BrowserLoginPollStatus } from '../core/types.ts';

/** 所有需要账号的路由第一行都调它 */
export function requireAuth(): void {
  if (!getAuthManager().isAuthenticated()) {
    throw new HttpError(401, '未登录，请先填入 MUSIC_U');
  }
}

// 只返回昵称/头像/布尔值。MUSIC_U 永远不下发 —— 它等于账号本身，
// 前端能读到就等于 localStorage 里躺着一把总钥匙。
async function buildStatus(): Promise<AuthStatus> {
  const auth = getAuthManager();
  if (!auth.isAuthenticated()) return { authenticated: false };

  const result = await auth.checkAuth();
  return statusFromCheck(result);
}

function statusFromCheck(result: CheckResult): AuthStatus {
  return {
    authenticated: result.valid,
    userId: result.userId,
    nickname: result.nickname,
    avatarUrl: result.avatarUrl,
    source: getAuthManager().getSource(),
    error: result.valid ? undefined : result.error,
  };
}

export const authRoutes: Route[] = [
  [
    'POST',
    '/api/auth/cookie',
    async (ctx) => {
      const body = await ctx.body<{ musicU?: string }>();
      if (!body.musicU || typeof body.musicU !== 'string') {
        throw new HttpError(400, '缺少 musicU');
      }
      // setMusicU 内部先验证再落盘：存一个无效 cookie 只会让下次启动误以为已登录
      const result = await getAuthManager().setMusicU(body.musicU);
      if (!result.valid) throw new HttpError(401, result.error ?? 'MUSIC_U 无效');
      clearDescriptionCache();
      return statusFromCheck(result);
    },
  ],

  [
    'POST',
    '/api/auth/import',
    async (ctx) => {
      const body = await ctx.body<{ profile?: string }>();
      const profile = typeof body.profile === 'string' ? body.profile : undefined;
      const result = await getAuthManager().importFromBrowser(profile);
      if (!result.valid) throw new HttpError(401, result.error ?? '导入的 cookie 无效');
      clearDescriptionCache();
      return statusFromCheck(result);
    },
  ],

  [
    'POST',
    '/api/auth/import/poll',
    async (ctx) => {
      const body = await ctx.body<{ profile?: string }>();
      const profile = typeof body.profile === 'string' ? body.profile : undefined;
      const result = await getAuthManager().pollBrowserLogin(profile);
      if (!result) {
        return { state: 'waiting' } satisfies BrowserLoginPollStatus;
      }
      clearDescriptionCache();
      return {
        state: 'authenticated',
        session: statusFromCheck(result),
      } satisfies BrowserLoginPollStatus;
    },
  ],

  ['GET', '/api/auth/status', () => buildStatus()],

  [
    'POST',
    '/api/auth/logout',
    () => {
      getAuthManager().logout();
      clearDescriptionCache();
      return { authenticated: false } satisfies AuthStatus;
    },
  ],
];
