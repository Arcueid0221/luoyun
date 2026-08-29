import * as http from 'node:http';
import { pipeline } from 'node:stream/promises';
import { getPlaylistDetail, getUserPlaylists } from '../core/api/playlist.ts';
import { getLyric, getTrackDetail, getTrackUrls } from '../core/api/track.ts';
import { getAuthManager, type CheckResult } from '../core/auth.ts';
import { getApiClient } from '../core/client.ts';
import { AuthExpiredError } from '../core/errors.ts';
import type { Quality } from '../core/types.ts';
import { warn } from '../core/logger.ts';
import {
  HttpError,
  fail,
  guardRequest,
  json,
  matchRoute,
  readBody,
  type Route,
} from '../http.ts';
import { isBearerTokenValid } from './security.ts';

const HOST = '127.0.0.1';
const DEFAULT_PORT = 5680;
const MAX_AUDIO_BYTES = 90 * 1024 * 1024;
const STREAMABLE_QUALITIES = new Set<Quality>(['standard', 'higher', 'exhigh']);

interface SessionBody {
  musicU?: unknown;
}

function parsePort(raw: string | undefined): number {
  if (!raw) return DEFAULT_PORT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error('LUOYUN_SERVICE_PORT 必须是 1-65535 的整数');
  }
  return value;
}

function requireSession(): void {
  if (!getAuthManager().isAuthenticated()) {
    throw new HttpError(401, 'Luoyun 尚未登录网易云');
  }
}

function requireNumericId(id: string): string {
  if (!/^\d+$/.test(id)) throw new HttpError(400, '资源 ID 必须是数字');
  return id;
}

function audioQuality(raw: string | null): Quality {
  const quality = (raw?.trim() || 'exhigh') as Quality;
  if (!STREAMABLE_QUALITIES.has(quality)) {
    throw new HttpError(400, '音频质量只支持 standard、higher 或 exhigh');
  }
  return quality;
}

