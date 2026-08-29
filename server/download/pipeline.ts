import * as fs from 'node:fs';
import * as path from 'node:path';
import pLimit from 'p-limit';
import { getApiClient, type ProgressFn } from '../core/client.ts';
import { getLyric, getTrackDetails, getTrackUrls, type TrackDetail } from '../core/api/track.ts';
import { getAlbumDescription, getArtistDescription } from '../core/api/album.ts';
import { coverUrl } from '../core/api/transform.ts';
import type {
  DownloadPart,
  Job,
  Playlist,
  Quality,
  SkipReason,
  SongInfo,
  Track,
  TrackUrlInfo,
} from '../core/types.ts';
import { debug, verbose, warn } from '../core/logger.ts';
import { audioExt, playlistDirPath, trackDirName, uniqueDir } from './naming.ts';
import { isDone, markDone } from './db.ts';
import { embedTags } from './tag.ts';
import { failJob, finishJob, getAbortSignal, isCancelled, updateTrack } from './job.ts';

// 网易会限流，并行发几十个 url 请求很容易返回一堆 null，
// 表现上和"全都没版权"一模一样，极难 debug。
// 保守并发不是性能洁癖，是为了让失败可解释。
const CONCURRENCY = 3;
const STAGGER_MS = 250;
const RETRY_TIMES = 2;
const RETRY_DELAY_MS = 800;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 重试。`fn` 收到的是第几次尝试（0 起），音频靠它在重试时换一个新解析的地址。
 *
 * 传了 `signal` 的话取消后立刻放弃：否则一次取消还要多等 800 + 1600ms，
 * 中间又对着已经 abort 的信号发两次注定失败的请求。
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  times = RETRY_TIMES,
  delayMs = RETRY_DELAY_MS,
  signal?: AbortSignal,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= times; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (signal?.aborted) break;
      if (attempt < times) await sleep(delayMs * 2 ** attempt);
    }
  }
  throw lastError;
}

function activeParts(job: Job): DownloadPart[] {
  return (Object.keys(job.parts) as DownloadPart[]).filter((p) => job.parts[p]);
}

function writeFileAtomic(filePath: string, data: string): void {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, data, 'utf-8');
  fs.renameSync(tmp, filePath);
}

/**
 * 一首待下载的歌 + 它在歌单里的原始序号。
 *
 * 序号必须是歌单里的位置，不能是"本次选中列表里的第几个"：
 * 否则先下 5/10/20 三首得到 01/02/03，之后换音质重下整个歌单时，
 * 同一首歌会落到另一个编号的目录里，磁盘上留下两份。
 */
export interface JobItem {
  track: Track;
  index: number;
}

/** 顶层 playlist.json：歌单元信息 + 完整曲目清单 + 本次任务参数 */
export function writePlaylistJson(
  playlistDir: string,
  job: Job,
  playlist: Playlist,
  items: JobItem[],
  total: number,
): void {
  const payload = {
    playlist: {
      id: playlist.id,
      name: playlist.name,
      description: playlist.description,
      coverUrl: playlist.coverUrl,
      trackCount: playlist.trackCount,
      creator: playlist.creator,
    },
    job: {
      id: job.id,
      quality: job.quality,
      parts: job.parts,
      destDir: job.destDir,
      createdAt: new Date(job.createdAt).toISOString(),
      selectedCount: items.length,
      playlistTotal: total,
    },
    tracks: items.map(({ track, index }) => ({
      index,
      dir: trackDirName(index, track, total),
      id: track.id,
      name: track.name,
      artists: track.artists.map((a) => a.name),
      album: track.album.name,
      duration: track.duration,
    })),
  };
  writeFileAtomic(path.join(playlistDir, 'playlist.json'), JSON.stringify(payload, null, 2));
}

function skipReason(info?: TrackUrlInfo): SkipReason {
  // fee 1 = VIP 专享，4 = 单曲付费。其余归到无版权
  return info?.fee === 1 || info?.fee === 4 ? 'vip' : 'no-copyright';
}

/**
 * @param items 本次要下的歌 + 它们在歌单里的原始序号
 * @param total 歌单总曲目数，只用来决定序号补几位（99 首以内两位，以上三位）
 */
