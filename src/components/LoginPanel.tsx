import { useEffect, useRef, useState, type FormEvent } from 'react';
import { CircleAlert, ExternalLink, Globe, KeyRound, LoaderCircle, X } from 'lucide-react';
import {
  useImportFromBrowser,
  useLoginByCookie,
  usePollBrowserLogin,
} from '../hooks/useAuth.ts';
import { messageOf } from '../lib/format.ts';

const NETEASE_LOGIN_URL = 'https://music.163.com/#/login';
const BROWSER_LOGIN_POLL_MS = 3000;
const BROWSER_LOGIN_TIMEOUT_MS = 2 * 60 * 1000;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

// 这是用户第一眼看到的东西。说明写清楚比界面好看重要得多。
const STEPS = [
  '用浏览器登录 music.163.com（网页版，不是客户端）',
  '打开开发者工具：Chrome / Edge 按 F12 或 ⌥⌘I，Safari 需要先在"设置 → 高级"里勾上"显示网页开发者功能"',
  'Chrome / Edge 切到 Application 面板，Safari 切到"存储"面板',
  '左侧展开 Cookies，点 https://music.163.com',
  '找到名字是 MUSIC_U 的那一行，双击它的 Value 全选复制',
  '粘到下面的输入框。整条 Cookie 头一起粘也行，会自动挑出 MUSIC_U',
];

