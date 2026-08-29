import { getApiClient } from '../client.ts';
import { transformTrack, coverUrl, type RawTrack } from './transform.ts';
import { getTrackDetails } from './track.ts';
import type { Playlist, Track } from '../types.ts';
import { verbose, warn } from '../logger.ts';

interface NeteasePlaylistResponse {
  code: number;
  playlist: {
    id: number;
    name: string;
    description?: string;
    coverImgUrl?: string;
    trackCount: number;
    creator?: { userId: number; nickname: string };
    /** 全量 id 列表，且顺序权威。这是修 >1000 首截断的钥匙 */
    trackIds?: { id: number }[];
    /** 只有前 ~1000 首的完整信息 */
    tracks?: RawTrack[];
  } | null;
}

interface NeteaseUserPlaylistsResponse {
  code: number;
  playlist?: {
    id: number;
    name: string;
    description?: string;
    coverImgUrl?: string;
    trackCount: number;
    creator?: { userId: number; nickname: string };
  }[];
}

/**
 * 取歌单全部歌曲。
 *
 * neteasecli 直接用 response.playlist.tracks 就返回了 —— 那里最多只有 1000 首，
 * 一个 2000 首的歌单会静默丢掉一半，而且没有任何提示。
 *
 * 正确做法分五步：
 *   1. /v6/playlist/detail 拿到 playlist
 *   2. trackIds 是全量 + 权威顺序（顺序决定文件夹的 01/02 前缀）
 *   3. tracks 里已有的先建 map
 *   4. 缺的用 /song/detail 分批补
 *   5. 按 trackIds 重排 —— /song/detail 不保证返回顺序
 */
export async function getPlaylistDetail(id: string): Promise<Playlist> {
  const client = getApiClient();

  const response = await client.request<NeteasePlaylistResponse>('/v6/playlist/detail', {
    id,
    n: 100000,
  });

  const playlist = response.playlist;
  if (!playlist) throw new Error(`歌单不存在或无权访问: ${id}`);

  const meta: Playlist = {
    id: String(playlist.id),
    name: playlist.name,
    description: playlist.description,
    coverUrl: coverUrl(playlist.coverImgUrl, 500),
    trackCount: playlist.trackCount,
    creator: playlist.creator
      ? { id: String(playlist.creator.userId), name: playlist.creator.nickname }
      : undefined,
  };

  const allIds = (playlist.trackIds ?? []).map((t) => String(t.id));
  const haveMap = new Map<string, Track>();
  for (const raw of playlist.tracks ?? []) {
    haveMap.set(String(raw.id), transformTrack(raw));
  }

  // 没有 trackIds 就只能相信 tracks（理论上不该发生）
  if (allIds.length === 0) {
    meta.tracks = [...haveMap.values()];
    return meta;
  }

  const missing = allIds.filter((tid) => !haveMap.has(tid));
  if (missing.length > 0) {
    verbose(`歌单 ${playlist.name}: ${allIds.length} 首，需补 ${missing.length} 首`);
    for (const detail of await getTrackDetails(missing)) {
      haveMap.set(detail.track.id, detail.track);
    }
  }

  const tracks: Track[] = [];
  for (const tid of allIds) {
    const track = haveMap.get(tid);
    if (track) tracks.push(track);
  }

  if (tracks.length !== allIds.length) {
    // 下架的歌 /song/detail 也查不到，这时候少几首是正常的，但要说出来
    warn(`歌单 ${playlist.name}: ${allIds.length} 首里有 ${allIds.length - tracks.length} 首拿不到详情（可能已下架）`);
  }

  meta.tracks = tracks;
  return meta;
}

export async function getUserPlaylists(uid?: string): Promise<Playlist[]> {
  const client = getApiClient();

  let userId = uid;
  if (!userId) {
    const { getUserProfile } = await import('./user.ts');
    userId = (await getUserProfile()).id;
  }

  const response = await client.request<NeteaseUserPlaylistsResponse>('/user/playlist', {
    uid: userId,
    limit: 1000,
    offset: 0,
  });

  return (response.playlist ?? []).map((p) => ({
    id: String(p.id),
    name: p.name,
    description: p.description,
    coverUrl: coverUrl(p.coverImgUrl, 500),
    trackCount: p.trackCount,
    creator: p.creator ? { id: String(p.creator.userId), name: p.creator.nickname } : undefined,
  }));
}
