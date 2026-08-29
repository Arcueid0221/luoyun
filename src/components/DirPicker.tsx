import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CircleAlert, CornerLeftUp, Folder, House, LoaderCircle } from 'lucide-react';
import { get } from '../api/client.ts';
import { joinPath, messageOf, tildify } from '../lib/format.ts';

interface DirListing {
  path: string;
  parent: string | null;
  home: string;
  dirs: string[];
}

interface Props {
  /** 打开时停在这个目录 */
  value: string;
  onPick(dir: string): void;
  onClose(): void;
}

export function DirPicker({ value, onPick, onClose }: Props) {
  const [cwd, setCwd] = useState(value);

  const listing = useQuery({
    queryKey: ['fs', cwd],
    queryFn: () => get<DirListing>(`/api/fs/list?path=${encodeURIComponent(cwd)}`),
    retry: false,
  });

  const data = listing.data;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-zinc-800 px-4 py-3">
          <button
            type="button"
            onClick={() => data?.parent && setCwd(data.parent)}
            disabled={!data?.parent}
            title="上一级"
            className="rounded p-1.5 text-zinc-400 enabled:hover:bg-zinc-800 enabled:hover:text-zinc-100 disabled:opacity-30"
          >
            <CornerLeftUp className="size-4" />
          </button>
          <button
            type="button"
            onClick={() => data?.home && setCwd(data.home)}
            title="回到家目录"
            className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          >
            <House className="size-4" />
          </button>
          <span className="truncate font-mono text-xs text-zinc-300">
            {tildify(cwd, data?.home)}
          </span>
        </div>

        <div className="min-h-40 flex-1 overflow-y-auto p-2">
          {listing.isPending && (
            <div className="flex items-center gap-2 p-3 text-sm text-zinc-400">
              <LoaderCircle className="size-4 animate-spin" /> 读取中
            </div>
          )}

          {listing.isError && (
            <div className="m-2 space-y-2 rounded-lg border border-red-900/60 bg-red-950/40 p-3 text-sm text-red-200">
              <div className="flex items-start gap-2">
                <CircleAlert className="mt-0.5 size-4 shrink-0" />
                <span>{messageOf(listing.error)}</span>
              </div>
              {/* 默认目录 ~/Music/luoyun 第一次用时还不存在，这里给一条退路 */}
              <button
                type="button"
                onClick={() => setCwd('~')}
                className="rounded border border-red-800 px-2 py-1 text-xs hover:bg-red-900/40"
              >
                回到家目录
              </button>
            </div>
          )}

          {data?.dirs.length === 0 && (
            <div className="p-3 text-sm text-zinc-500">这个目录下没有子文件夹</div>
          )}

          {data?.dirs.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => setCwd(joinPath(data.path, name))}
              className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm text-zinc-200 hover:bg-zinc-800"
            >
              <Folder className="size-4 shrink-0 text-zinc-500" />
              <span className="truncate">{name}</span>
            </button>
          ))}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-zinc-800 px-4 py-3">
          <span className="text-xs text-zinc-500">只能选家目录以内的位置</span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:border-zinc-500"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => onPick(data?.path ?? cwd)}
              className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500"
            >
              选这里
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