export function LoginPanel({ notice }: { notice?: string }) {
  const [value, setValue] = useState('');
  const [browserLoginActive, setBrowserLoginActive] = useState(false);
  const [browserLoginNotice, setBrowserLoginNotice] = useState<string>();
  const browserLoginAttempt = useRef(0);
  const login = useLoginByCookie();
  const importFromBrowser = useImportFromBrowser();
  const pollBrowserLogin = usePollBrowserLogin();
  const error = login.error ?? importFromBrowser.error ?? pollBrowserLogin.error;
  const busy = login.isPending || importFromBrowser.isPending || browserLoginActive;

  useEffect(() => {
    return () => {
      browserLoginAttempt.current += 1;
    };
  }, []);

  function submit(event: FormEvent) {
    event.preventDefault();
    const musicU = value.trim();
    if (!musicU || busy) return;
    // 提交完立刻从 state 里抹掉，不让这把钥匙在内存里多待一秒
    setValue('');
    login.mutate(musicU);
  }

  async function startBrowserLogin() {
    const attempt = browserLoginAttempt.current + 1;
    browserLoginAttempt.current = attempt;

    const loginWindow = window.open(NETEASE_LOGIN_URL, '_blank');
    if (loginWindow) loginWindow.opener = null;

    setBrowserLoginActive(true);
    setBrowserLoginNotice(
      loginWindow
        ? '已打开网易云登录页。完成登录后保持此页面打开，落云会自动检测。'
        : '登录页可能被浏览器拦截。请点击下面的备用链接打开，落云会继续自动检测。',
    );

    const deadline = Date.now() + BROWSER_LOGIN_TIMEOUT_MS;
    while (browserLoginAttempt.current === attempt && Date.now() < deadline) {
      try {
        const result = await pollBrowserLogin.mutateAsync();
        if (result.state === 'authenticated') {
          setBrowserLoginNotice('已检测到网易云登录，会话验证成功。');
          setBrowserLoginActive(false);
          return;
        }
      } catch (pollError) {
        if (browserLoginAttempt.current !== attempt) return;
        setBrowserLoginNotice(`自动检测已停止：${messageOf(pollError)}`);
        setBrowserLoginActive(false);
        return;
      }
      await wait(BROWSER_LOGIN_POLL_MS);
    }

    if (browserLoginAttempt.current !== attempt) return;
    setBrowserLoginActive(false);
    setBrowserLoginNotice('两分钟内没有检测到有效登录。可以重新开始，或使用下方备用方式。');
  }

  function cancelBrowserLogin() {
    browserLoginAttempt.current += 1;
    setBrowserLoginActive(false);
    setBrowserLoginNotice('已停止自动检测。');
  }

  return (
    <div className="mx-auto flex min-h-full max-w-3xl flex-col justify-center gap-8 px-6 py-12">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">落云</h1>
        <p className="text-sm text-zinc-400">
          把网易云歌单里的音频、封面、歌词和简介落到本地磁盘。可直接使用网易云网页登录。
        </p>
      </header>

      {/* 之前登录过但 cookie 失效时，后端的原话比"请登录"有用得多 */}
      {notice && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-sm text-amber-200">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          <span>{notice}</span>
        </div>
      )}

      <section className="space-y-3 rounded-xl border border-emerald-900/70 bg-emerald-950/20 p-5">
        <div className="space-y-1">
          <h2 className="text-sm font-medium text-emerald-100">推荐：网易云网页登录</h2>
          <p className="text-sm text-zinc-400">
            打开网易云官方页面并使用它提供的登录方式。登录完成后，落云会从本机浏览器自动读取并验证会话。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void startBrowserLogin()}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white enabled:hover:bg-emerald-500 disabled:opacity-40"
          >
            {browserLoginActive ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <ExternalLink className="size-4" />
            )}
            {browserLoginActive ? '正在等待登录' : '打开网易云并自动登录'}
          </button>
          {browserLoginActive && (
            <button
              type="button"
              onClick={cancelBrowserLogin}
              className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:border-zinc-500"
            >
              <X className="size-4" />
              停止检测
            </button>
          )}
          <a
            href={NETEASE_LOGIN_URL}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-zinc-500 underline decoration-zinc-700 underline-offset-4 hover:text-zinc-300"
          >
            手动打开官方登录页
          </a>
        </div>
        {browserLoginNotice && (
          <p className="text-xs leading-5 text-zinc-400">{browserLoginNotice}</p>
        )}
        <p className="text-xs text-zinc-600">
          首次读取 Chrome、Edge、Safari 或 Firefox 时，macOS 可能请求钥匙串或文件访问授权。
        </p>
      </section>

      <form onSubmit={submit} className="space-y-3">
        <label htmlFor="music-u" className="flex items-center gap-2 text-sm font-medium">
          <KeyRound className="size-4 text-zinc-400" />
          备用：手动输入 MUSIC_U
        </label>
        <input
          id="music-u"
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          placeholder="粘贴 MUSIC_U 的值，或整条 Cookie"
          className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 font-mono text-sm outline-none placeholder:text-zinc-600 focus:border-emerald-600"
        />
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={busy || !value.trim()}
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white enabled:hover:bg-emerald-500 disabled:opacity-40"
          >
            {login.isPending && <LoaderCircle className="size-4 animate-spin" />}
            登录
          </button>
          <button
            type="button"
            onClick={() => importFromBrowser.mutate(undefined)}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-300 enabled:hover:border-zinc-500 disabled:opacity-40"
          >
            {importFromBrowser.isPending ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <Globe className="size-4" />
            )}
            从已登录浏览器读取一次
          </button>
          <span className="text-xs text-zinc-500">
            适合浏览器已经登录，但自动检测已停止的情况
          </span>
        </div>
      </form>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-200">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          <div className="whitespace-pre-wrap">
            {messageOf(error)}
            {login.isError && <div className="mt-1 text-red-300/70">输入框已清空，请重新粘贴。</div>}
          </div>
        </div>
      )}

      <section className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
        <h2 className="text-sm font-medium text-zinc-300">怎么找到 MUSIC_U</h2>
        <ol className="list-decimal space-y-1.5 pl-5 text-sm text-zinc-400">
          {STEPS.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <p className="border-t border-zinc-800 pt-3 text-xs text-zinc-500">
          MUSIC_U 等于你的账号本身 —— 拿着它能改密码、清歌单、发评论。落云只把它存在
          <code className="mx-1 rounded bg-zinc-800 px-1 py-0.5">~/.config/luoyun/session.json</code>
          （权限 0600），永远不下发给页面，也不会写进日志。别把它贴到任何别的地方。
        </p>
      </section>
    </div>
  );
}
