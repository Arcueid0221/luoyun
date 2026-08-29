import { useState } from 'react';
import { CircleAlert, LoaderCircle, LogOut } from 'lucide-react';
import { useAuthStatus, useLogout } from './hooks/useAuth.ts';
import { useSelection } from './store/selection.ts';
import { LoginPanel } from './components/LoginPanel.tsx';
import { PlaylistGrid } from './components/PlaylistGrid.tsx';
import { TrackTable } from './components/TrackTable.tsx';
import { DownloadDrawer } from './components/DownloadDrawer.tsx';
import { JobPanel } from './components/JobPanel.tsx';
import { messageOf } from './lib/format.ts';

export default function App() {
  const auth = useAuthStatus();
  const logout = useLogout();
  const playlistId = useSelection((s) => s.playlistId);
  // 任务是内存态，dev server 一重启就没了，所以不持久化 jobId
  const [jobId, setJobId] = useState<string | null>(null);

  if (auth.isPending) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-zinc-400">
        <LoaderCircle className="size-4 animate-spin" /> 正在检查登录状态
      </div>
    );
  }

  if (auth.isError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-sm">
        <div className="flex items-start gap-2 rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-red-200">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          <span>连不上本地服务：{messageOf(auth.error)}</span>
        </div>
        <button
          type="button"
          onClick={() => void auth.refetch()}
          className="rounded-lg border border-zinc-700 px-3 py-1.5 text-zinc-300 hover:border-zinc-500"
        >
          重试
        </button>
      </div>
    );
  }

  if (!auth.data?.authenticated) {
    // cookie 过期时后端会在 error 里说清楚，直接透给登录页
    return <LoginPanel notice={auth.data?.error} />;
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-zinc-800 px-4 py-2.5">
        <span className="text-sm font-semibold tracking-tight">落云</span>
        <span className="text-xs text-zinc-600">网易云歌单批量下载</span>

        <div className="ml-auto flex items-center gap-2.5">
          {auth.data.avatarUrl && (
            <img
              src={auth.data.avatarUrl}
              alt=""
              referrerPolicy="no-referrer"
              className="size-6 rounded-full border border-zinc-700"
            />
          )}
          <span className="text-sm text-zinc-300">{auth.data.nickname}</span>
          <button
            type="button"
            onClick={() => logout.mutate()}
            title="退出并删除本地的 MUSIC_U"
            className="rounded p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
          >
            <LogOut className="size-4" />
          </button>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-hidden">
        {jobId ? (
          <JobPanel jobId={jobId} onClose={() => setJobId(null)} onStarted={setJobId} />
        ) : playlistId ? (
          // key 让换歌单时整个组件重挂：搜索框里的关键词和滚动位置都是上一个歌单的，
          // 留着会让人以为新歌单只有几首歌
          <TrackTable key={playlistId} />
        ) : (
          <PlaylistGrid />
        )}
      </main>

      {playlistId && !jobId && <DownloadDrawer onStarted={setJobId} />}
    </div>
  );
}
