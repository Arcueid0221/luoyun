import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HttpError, type Route } from '../http.ts';
import { requireAuth } from './auth.ts';

/**
 * 家目录的真实路径。
 *
 * 所有路径检查都拿它当边界，所以它自己也必须是解过符号链接的：
 * 边界带着链接、目标解过链接的话，两边根本没法比。
 */
export function homeDir(): string {
  return realpathOfExisting(os.homedir());
}

export function defaultDownloadDir(): string {
  return path.join(homeDir(), 'Music', 'luoyun');
}

/**
 * 目录必须落在家目录以内。
 *
 * 这个 dev server 能读写任何它有权限的路径，前端传进来的字符串是不可信的：
 * 没有这道检查，`../../etc` 或绝对路径 `/` 就能让它到处乱写。
 *
 * 三个细节都是必须的：
 *   - 相对路径按**家目录**展开，不是 `process.cwd()`。按 cwd 展开的话
 *     `destDir: "src"` 会通过检查并把音频写进项目仓库里，
 *     落在 `server/` 下面还会触发 Vite 重启、把内存里的任务全清掉。
 *   - `realpathSync`：`path.resolve` 是纯字符串运算，不认符号链接。
 *     家目录里有个 `~/tmp -> /private/tmp` 就能让读和写都跑到家目录外面去。
 *   - `..` 的判断要精确到路径分隔符，否则家目录下一个正经的 `..foo` 目录会被误拒。
 */
export function safeDir(input: string): string {
  const home = homeDir();
  // 不写成 `input ?? ''`：body 里塞个数字过来的话 .trim() 会抛 TypeError（→ 500）
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) throw new HttpError(400, '目录不能为空');

  const expanded = raw === '~' || raw.startsWith('~/') ? path.join(home, raw.slice(1)) : raw;
  const resolved = path.isAbsolute(expanded)
    ? path.normalize(expanded)
    : path.resolve(home, expanded);

  // 目标常常还不存在（第一次下载），所以对"存在的最深一段"求真实路径，
  // 剩下的尾巴按字符串拼回去 —— 还不存在的路径不可能是符号链接。
  const real = realpathOfExisting(resolved);

  const rel = path.relative(home, real);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new HttpError(400, '目录必须在家目录以内');
  }
  return real;
}

function realpathOfExisting(target: string): string {
  let head = target;
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(head), ...tail);
    } catch {
      const parent = path.dirname(head);
      // 一直到根都解不开（不该发生），原样返回，交给上面的前缀检查
      if (parent === head) return target;
      tail.unshift(path.basename(head));
      head = parent;
    }
  }
}

// 两个路由都要求已登录。不是因为它们碰网易云，而是因为它们把本机的目录结构
// 交出去：没这行的话，本机任何一个页面都能靠 /api/fs/list 一层层列出整个家目录。
export const fsRoutes: Route[] = [
  [
    'GET',
    '/api/fs/default',
    () => {
      requireAuth();
      return { path: defaultDownloadDir(), home: homeDir() };
    },
  ],

  [
    'GET',
    '/api/fs/list',
    (ctx) => {
      requireAuth();
      const home = homeDir();
      const dir = safeDir(ctx.url.searchParams.get('path') || home);
      if (!fs.existsSync(dir)) throw new HttpError(404, '目录不存在');
      if (!fs.statSync(dir).isDirectory()) throw new HttpError(400, '这不是一个目录');

      // 只列目录不列文件 —— 这是个"选下载到哪儿"的选择器，
      // 顺带也避免把家目录里的文件名全暴露给前端
      const dirs = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b, 'zh'));

      return { path: dir, parent: dir === home ? null : path.dirname(dir), home, dirs };
    },
  ],
];
