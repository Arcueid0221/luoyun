import { getPlaylistDetail, getUserPlaylists } from '../core/api/playlist.ts';
import { requireAuth } from './auth.ts';
import type { Route } from '../http.ts';

export const playlistRoutes: Route[] = [
  [
    'GET',
    '/api/playlists',
    () => {
      requireAuth();
      return getUserPlaylists();
    },
  ],

  [
    'GET',
    '/api/playlists/:id',
    (ctx) => {
      requireAuth();
      // 内部会补齐 1000 首以外的部分，两千首的歌单可能要几秒
      return getPlaylistDetail(ctx.params.id);
    },
  ],
];
