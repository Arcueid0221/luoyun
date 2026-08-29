import type { Route } from '../http.ts';
import { authRoutes } from './auth.ts';
import { playlistRoutes } from './playlists.ts';
import { trackRoutes } from './tracks.ts';
import { downloadRoutes } from './download.ts';
import { fsRoutes } from './fs.ts';

// 顺序无关：matchRoute 要求段数和字面量完全对上，
// 不存在"前面的模式吃掉后面的"这种问题。
export const routes: Route[] = [
  ...authRoutes,
  ...playlistRoutes,
  ...trackRoutes,
  ...downloadRoutes,
  ...fsRoutes,
];
