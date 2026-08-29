import { useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  Ban,
  CircleAlert,
  CircleCheck,
  CircleX,
  Clock,
  LoaderCircle,
  RefreshCw,
  X,
} from 'lucide-react';
import { get } from '../api/client.ts';
import { useCancelJob, useJob, useStartDownload } from '../hooks/useJob.ts';
import { formatBytes, messageOf, tildify } from '../lib/format.ts';
import type { JobTrackState, SkipReason } from '../../server/core/types.ts';

const ROW_HEIGHT = 52;

const SKIP_TEXT: Record<SkipReason, string> = {
  'no-copyright': '跳过 · 无版权',
  vip: '跳过 · 需会员',
  already: '跳过 · 已下过',
  cancelled: '跳过 · 已取消',
};

interface Props {
  jobId: string;
  onClose(): void;
  onStarted(jobId: string): void;
}

export function JobPanel({ jobId, onClose, onStarted }: Props) {
  const { job, counts, loading, error, streamDown } = useJob(jobId);
  const cancel = useCancelJob();
  const retry = useStartDownload();
  const scrollRef = useRef<HTMLDivElement>(null);

  const defaults = useQuery({
    queryKey: ['fs-default'],
    queryFn: () => get<{ path: string; home: string }>('/api/fs/default'),
    staleTime: Infinity,
  });

  const tracks = job?.tracks ?? [];
  const virtualizer = useVirtualizer({
    count: tracks.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  const failedIds = tracks.filter((t) => t.status === 'failed').map((t) => t.trackId);
  const percent = counts.total > 0 ? Math.round((counts.settled / counts.total) * 100) : 0;

  function retryFailed() {
    if (!job || failedIds.length === 0) return;
    retry.mutate(
      {
        playlistId: job.playlistId,
        trackIds: failedIds,
        parts: job.parts,
        quality: job.quality,
        destDir: job.destDir,
        // 失败的歌可能已经写了半个目录，重下必须绕过幂等记录
        force: true,
      },
      { onSuccess: (result) => onStarted(result.jobId) },
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 space-y-3 border-b border-zinc-800 px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">
              {job?.playlistName ?? '任务'}
              {job?.status === 'cancelled' && (
                <span className="ml-2 text-xs text-amber-400">已取消</span>
              )}
              {job?.status === 'done' && (
                <span className="ml-2 text-xs text-emerald-400">已结束</span>
              )}
            </div>
            <div className="truncate font-mono text-xs text-zinc-500">
              {job ? tildify(job.destDir, defaults.data?.home) : ''}
            </div>
          </div>

          {failedIds.length > 0 && (
            <button
              type="button"
              onClick={retryFailed}
              disabled={retry.isPending}
              className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-200 enabled:hover:border-zinc-500 disabled:opacity-40"
            >
              {retry.isPending ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              重试 {failedIds.length} 首失败
            </button>
          )}

          {job?.status === 'running' && (
            <button
              type="button"
              onClick={() => cancel.mutate(jobId)}
              // 点完之后 status 还会是 running 一小会儿（要等在跑的几首收掉），
              // 这段时间按钮必须停下来，否则看着像没反应
              disabled={cancel.isPending || cancel.isSuccess}
              className="inline-flex items-center gap-1.5 rounded-lg border border-amber-800 px-2.5 py-1.5 text-xs text-amber-300 enabled:hover:bg-amber-950/40 disabled:opacity-40"
            >
              {cancel.isPending || cancel.isSuccess ? (
                <>
                  <LoaderCircle className="size-3.5 animate-spin" /> 取消中
                </>
              ) : (
                <>
                  <Ban className="size-3.5" /> 取消
                </>
              )}
            </button>
          )}

          <button
            type="button"
            onClick={onClose}
            title="回到曲目列表"
            className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
          <div
            className="h-full rounded-full bg-emerald-500 transition-[width] duration-300"
            style={{ width: `${percent}%` }}
          />
        </div>

        <div className="tabular flex flex-wrap gap-x-4 gap-y-1 text-xs">
          <span className="text-zinc-400">
            {counts.settled} / {counts.total}
          </span>
          <span className="text-emerald-400">完成 {counts.done}</span>
          <span className="text-zinc-500">跳过 {counts.skipped}</span>
          <span className={counts.failed > 0 ? 'text-red-400' : 'text-zinc-600'}>
            失败 {counts.failed}
          </span>
          <span className="text-sky-400">进行中 {counts.running}</span>
          <span className="text-zinc-600">等待 {counts.pending}</span>
        </div>

        {/* 两者混在一起会让人以为程序坏了，所以一直摆在眼前 */}
        <p className="text-xs text-zinc-600">
          跳过 = 网易不给这首歌（无版权 / 要会员 / 本地已有），属正常现象；失败 = 网络或程序出了问题。
        </p>
      </div>

      {(error || streamDown || retry.isError || cancel.isError) && (
        <div className="m-4 flex shrink-0 items-start gap-2 rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-200">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          <span>{bannerText({ error, retry, cancel })}</span>
        </div>
      )}

      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {loading && (
          <div className="flex items-center gap-2 p-6 text-sm text-zinc-400">
            <LoaderCircle className="size-4 animate-spin" /> 读取任务
          </div>
        )}

        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((row) => {
            const track = tracks[row.index];
            return (
              <div
                key={track.trackId}
                className="absolute inset-x-0 top-0 flex items-center gap-3 border-b border-zinc-900 px-4"
                style={{ height: row.size, transform: `translateY(${row.start}px)` }}
              >
                <span className="tabular w-10 shrink-0 text-right text-xs text-zinc-600">
                  {row.index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{track.name}</div>
                  {track.error && (
                    <div className="truncate text-xs text-red-400/80">{track.error}</div>
                  )}
                </div>
                <StatusBadge track={track} />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function bannerText({
  error,
  retry,
  cancel,
}: {
  error: string | null;
  retry: { isError: boolean; error: unknown };
  cancel: { isError: boolean; error: unknown };
}): string {
  // 任务本身的错误最重要，其次是刚点的那个按钮失败了，最后才是连接断开
  if (error) return error;
  if (cancel.isError) return `取消失败：${messageOf(cancel.error)}`;
  if (retry.isError) return messageOf(retry.error);
  return '进度连接断开了，刷新页面可以重新对齐状态。';
}

function StatusBadge({ track }: { track: JobTrackState }) {
  switch (track.status) {
    case 'pending':
      return (
        <span className="flex w-32 shrink-0 items-center justify-end gap-1.5 text-xs text-zinc-600">
          <Clock className="size-3.5" /> 等待
        </span>
      );
    case 'running':
      return (
        <span className="tabular flex w-32 shrink-0 items-center justify-end gap-1.5 text-xs text-sky-400">
          <LoaderCircle className="size-3.5 animate-spin" /> {formatBytes(track.bytes)}
        </span>
      );
    case 'done':
      return (
        <span className="tabular flex w-32 shrink-0 items-center justify-end gap-1.5 text-xs text-emerald-400">
          <CircleCheck className="size-3.5" /> {formatBytes(track.bytes)}
        </span>
      );
    case 'skipped':
      return (
        <span className="flex w-32 shrink-0 items-center justify-end gap-1.5 text-xs text-zinc-500">
          <Ban className="size-3.5" /> {track.reason ? SKIP_TEXT[track.reason] : '跳过'}
        </span>
      );
    case 'failed':
      return (
        <span className="flex w-32 shrink-0 items-center justify-end gap-1.5 text-xs text-red-400">
          <CircleX className="size-3.5" /> 失败
        </span>
      );
  }
}
