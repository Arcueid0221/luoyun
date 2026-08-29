import { getApiClient } from '../client.ts';
import { debug, verbose } from '../logger.ts';

// 全新文件，neteasecli 没有对应实现。
// 这两个端点属于"待验证"项：拿不到就返回 undefined，绝不能让一首歌下载失败。

interface NeteaseAlbumResponse {
  code: number;
  album?: {
    id: number;
    name: string;
    description?: string;
    briefDesc?: string;
  } | null;
}

interface NeteaseArtistIntroResponse {
  code: number;
  briefDesc?: string;
  introduction?: { ti?: string; txt?: string }[];
}

// 缓存的是 Promise 而不是结果值。
// 一个歌单里同专辑的歌通常连着好几首，并发跑起来会同时命中；
// 存 Promise 才能让它们合并成一次请求，存结果值只能挡住后来者。
const albumCache = new Map<string, Promise<string | undefined>>();
const artistCache = new Map<string, Promise<string | undefined>>();

async function fetchAlbumDescription(albumId: string): Promise<string | undefined> {
  try {
    const client = getApiClient();
    const response = await client.request<NeteaseAlbumResponse>(`/v1/album/${albumId}`);
    const desc = response.album?.description || response.album?.briefDesc;
    return desc?.trim() || undefined;
  } catch (error) {
    debug(`专辑简介获取失败 ${albumId}: ${error instanceof Error ? error.message : error}`);
    return undefined;
  }
}

async function fetchArtistDescription(artistId: string): Promise<string | undefined> {
  try {
    const client = getApiClient();
    const response = await client.request<NeteaseArtistIntroResponse>('/artist/introduction', {
      id: artistId,
    });
    if (response.briefDesc?.trim()) return response.briefDesc.trim();
    const sections = (response.introduction ?? [])
      .map((s) => [s.ti?.trim(), s.txt?.trim()].filter(Boolean).join('\n'))
      .filter(Boolean);
    return sections.length ? sections.join('\n\n') : undefined;
  } catch (error) {
    debug(`歌手简介获取失败 ${artistId}: ${error instanceof Error ? error.message : error}`);
    return undefined;
  }
}

export function getAlbumDescription(albumId: string): Promise<string | undefined> {
  // 只有这个 id 是拼进 URL 路径的（歌手 id 走 data 字段），所以在这里就要求纯数字：
  // 现在所有调用方传的都是网易自己返回的数字 id，但这个前提不该靠"所有调用方都记得"来维持
  if (!/^\d+$/.test(albumId) || albumId === '0') return Promise.resolve(undefined);
  let p = albumCache.get(albumId);
  if (!p) {
    verbose(`拉取专辑简介 ${albumId}`);
    p = fetchAlbumDescription(albumId);
    albumCache.set(albumId, p);
  }
  return p;
}

export function getArtistDescription(artistId: string): Promise<string | undefined> {
  if (!artistId || artistId === '0') return Promise.resolve(undefined);
  let p = artistCache.get(artistId);
  if (!p) {
    verbose(`拉取歌手简介 ${artistId}`);
    p = fetchArtistDescription(artistId);
    artistCache.set(artistId, p);
  }
  return p;
}

/** 换账号 / 登出后清掉，避免跨会话串数据 */
export function clearDescriptionCache(): void {
  albumCache.clear();
  artistCache.clear();
}