export async function runJob(
  job: Job,
  items: JobItem[],
  playlist: Playlist,
  total: number,
): Promise<void> {
  const playlistDir = playlistDirPath(job.destDir, playlist.name || job.playlistName);

  try {
    fs.mkdirSync(playlistDir, { recursive: true });
    writePlaylistJson(playlistDir, job, playlist, items, total);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failJob(job.id, `创建目录失败: ${message}`);
    finishJob(job.id);
    return;
  }

  const ids = items.map((it) => it.track.id);

  // 先把所有播放地址批量拿回来，一次性把不可用的标出来 ——
  // 而不是下到第 40 首才发现前面一半根本没版权。
  let urls = new Map<string, TrackUrlInfo>();
  if (job.parts.audio) {
    try {
      urls = await getTrackUrls(ids, job.quality);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failJob(job.id, `批量获取播放地址失败: ${message}`);
    }
  }

  // publishTime 只有 /song/detail 给，歌单接口不给
  const extras = new Map<string, TrackDetail>();
  if (job.parts.info) {
    try {
      for (const detail of await getTrackDetails(ids)) extras.set(detail.track.id, detail);
    } catch (error) {
      debug(`补充详情失败: ${error instanceof Error ? error.message : error}`);
    }
  }

  const pending: JobItem[] = [];
  for (const item of items) {
    if (job.parts.audio) {
      const info = urls.get(item.track.id);
      if (!info?.url) {
        updateTrack(job.id, item.track.id, { status: 'skipped', reason: skipReason(info) });
        continue;
      }
    }
    pending.push(item);
  }

  verbose(`任务 ${job.id}: ${pending.length}/${items.length} 首可下载`);

  // 250ms 一个发车位，真正把请求错开；p-limit 只管同时在跑几个
  let nextSlot = 0;
  const gate = async (): Promise<void> => {
    const now = Date.now();
    const at = Math.max(now, nextSlot);
    nextSlot = at + STAGGER_MS;
    if (at > now) await sleep(at - now);
  };

  const limit = pLimit(CONCURRENCY);
  try {
    await Promise.all(
      pending.map(({ track, index }) =>
        limit(async () => {
          if (isCancelled(job.id)) return;
          await gate();
          if (isCancelled(job.id)) return;
          await downloadOne(
            job,
            playlistDir,
            track,
            index,
            total,
            urls.get(track.id),
            extras.get(track.id),
          );
        }),
      ),
    );
  } finally {
    // 收尾必须在 finally 里。downloadOne 已经自己兜住了下载期间的异常，
    // 但幂等库、命名、mkdir 仍可能抛（磁盘满、权限、sqlite 锁）——
    // 那时候如果 finishJob 被跳过，job.status 永远停在 running：
    // done 事件不发、页面一直转、SSE 连着不放、evictOldJobs 也回收不掉。
    finishJob(job.id);
  }
}

/** 播放地址过期后重新解析一次。拿不到就返回 undefined，让调用方沿用旧地址 */
async function freshAudioUrl(trackId: string, quality: Quality): Promise<string | undefined> {
  try {
    const map = await getTrackUrls([trackId], quality);
    return map.get(trackId)?.url ?? undefined;
  } catch (error) {
    debug(`重新解析播放地址失败 ${trackId}: ${error instanceof Error ? error.message : error}`);
    return undefined;
  }
}

/** 每个 chunk 都推一次会把 SSE 打爆，限制成 500ms 或 1MB 一次 */
function throttleProgress(jobId: string, trackId: string): ProgressFn {
  let lastAt = 0;
  let lastBytes = 0;
  return (received) => {
    const now = Date.now();
    if (now - lastAt < 500 && received - lastBytes < 1024 * 1024) return;
    lastAt = now;
    lastBytes = received;
    updateTrack(jobId, trackId, { bytes: received });
  };
}