async function streamTrackAudio(trackId: string, quality: Quality, res: http.ServerResponse) {
  const urls = await getTrackUrls([trackId], quality);
  const audio = urls.get(trackId);
  if (!audio?.url) {
    throw new HttpError(422, '网易云未提供这首歌曲的可用音频');
  }
  if (audio.type && audio.type.toLowerCase() !== 'mp3') {
    throw new HttpError(422, `当前音频格式 ${audio.type} 暂不支持导入博客`);
  }
  if (audio.size > MAX_AUDIO_BYTES) {
    throw new HttpError(413, '音频文件超过 90MB 限制');
  }

  const download = await getApiClient().openDownloadStream(audio.url);
  const contentLength = download.contentLength;
  if (contentLength !== undefined && contentLength > MAX_AUDIO_BYTES) {
    download.stream.destroy();
    throw new HttpError(413, '音频文件超过 90MB 限制');
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Luoyun-Audio-Type', 'mp3');
  res.setHeader('X-Luoyun-Audio-Level', audio.level || quality);
  if (contentLength !== undefined && contentLength > 0) {
    res.setHeader('Content-Length', String(contentLength));
  }
  await pipeline(download.stream, res);
}

async function sessionStatus() {
  const auth = getAuthManager();
  const status = await auth.checkAuth();
  return {
    authenticated: status.valid,
    userId: status.userId,
    nickname: status.nickname,
    avatarUrl: status.avatarUrl,
    source: auth.getSource(),
    error: status.error,
  };
}

const routes: Route[] = [
  ['GET', '/v1/health', () => ({ status: 'ok', service: 'luoyun-provider' })],
  [
    'POST',
    '/v1/session',
    async (ctx) => {
      const body = await ctx.body<SessionBody>();
      if (typeof body.musicU !== 'string' || !body.musicU.trim()) {
        throw new HttpError(400, 'musicU 不能为空');
      }
      // parseMusicU 对"粘进来的根本不是一个 MUSIC_U"（带空白、带分号、空值）抛普通
      // Error。那是调用方的输入问题，落到默认的 500 会让管理端把它当成 Provider 故障，
      // 还会把内部文案按 5xx 记一条日志。
      let result: CheckResult;
      try {
        result = await getAuthManager().setMusicU(body.musicU, 'blog-admin');
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(400, message(error));
      }
      if (!result.valid) throw new HttpError(401, result.error ?? 'MUSIC_U 无效');
      return {
        authenticated: true,
        userId: result.userId,
        nickname: result.nickname,
        avatarUrl: result.avatarUrl,
        source: 'blog-admin',
      };
    },
  ],
  ['GET', '/v1/session', sessionStatus],
  [
    'DELETE',
    '/v1/session',
    () => {
      getAuthManager().logout();
      return { authenticated: false };
    },
  ],
  [
    'GET',
    '/v1/playlists',
    async () => {
      requireSession();
      return getUserPlaylists();
    },
  ],
  [
    'GET',
    '/v1/playlists/:id',
    async (ctx) => {
      requireSession();
      return getPlaylistDetail(requireNumericId(ctx.params.id));
    },
  ],
  [
    'GET',
    '/v1/tracks/:id/lyric',
    async (ctx) => {
      requireSession();
      return getLyric(requireNumericId(ctx.params.id));
    },
  ],
  [
    'GET',
    '/v1/tracks/:id/audio',
    async (ctx) => {
      requireSession();
      const trackId = requireNumericId(ctx.params.id);
      await streamTrackAudio(trackId, audioQuality(ctx.url.searchParams.get('quality')), ctx.res);
    },
  ],
  [
    'GET',
    '/v1/tracks/:id/info',
    async (ctx) => {
      requireSession();
      return getTrackDetail(requireNumericId(ctx.params.id));
    },
  ],
];

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * MUSIC_U 过期不是 Provider 故障，得是 401。
 *
 * 网易云对失效 cookie 的回法是 HTTP 200 + code 301，core 把它统一成
 * AuthExpiredError；不映射的话这里一律 500，Spring 只能当成"Provider 挂了"去重试，
 * 而正确动作是提示管理员重新粘一次 MUSIC_U。顺带也就不再按 5xx 刷日志。
 */
function statusFor(error: unknown): number {
  if (error instanceof HttpError) return error.status;
  if (error instanceof AuthExpiredError) return 401;
  return 500;
}

const token = process.env.LUOYUN_SERVICE_TOKEN?.trim();
if (!token || token.length < 32) {
  throw new Error('启动 Provider 前必须设置至少 32 个字符的 LUOYUN_SERVICE_TOKEN');
}

const port = parsePort(process.env.LUOYUN_SERVICE_PORT);
const server = http.createServer((req, res) => {
  const method = req.method ?? 'GET';
  const url = new URL(req.url ?? '/', `http://${HOST}:${port}`);

  void (async () => {
    try {
      guardRequest(req);

      const hit = matchRoute(routes, method, url.pathname);
      if (!hit) throw new HttpError(404, `没有这个接口: ${method} ${url.pathname}`);

      if (url.pathname !== '/v1/health' && !isBearerTokenValid(req.headers.authorization, token)) {
        throw new HttpError(401, 'Provider 服务令牌无效');
      }

      const result = await hit.handler({
        req,
        res,
        url,
        params: hit.params,
        body: <T>() => readBody<T>(req),
      });
      if (result !== undefined) json(res, result);
    } catch (error) {
      if (res.headersSent) {
        warn(`${method} ${url.pathname} 响应中途出错: ${message(error)}`);
        if (!res.writableEnded) res.end();
        return;
      }
      const status = statusFor(error);
      if (status >= 500) warn(`${method} ${url.pathname} -> ${status}: ${message(error)}`);
      fail(res, status, message(error));
    }
  })();
});

server.keepAliveTimeout = 5000;
server.listen(port, HOST, () => {
  process.stderr.write(`[luoyun-provider] listening on http://${HOST}:${port}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
  });
}
