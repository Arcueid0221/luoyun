import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CircleAlert, Download, FolderOpen, LoaderCircle } from 'lucide-react';
import { get } from '../api/client.ts';
import { useStartDownload } from '../hooks/useJob.ts';
import { anyPartSelected, useSelection } from '../store/selection.ts';
import { messageOf, tildify } from '../lib/format.ts';
import { DirPicker } from './DirPicker.tsx';
import { DOWNLOAD_PARTS, QUALITIES, type DownloadPart, type Quality } from '../../server/core/types.ts';

const PART_LABELS: Record<DownloadPart, string> = {
  audio: '音频',
  cover: '封面',
  lyric: '歌词',
  info: '简介',
};

// 会员档位下不下来是常态，标出来免得以为是程序坏了
const QUALITY_LABELS: Record<Quality, string> = {
  standard: '标准 128k',
  higher: '较高 192k',
  exhigh: '极高 320k',
  lossless: '无损 FLAC（需黑胶 VIP）',
  hires: 'Hi-Res（需黑胶 VIP）',
  jymaster: '超清母带（需 SVIP）',
};

interface Props {
  onStarted(jobId: string): void;
}

export function DownloadDrawer({ onStarted }: Props) {
  const { playlistId, selected, parts, quality, destDir, setPart, setQuality, setDestDir } =
    useSelection();
  const [force, setForce] = useState(false);
  const [picking, setPicking] = useState(false);
  const start = useStartDownload();

  const defaults = useQuery({
    queryKey: ['fs-default'],
    queryFn: () => get<{ path: string; home: string }>('/api/fs/default'),
    staleTime: Infinity,
  });

  // 第一次进来 destDir 是空的，用后端给的 ~/Music/luoyun 填上
  useEffect(() => {
    if (!destDir && defaults.data) setDestDir(defaults.data.path);
  }, [destDir, defaults.data, setDestDir]);

  const ready = !!playlistId && !!destDir && anyPartSelected(parts) && !start.isPending;

  function submit() {
    if (!ready || !playlistId) return;
    start.mutate(
      {
        playlistId,
        // 不勾任何歌 = 整个歌单
        trackIds: selected.size > 0 ? [...selected] : undefined,
        parts,
        quality,
        destDir,
        force,
      },
      { onSuccess: (result) => onStarted(result.jobId) },
    );
  }

  return (
    <div className="shrink-0 space-y-3 border-t border-zinc-800 bg-zinc-900/60 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <div className="flex items-center gap-3">
          {DOWNLOAD_PARTS.map((part) => (
            <label key={part} className="flex cursor-pointer items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={parts[part]}
                onChange={(e) => setPart(part, e.target.checked)}
                className="size-4 accent-emerald-500"
              />
              {PART_LABELS[part]}
            </label>
          ))}
        </div>

        <label className="flex items-center gap-2 text-sm">
          <span className="text-zinc-400">音质</span>
          <select
            value={quality}
            onChange={(e) => setQuality(e.target.value as Quality)}
            className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm outline-none focus:border-emerald-600"
          >
            {QUALITIES.map((q) => (
              <option key={q} value={q}>
                {QUALITY_LABELS[q]}
              </option>
            ))}
          </select>
        </label>

        <label className="flex cursor-pointer items-center gap-1.5 text-sm text-zinc-400">
          <input
            type="checkbox"
            checked={force}
            onChange={(e) => setForce(e.target.checked)}
            className="size-4 accent-emerald-500"
          />
          忽略已下记录，全部重下
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setPicking(true)}
          className="inline-flex min-w-0 items-center gap-2 rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs hover:border-zinc-500"
        >
          <FolderOpen className="size-3.5 shrink-0 text-zinc-400" />
          <span className="truncate font-mono">
            {destDir ? tildify(destDir, defaults.data?.home) : '选择目录'}
          </span>
        </button>

        <button
          type="button"
          onClick={submit}
          disabled={!ready}
          className="ml-auto inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white enabled:hover:bg-emerald-500 disabled:opacity-40"
        >
          {start.isPending ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <Download className="size-4" />
          )}
          开始下载{selected.size > 0 ? ` ${selected.size} 首` : '整个歌单'}
        </button>
      </div>

      {!anyPartSelected(parts) && (
        <p className="text-xs text-amber-400">至少要勾一项内容。</p>
      )}

      {start.isError && (
        <div className="flex items-start gap-2 rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-200">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          <span>{messageOf(start.error)}</span>
        </div>
      )}

      {picking && (
        <DirPicker
          value={destDir || defaults.data?.path || '~'}
          onPick={(dir) => {
            setDestDir(dir);
            setPicking(false);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}
