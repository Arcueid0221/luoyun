import { CircleAlert, ListMusic, LoaderCircle, RefreshCw } from 'lucide-react';
import { usePlaylists } from '../hooks/usePlaylists.ts';
import { useSelection } from '../store/selection.ts';
import { messageOf } from '../lib/format.ts';

export function PlaylistGrid() {
  const { data, isPending, isError, error, refetch, isFetching } = usePlaylists();
  const openPlaylist = useSelection((s) => s.openPlaylist);

  if (isPending) {
    return (
      <div className="flex items-center gap-2 p-8 text-sm text-zinc-400">
        <LoaderCircle className="size-4 animate-spin" /> 正在读取歌单
      </div>
    );
  }

  if (isError) {
    return (
      <div className="m-6 flex items-start gap-2 rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-200">
        <CircleAlert className="mt-0.5 size-4 shrink-0" />
        <span>{messageOf(error)}</span>
      </div>
    );
  }

  const playlists = data ?? [];

  return (
    <div className="h-full space-y-4 overflow-y-auto p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-sm text-zinc-400">
          共 {playlists.length} 个歌单（含收藏的）
        </h2>
        <button
          type="button"
          onClick={() => void refetch()}
          className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 hover:border-zinc-500"
        >
          <RefreshCw className={`size-3.5 ${isFetching ? 'animate-spin' : ''}`} />
          刷新
        </button>
      </div>

      {playlists.length === 0 && (
        <p className="text-sm text-zinc-500">这个账号下没有歌单。</p>
      )}

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {playlists.map((playlist) => (
          <button
            key={playlist.id}
            type="button"
            onClick={() => openPlaylist(playlist.id)}
            className="group space-y-2 text-left"
          >
            <div className="aspect-square overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900">
              {playlist.coverUrl ? (
                <img
                  src={playlist.coverUrl}
                  alt=""
                  loading="lazy"
                  // 网易的图床对 Referer 不挑，但不发更省事也更干净
                  referrerPolicy="no-referrer"
                  className="size-full object-cover transition group-hover:scale-105"
                />
              ) : (
                <div className="flex size-full items-center justify-center text-zinc-700">
                  <ListMusic className="size-8" />
                </div>
              )}
            </div>
            <div className="space-y-0.5">
              <div className="line-clamp-2 text-sm font-medium text-zinc-100 group-hover:text-emerald-400">
                {playlist.name}
              </div>
              <div className="tabular text-xs text-zinc-500">
                {playlist.trackCount} 首
                {playlist.creator ? ` · ${playlist.creator.name}` : ''}
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
