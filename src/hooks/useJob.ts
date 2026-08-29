import { useEffect, useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { get, openEvents, post, type StreamEvent } from '../api/client.ts';
import type { Job, PartFlags, Quality } from '../../server/core/types.ts';

export interface StartDownloadBody {
  playlistId: string;
  /** 不传 = 整个歌单 */
  trackIds?: string[];
  parts: PartFlags;
  quality: Quality;
  destDir: string;
  /** true = 忽略幂等记录，全部重下 */
  force?: boolean;
}

export interface StartDownloadResult {
  jobId: string;
  total: number;
  destDir: string;
}

export function useStartDownload() {
  return useMutation({
    mutationFn: (body: StartDownloadBody) => post<StartDownloadResult>('/api/download', body),
  });
}

export function useCancelJob() {
  return useMutation({
    mutationFn: (jobId: string) =>
      post<{ cancelled: boolean }>(`/api/download/${encodeURIComponent(jobId)}/cancel`),
  });
}

export interface JobCounts {
  total: number;
  pending: number;
  running: number;
  done: number;
  skipped: number;
  failed: number;
  /** done + skipped + failed，进度条用 */
  settled: number;
}

export interface JobView {
  job: Job | null;
  counts: JobCounts;
  loading: boolean;
  /** 拉快照失败，或者后端推来的任务级错误 */
  error: string | null;
  /** EventSource 彻底放弃重连，且不是因为任务已完成 */
  streamDown: boolean;
}

const EMPTY_COUNTS: JobCounts = {
  total: 0,
  pending: 0,
  running: 0,
  done: 0,
  skipped: 0,
  failed: 0,
  settled: 0,
};

/**
 * 用本地 useState 而不是 Query 缓存：这是推送流，不是拉取源。
 *
 * 流程是"先 GET 快照，再订阅 SSE"。SSE 连上时后端也会推一次快照，
 * 所以两者之间丢掉的事件会被补上；GET 存在的意义是能拿到明确的
 * 404 文案 —— EventSource 的 error 事件读不到状态码，任务不存在
 * 和网络不通在它眼里长得一模一样。
 */
export function useJob(jobId: string | null): JobView {
  const [job, setJob] = useState<Job | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streamDown, setStreamDown] = useState(false);

  useEffect(() => {
    setJob(null);
    setError(null);
    setStreamDown(false);
    if (!jobId) {
      setLoading(false);
      return;
    }

    let disposed = false;
    let finished = false;
    let close: (() => void) | undefined;
    setLoading(true);

    const handle = (event: StreamEvent): void => {
      if (disposed) return;
      switch (event.type) {
        case 'snapshot':
          setJob(event.job);
          // 任务级错误存在 Job 上，所以订阅之前就已经发生的错误也能补到
          if (event.job.error) setError(event.job.error);
          if (event.job.status !== 'running') finished = true;
          break;
        case 'track':
          // 按 trackId 局部替换，不整体重拉
          setJob((prev) =>
            prev
              ? {
                  ...prev,
                  tracks: prev.tracks.map((t) =>
                    t.trackId === event.track.trackId ? event.track : t,
                  ),
                }
              : prev,
          );
          break;
        case 'done':
          finished = true;
          // 用后端给的 status，不要拿本地状态去猜：
          // 取消可能来自另一个标签页，也可能发生在这个页面订阅之前
          setJob((prev) => (prev ? { ...prev, status: event.status } : prev));
          break;
        case 'error':
          setError(event.message);
          break;
        case 'closed':
          if (!finished) setStreamDown(true);
          break;
      }
    };

    void (async () => {
      try {
        const snapshot = await get<Job>(`/api/download/${encodeURIComponent(jobId)}`);
        if (disposed) return;
        setJob(snapshot);
        if (snapshot.error) setError(snapshot.error);
        if (snapshot.status !== 'running') finished = true;
      } catch (err) {
        if (disposed) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
        return; // 任务都不存在，没必要再连 SSE
      }
      setLoading(false);
      if (disposed) return;
      close = openEvents(jobId, handle);
    })();

    // 少了这行，切走再回来会叠加多个 EventSource
    return () => {
      disposed = true;
      close?.();
    };
  }, [jobId]);

  const counts = useMemo<JobCounts>(() => {
    if (!job) return EMPTY_COUNTS;
    const counts = { ...EMPTY_COUNTS, total: job.tracks.length };
    for (const track of job.tracks) counts[track.status]++;
    counts.settled = counts.done + counts.skipped + counts.failed;
    return counts;
  }, [job]);

  return { job, counts, loading, error, streamDown };
}
