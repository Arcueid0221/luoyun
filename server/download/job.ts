import * as crypto from 'node:crypto';
import type {
  Job,
  JobEvent,
  JobSummary,
  JobTrackState,
  PartFlags,
  Quality,
  Track,
} from '../core/types.ts';
import { debug } from '../core/logger.ts';
import { artistLabel } from './naming.ts';

// 任务状态只活在内存里，不落盘。
// 注意：改 server/ 下任何文件都会让 Vite 重启 dev server，任务全部清空。
const jobs = new Map<string, Job>();
const listeners = new Map<string, Set<(e: JobEvent) => void>>();
const aborters = new Map<string, AbortController>();
// 已经发过 done 的任务。取消和正常收尾都会走 finishJob，只能发一次
const doneEmitted = new Set<string>();

// 长时间开着 dev server 会攒一堆已完成任务，留最近 20 个够用了
const MAX_JOBS = 20;

export interface CreateJobOptions {
  playlistId: string;
  playlistName: string;
  destDir: string;
  parts: PartFlags;
  quality: Quality;
  tracks: Track[];
}

export function createJob(opts: CreateJobOptions): Job {
  const job: Job = {
    id: crypto.randomUUID(),
    playlistId: opts.playlistId,
    playlistName: opts.playlistName,
    destDir: opts.destDir,
    parts: opts.parts,
    quality: opts.quality,
    status: 'running',
    createdAt: Date.now(),
    tracks: opts.tracks.map((t) => ({
      trackId: t.id,
      name: `${t.name} - ${artistLabel(t)}`,
      status: 'pending' as const,
    })),
  };

  jobs.set(job.id, job);
  aborters.set(job.id, new AbortController());
  evictOldJobs();
  return job;
}

function evictOldJobs(): void {
  if (jobs.size <= MAX_JOBS) return;
  const finished = [...jobs.values()]
    .filter((j) => j.status !== 'running')
    .sort((a, b) => a.createdAt - b.createdAt);
  for (const job of finished) {
    if (jobs.size <= MAX_JOBS) break;
    jobs.delete(job.id);
    listeners.delete(job.id);
    aborters.delete(job.id);
    doneEmitted.delete(job.id);
  }
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function listJobs(): Job[] {
  return [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export function subscribe(jobId: string, fn: (e: JobEvent) => void): () => void {
  let set = listeners.get(jobId);
  if (!set) {
    set = new Set();
    listeners.set(jobId, set);
  }
  set.add(fn);
  return () => {
    // 浏览器关页面时必须摘掉，否则 Map 会一直涨
    listeners.get(jobId)?.delete(fn);
  };
}

export function emit(jobId: string, event: JobEvent): void {
  const set = listeners.get(jobId);
  if (!set) return;
  for (const fn of set) {
    try {
      fn(event);
    } catch (error) {
      // 一个监听者抛错不能影响其他人
      debug(`SSE 监听者抛错: ${error instanceof Error ? error.message : error}`);
    }
  }
}

/**
 * 改状态 + 推事件绑在一起。
 * 分开写的话最常见的 bug 就是改了内存忘了推，UI 永远卡在"下载中"。
 */
export function updateTrack(
  jobId: string,
  trackId: string,
  patch: Partial<Omit<JobTrackState, 'trackId' | 'name'>>,
): void {
  const job = jobs.get(jobId);
  if (!job) return;
  const track = job.tracks.find((t) => t.trackId === trackId);
  if (!track) return;

  Object.assign(track, patch);
  emit(jobId, { type: 'track', track: { ...track } });
}

export function summarize(job: Job): JobSummary {
  let done = 0;
  let skipped = 0;
  let failed = 0;
  for (const t of job.tracks) {
    if (t.status === 'done') done++;
    else if (t.status === 'skipped') skipped++;
    else if (t.status === 'failed') failed++;
  }
  return { done, skipped, failed };
}

export function finishJob(jobId: string): JobSummary | undefined {
  const job = jobs.get(jobId);
  if (!job) return undefined;
  if (job.status === 'running') job.status = 'done';
  const summary = summarize(job);
  // done 只发一次。能走到这里的路径有三条（runJob 的 finally、创建目录失败的
  // 提前返回、取消后的收尾），重复的 done 会把页面上的"已取消"又刷回"已结束"
  if (!doneEmitted.has(jobId)) {
    doneEmitted.add(jobId);
    emit(jobId, { type: 'done', summary, status: job.status });
  }
  return summary;
}

/**
 * 任务级错误：记在 Job 上**再**发事件。
 *
 * 只发事件不行 —— `runJob` 在 POST 响应写回之前就开始跑，创建目录失败时
 * 事件早于页面拿到 jobId，页面订阅上来只看到一个 tracks 全是 pending、
 * status 已经是 done 的任务，显示成"已结束 0/40"，一个字的错误都看不到。
 */
export function failJob(jobId: string, message: string): void {
  const job = jobs.get(jobId);
  if (job) job.error = message;
  emit(jobId, { type: 'error', message });
}

/**
 * 取消。
 *
 * 这里**不发** done：`runJob` 的 finally 一定会调 finishJob，由它发唯一那一个，
 * 那时 summary 才是最终值。
 */
export function cancelJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job) return false;
  // 已经结束的任务当成功处理，免得页面上一个无害的重复点击弹出错误
  if (job.status !== 'running') return true;

  aborters.get(id)?.abort();
  job.status = 'cancelled';
  // 还没开始的直接标掉，UI 不用等。必须走 updateTrack：
  // 直接改字段不会发 track 事件，那些行会永远停在"等待"
  for (const t of job.tracks) {
    if (t.status === 'pending') {
      updateTrack(id, t.trackId, { status: 'skipped', reason: 'cancelled' });
    }
  }
  return true;
}

export function isCancelled(id: string): boolean {
  return jobs.get(id)?.status === 'cancelled';
}

/** 传给 client.download，让正在传输的请求也能被立刻掐断 */
export function getAbortSignal(id: string): AbortSignal | undefined {
  return aborters.get(id)?.signal;
}
