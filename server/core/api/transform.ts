import type { Track } from '../types.ts';

// neteasecli 里 transformTrack 被复制了四份（track/playlist/user/search），
// 改一处就得改四处。这里只留一份。

/** 网易返回的歌曲对象。ar/al 是新字段，artists/album 是老字段，两套都可能出现。 */
export interface RawTrack {
  id: number;
  name: string;
  ar?: { id: number; name: string }[];
  al?: { id: number; name: string; picUrl?: string };
  artists?: { id: number; name: string }[];
  album?: { id: number; name: string; picUrl?: string };
  dt?: number;
  duration?: number;
  /** 0 免费 / 1 VIP / 4 单曲付费 / 8 低音质免费。仅供提示，真实可用性看 url 接口 */
  fee?: number;
  publishTime?: number;
}

/** 网易有时返回 http:// 的图片地址，统一升到 https，否则前端混合内容会被拦 */
function toHttps(url?: string): string | undefined {
  if (!url) return undefined;
  return url.startsWith('http://') ? `https:${url.slice(5)}` : url;
}

export function transformTrack(raw: RawTrack): Track {
  const artists = raw.ar || raw.artists || [];
  const album = raw.al || raw.album || { id: 0, name: '' };
  return {
    id: String(raw.id),
    name: raw.name,
    artists: artists.map((a) => ({ id: String(a.id), name: a.name })),
    album: {
      id: String(album.id),
      name: album.name,
      picUrl: toHttps(album.picUrl),
    },
    duration: raw.dt || raw.duration || 0,
    uri: `netease:track:${raw.id}`,
  };
}

/**
 * 网易的 picUrl 默认给的是缩略图（列表里够用，存本地就太小了）。
 * 加 ?param=1000y1000 才是原图尺寸。
 */
export function coverUrl(picUrl?: string, size = 1000): string | undefined {
  const url = toHttps(picUrl);
  if (!url) return undefined;
  if (url.includes('?')) return url;
  return `${url}?param=${size}y${size}`;
}