async function downloadOne(
  job: Job,
  playlistDir: string,
  track: Track,
  index: number,
  total: number,
  urlInfo?: TrackUrlInfo,
  detail?: TrackDetail,
): Promise<void> {
  const parts = activeParts(job);
  const client = getApiClient();
  const signal = getAbortSignal(job.id);

  let bytes = 0;
  let coverPath: string | undefined;
  let lyricText: string | undefined;
  let audioPath: string | undefined;

  try {
    // 判重按**歌单目录**，不是用户选的根目录：
    // 同一首歌出现在两个歌单里时，用根目录做 key 会让第二个歌单直接跳过它
    if (isDone(track.id, playlistDir, parts, job.quality)) {
      updateTrack(job.id, track.id, { status: 'skipped', reason: 'already' });
      return;
    }

    const dir = uniqueDir(playlistDir, trackDirName(index, track, total), track.id);
    updateTrack(job.id, track.id, { status: 'running', dir, error: undefined });

    fs.mkdirSync(dir, { recursive: true });
    const tasks: Promise<unknown>[] = [];

    // 四条任务都得能被取消打断：withRetry 看到 signal.aborted 就不再睡下一轮退避。
    // 少传 signal 的那几条会在用户点了取消之后继续重试、继续打网易的接口。
    const retry = <T>(fn: (attempt: number) => Promise<T>): Promise<T> =>
      withRetry(fn, RETRY_TIMES, RETRY_DELAY_MS, signal);

    const audioUrl = urlInfo?.url;
    if (job.parts.audio && audioUrl) {
      audioPath = path.join(dir, `audio.${audioExt(urlInfo?.type, audioUrl)}`);
      const dest = audioPath;
      const expected = urlInfo?.size ?? 0;
      tasks.push(
        retry(async (attempt) => {
          // 播放地址大约 20 分钟过期，几百首的任务尾部必然踩到 403。
          // 重试时重新解析一次，比让用户看一屏 403 有用。
          // 扩展名沿用第一次的：同一个 level 重解析回来的编码一致。
          const url =
            attempt === 0 ? audioUrl : ((await freshAudioUrl(track.id, job.quality)) ?? audioUrl);
          bytes = await client.download(url, dest, throttleProgress(job.id, track.id), signal);
          // 200 带空 body 会留下一个 0 字节的 audio.flac，还会被 markDone 记成"已下过"，
          // 于是这首歌以后永远不再下。宁可当失败，让用户点"重试失败项"。
          if (bytes === 0) throw new Error('音频下载到 0 字节');
          if (expected > 0 && bytes < expected) {
            warn(`${track.name} 音频只拿到 ${bytes}/${expected} 字节`);
          }
        }),
      );
    }

    if (job.parts.cover) {
      // 网易默认给缩略图，coverUrl() 会补 ?param=1000y1000 换原图
      const url = coverUrl(track.album.picUrl);
      if (url) {
        const dest = path.join(dir, 'cover.jpg');
        coverPath = dest;
        tasks.push(retry(() => client.download(url, dest, undefined, signal)));
      } else {
        debug(`${track.name} 没有封面地址`);
      }
    }

    if (job.parts.lyric) {
      tasks.push(
        retry(async () => {
          const lyric = await getLyric(track.id);
          lyricText = lyric.lrc;
          if (lyric.lrc) writeFileAtomic(path.join(dir, 'lyric.lrc'), lyric.lrc);
          if (lyric.tlyric) writeFileAtomic(path.join(dir, 'lyric.zh.lrc'), lyric.tlyric);
          if (lyric.romalrc) writeFileAtomic(path.join(dir, 'lyric.roma.lrc'), lyric.romalrc);
        }),
      );
    }

    if (job.parts.info) {
      tasks.push(
        retry(async () => {
          const info: SongInfo = {
            track,
            publishTime: detail?.publishTime,
            albumDescription: await getAlbumDescription(track.album.id),
            artistDescription: await getArtistDescription(track.artists[0]?.id ?? ''),
            playlist: { id: job.playlistId, name: job.playlistName },
            // 请求的档位和实际给到的档位都记下来，事后才看得出被降级过
            audio: urlInfo
              ? {
                  requested: job.quality,
                  level: urlInfo.level,
                  br: urlInfo.br,
                  type: urlInfo.type,
                  size: urlInfo.size,
                }
              : undefined,
          };
          writeFileAtomic(path.join(dir, 'info.json'), JSON.stringify(info, null, 2));
        }),
      );
    }

    // allSettled 而不是 all：Promise.all 在第一个 reject 时就把控制权交回来，
    // 兄弟任务还在后台写文件、还在 updateTrack 推字节数 ——
    // 页面上就会看到一首已经标红的歌继续涨进度，甚至在整个任务 done 之后还涨。
    const results = await Promise.allSettled(tasks);
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) throw failed.reason;

    // 内嵌是加分项，embedTags 内部已经把所有失败降级成 warning
    if (audioPath && (coverPath || lyricText)) {
      await embedTags({
        audioPath,
        coverPath,
        lyricText,
        track,
        publishTime: detail?.publishTime,
      });
    }

    markDone({
      trackId: track.id,
      destDir: playlistDir,
      parts,
      quality: job.quality,
      fileDir: dir,
      bytes,
    });
    updateTrack(job.id, track.id, { status: 'done', bytes, dir });
  } catch (error) {
    // 取消导致的中断不算失败
    if (isCancelled(job.id)) {
      updateTrack(job.id, track.id, { status: 'skipped', reason: 'cancelled' });
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    warn(`${track.name} 下载失败: ${message}`);
    updateTrack(job.id, track.id, { status: 'failed', error: message });
  }
}
