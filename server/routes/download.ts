import { getPlaylistDetail } from '../core/api/playlist.ts';
import { cancelJob, createJob, getJob, listJobs, subscribe } from '../download/job.ts';
import { runJob, type JobItem } from '../download/pipeline.ts';
import { forget, forgetDir } from '../download/db.ts';
import { playlistDirPath } from '../download/naming.ts';
import { defaultDownloadDir, safeDir } from './fs.ts';
import { requireAuth } from './auth.ts';
import { HttpError, sse, type Route } from '../http.ts';
import { warn } from '../core/logger.ts';
import {
  DOWNLOAD_PARTS,
  QUALITIES,
  type PartFlags,
  type Quality,
} from '../core/types.ts';

interface DownloadBody {
  playlistId?: string;
  trackIds?: string[];
  parts?: Partial<PartFlags>;
  quality?: Quality;
  destDir?: string;
  /** true = 忽略幂等记录，全部重下 */
  force?: boolean;
}

function normalizeParts(input?: Partial<PartFlags>): PartFlags {
  const parts: PartFlags = { audio: false, cover: false, lyric: false, info: false };
  for (const p of DOWNLOAD_PARTS) parts[p] = !!input?.[p];
  if (!DOWNLOAD_PARTS.some((p) => parts[p])) throw new HttpError(400, '至少要选一项内容');
  return parts;
}

/**
 * trackIds 必须真的是字符串数组。
 * 不检查的话 `{"trackIds":{"length":1}}` 会让 `new Set(...)` 抛 TypeError（→ 500），
 * `"trackIds":"123"` 更坏 —— 悄悄变成 `{'1','2','3'}` 三个 id，然后报一句
 * "选中的歌一首都不在这个歌单里"，谁也想不到是类型的事。
 */
function normalizeTrackIds(input: unknown): string[] | null {
  if (input === undefined || input === null) return null;
  if (!Array.isArray(input) || input.some((id) => typeof id !== 'string')) {
    throw new HttpError(400, 'trackIds 必须是字符串数组');
  }
  return input.length ? (input as string[]) : null;
}

export const downloadRoutes: Route[] = [
  [
    'POST',
    '/api/download',
    async (ctx) => {
      requireAuth();
      const body = await ctx.body<DownloadBody>();
      if (!body.playlistId) throw new HttpError(400, '缺少 playlistId');

      const parts = normalizeParts(body.parts);
      const quality = QUALITIES.includes(body.quality as Quality)
        ? (body.quality as Quality)
        : 'exhigh';
      // 没传目录就用默认的，别报一句"目录不能为空"
      const asked = typeof body.destDir === 'string' && body.destDir.trim() ? body.destDir : '';
      const destDir = safeDir(asked || defaultDownloadDir());

      const playlist = await getPlaylistDetail(body.playlistId);
      const all = playlist.tracks ?? [];
      if (all.length === 0) throw new HttpError(400, '这个歌单里没有歌');

      // 序号取歌单里的原始位置，不是选中列表里的第几个
      const ids = normalizeTrackIds(body.trackIds);
      const wanted = ids ? new Set(ids) : null;
      const items: JobItem[] = [];
      all.forEach((track, i) => {
        if (!wanted || wanted.has(track.id)) items.push({ track, index: i + 1 });
      });
      if (items.length === 0) throw new HttpError(400, '选中的歌一首都不在这个歌单里');

      if (body.force) {
        // 幂等记录按歌单目录存，这里得用同一个算法算出同一个路径
        const dir = playlistDirPath(destDir, playlist.name);
        for (const { track } of items) forget(track.id, dir);
      }

      const job = createJob({
        playlistId: playlist.id,
        playlistName: playlist.name,
        destDir,
        parts,
        quality,
        tracks: items.map((it) => it.track),
      });

      // 故意不 await：立刻把 jobId 还给前端，进度全部走 SSE。
      // 这里 await 的话请求会挂几十分钟然后超时。
      void runJob(job, items, playlist, all.length).catch((error) => {
        warn(`任务 ${job.id} 异常终止: ${error instanceof Error ? error.message : error}`);
      });

      return { jobId: job.id, total: items.length, destDir };
    },
  ],

  [
    'GET',
    '/api/download',
    () => {
      requireAuth();
      return listJobs();
    },
  ],

  [
    'GET',
    '/api/download/:id',
    (ctx) => {
      requireAuth();
      const job = getJob(ctx.params.id);
      // 任务是内存态，改 server/ 下任何文件都会重启 dev server 并清空
      if (!job) throw new HttpError(404, '任务不存在（dev server 重启会清空任务）');
      return job;
    },
  ],

  [
    'GET',
    '/api/download/:id/events',
    (ctx) => {
      requireAuth();
      const job = getJob(ctx.params.id);
      if (!job) throw new HttpError(404, '任务不存在');

      const channel = sse(ctx.res);
      // 先推一次全量快照，断线重连才能对齐状态
      channel.send('snapshot', job);

      const unsubscribe = subscribe(job.id, (event) => channel.send(event.type, event));

      // 关页面时必须摘监听器，否则 listeners Map 只涨不减
      ctx.req.on('close', () => {
        unsubscribe();
        channel.close();
      });

      // 返回 undefined = 这个响应我自己接管了，plugin 不要再写
      return undefined;
    },
  ],

  [
    'POST',
    '/api/download/:id/cancel',
    (ctx) => {
      requireAuth();
      if (!cancelJob(ctx.params.id)) throw new HttpError(404, '任务不存在');
      return { cancelled: true };
    },
  ],

  [
    'POST',
    '/api/download/forget',
    async (ctx) => {
      requireAuth();
      const body = await ctx.body<{ destDir?: string }>();
      // 传根目录进来就把根目录下所有歌单的记录一起清掉，见 db.forgetDir
      forgetDir(safeDir(body.destDir ?? ''));
      return { ok: true };
    },
  ],
];
