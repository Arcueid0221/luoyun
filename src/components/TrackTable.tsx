import { useDeferredValue, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  ArrowLeft,
  CircleAlert,
  ListChecks,
  LoaderCircle,
  Search,
  Square,
  SquareCheck,
  SquareMinus,
  X,
} from 'lucide-react';
import { usePlaylistDetail } from '../hooks/usePlaylists.ts';
import { useSelection } from '../store/selection.ts';
import { filterTracks } from '../lib/search.ts';
import { formatDuration, messageOf } from '../lib/format.ts';

const ROW_HEIGHT = 44;

export function TrackTable() {
  const playlistId = useSelection((s) => s.playlistId);
  const selected = useSelection((s) => s.selected);
  const toggle = useSelection((s) => s.toggle);
  const selectAll = useSelection((s) => s.selectAll);
  const invert = useSelection((s) => s.invert);
  const deselect = useSelection((s) => s.deselect);
  const clear = useSelection((s) => s.clear);
  const openPlaylist = useSelection((s) => s.openPlaylist);

  const { data, isPending, isError, error } = usePlaylistDetail(playlistId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const tracks = data?.tracks ?? [];

  // 关键词是纯视图状态，故意不进 store、不 persist：改 server/ 下任何文件都会让
  // Vite 整页刷新，一个被记住的关键词会让人以为歌单里的歌自己少了。
  const [query, setQuery] = useState('');
  // 上万首的歌单里一边打字一边过滤，deferred 让输入框先响应、过滤晚一帧
  const deferredQuery = useDeferredValue(query);
  const filtering = deferredQuery.trim().length > 0;
  const hits = useMemo(() => filterTracks(tracks, deferredQuery), [tracks, deferredQuery]);

  // 上千首歌全渲染成 DOM 会直接卡死，只渲染可视区那几十行
  const virtualizer = useVirtualizer({
    count: hits.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
    // 行的身份是 trackId 而不是"第几行"：换个关键词，同一个下标就是另一首歌了
    getItemKey: (index) => hits[index]?.track.id ?? index,
  });

  // 换关键词就回到顶部。本来滚在第 900 行、筛出 12 行之后容器只剩 528px 高，
  // 虚拟窗口还按旧偏移算，第一帧看到的是筛选结果的尾巴（或者一片空白）。
  // 走 virtualizer 的方法而不是直接改 scrollTop：它会把内部记的偏移一起改掉，
  // 不用等浏览器把 scroll 事件派发回来。
  useLayoutEffect(() => {
    virtualizer.scrollToOffset(0);
  }, [deferredQuery, virtualizer]);

  // 工具条三个按钮的作用域 = 当前筛出来的这些，不是整个歌单
  const ids = hits.map((hit) => hit.track.id);

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-zinc-800 px-4 py-3">
        <button
          type="button"
          onClick={() => openPlaylist(null)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 hover:border-zinc-500"
        >
          <ArrowLeft className="size-3.5" />
          歌单
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{data?.name ?? '读取中'}</div>
          <div className="tabular text-xs text-zinc-500">
            {!data
              ? ''
              : filtering
                ? `筛出 ${hits.length} 首 / 共 ${tracks.length} 首`
                : `${tracks.length} / ${data.trackCount} 首`}
          </div>
        </div>
      </div>

      <div className="shrink-0 border-b border-zinc-800 px-4 py-2">
        {/* 图标和清除按钮按输入框定位，所以要单独包一层 relative */}
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-zinc-500" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setQuery('');
            }}
            placeholder="搜歌名 / 歌手 / 专辑，多个关键词用空格分开"
            aria-label="在这个歌单里搜索"
            // 浏览器的自动补全下拉会挡住列表，关掉
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 py-1.5 pl-8 pr-9 text-sm outline-none placeholder:text-zinc-600 focus:border-emerald-600"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              title="清除关键词（Esc）"
              aria-label="清除关键词"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-zinc-800 px-4 py-2">
        <button
          type="button"
          onClick={() => selectAll(ids)}
          title={filtering ? '把筛出来的这些加进勾选，已勾的不动' : '勾上整个歌单'}
          className="inline-flex items-center gap-1.5 rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:border-zinc-500"
        >
          <SquareCheck className="size-3.5" /> 全选{filtering ? ` ${hits.length}` : ''}
        </button>
        <button
          type="button"
          onClick={() => invert(ids)}
          title={filtering ? '只翻转筛出来的这些' : '翻转整个歌单'}
          className="inline-flex items-center gap-1.5 rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:border-zinc-500"
        >
          <ListChecks className="size-3.5" /> 反选{filtering ? ` ${hits.length}` : ''}
        </button>
        {/* 搜索状态下才有意义：不搜的时候它和"清空"是一回事 */}
        {filtering && (
          <button
            type="button"
            onClick={() => deselect(ids)}
            title="从勾选里去掉筛出来的这些"
            className="inline-flex items-center gap-1.5 rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:border-zinc-500"
          >
            <SquareMinus className="size-3.5" /> 取消 {hits.length}
          </button>
        )}
        <button
          type="button"
          onClick={clear}
          className="inline-flex items-center gap-1.5 rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:border-zinc-500"
        >
          <Square className="size-3.5" /> 清空{filtering ? '全部' : ''}
        </button>
        <span className="tabular ml-auto text-xs text-zinc-400">
          已选 {selected.size} 首{selected.size === 0 ? '（不选 = 整个歌单）' : ''}
        </span>
      </div>

      {/* 搜索只筛显示，不改"不勾任何歌 = 整个歌单"这条规则。
          筛出 12 首、一首没勾就点开始，下的是整个歌单 —— 这一步必须说出来 */}
      {filtering && selected.size === 0 && hits.length > 0 && (
        <p className="shrink-0 border-b border-zinc-800 bg-amber-950/20 px-4 py-1.5 text-xs text-amber-400/90">
          搜索只是筛掉了显示。这样直接开始下的是整个歌单（{tracks.length} 首）；
          只想要筛出来的这 {hits.length} 首，先点"全选 {hits.length}"。
        </p>
      )}

      <div className="flex shrink-0 gap-3 border-b border-zinc-800 px-4 py-1.5 text-xs text-zinc-500">
        <span className="w-5" />
        <span className="w-10 text-right" title="歌单里的序号，也是落盘目录的前缀；筛选时会跳号">
          #
        </span>
        <span className="flex-1">歌名</span>
        <span className="hidden w-40 sm:block">歌手</span>
        <span className="hidden w-48 lg:block">专辑</span>
        <span className="w-12 text-right">时长</span>
      </div>

      {/* 和下面的 isError 一样必须留在滚动容器外面 */}
      {filtering && hits.length === 0 && !isPending && (
        <p className="shrink-0 px-4 py-6 text-sm text-zinc-500">
          没有匹配"{deferredQuery.trim()}"的歌。搜索只看歌名、歌手和专辑，不看歌词。
        </p>
      )}

      {/* 必须留在滚动容器外面：虚拟行是相对容器绝对定位的，
          banner 挤在里面会把所有行整体推下去、和滚动偏移错开一个 banner 的高度 */}
      {isError && (
        <div className="m-4 flex shrink-0 items-start gap-2 rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-200">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          <span>{messageOf(error)}</span>
        </div>
      )}

      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {isPending && (
          <div className="flex items-center gap-2 p-6 text-sm text-zinc-400">
            <LoaderCircle className="size-4 animate-spin" />
            正在读取曲目（超过 1000 首的歌单要分批补详情，会慢一点）
          </div>
        )}

        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((row) => {
            // 关键词刚变的那一帧，虚拟器可能还拿着上一轮更长列表的行下标
            const hit = hits[row.index];
            if (!hit) return null;
            // index 是歌单里的原始位置；row.index 只是"筛选结果里的第几行"
            const { track, index } = hit;
            const checked = selected.has(track.id);
            return (
              <label
                key={track.id}
                className={`absolute inset-x-0 top-0 flex cursor-pointer items-center gap-3 px-4 text-sm ${
                  checked ? 'bg-emerald-950/40' : 'hover:bg-zinc-900'
                }`}
                style={{ height: row.size, transform: `translateY(${row.start}px)` }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(track.id)}
                  className="size-4 shrink-0 accent-emerald-500"
                />
                <span className="tabular w-10 shrink-0 text-right text-xs text-zinc-500">
                  {index + 1}
                </span>
                <span className="flex-1 truncate">{track.name}</span>
                <span className="hidden w-40 shrink-0 truncate text-zinc-400 sm:block">
                  {track.artists.map((a) => a.name).join(', ')}
                </span>
                <span className="hidden w-48 shrink-0 truncate text-zinc-500 lg:block">
                  {track.album.name}
                </span>
                <span className="tabular w-12 shrink-0 text-right text-xs text-zinc-500">
                  {formatDuration(track.duration)}
                </span>
              </label>
            );
          })}
        </div>
      </div>
    </div>
  );
}
