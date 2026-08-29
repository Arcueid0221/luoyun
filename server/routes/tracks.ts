import { getLyric, getTrackDetail } from '../core/api/track.ts';
import { getAlbumDescription, getArtistDescription } from '../core/api/album.ts';
import { requireAuth } from './auth.ts';
import type { Route } from '../http.ts';
import type { SongInfo } from '../core/types.ts';

export const trackRoutes: Route[] = [
  [
    'GET',
    '/api/tracks/:id/lyric',
    (ctx) => {
      requireAuth();
      return getLyric(ctx.params.id);
    },
  ],

  // 给"下载前先看一眼简介"用，和 info.json 的内容一致
  [
    'GET',
    '/api/tracks/:id/info',
    async (ctx) => {
      requireAuth();
      const detail = await getTrackDetail(ctx.params.id);
      const info: SongInfo = {
        track: detail.track,
        publishTime: detail.publishTime,
        albumDescription: await getAlbumDescription(detail.track.album.id),
        artistDescription: await getArtistDescription(detail.track.artists[0]?.id ?? ''),
      };
      return info;
    },
  ],
];
