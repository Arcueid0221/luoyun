import { useQuery } from '@tanstack/react-query';
import { get } from '../api/client.ts';
import type { Playlist } from '../../server/core/types.ts';

export function usePlaylists() {
  return useQuery({
    queryKey: ['playlists'],
    queryFn: () => get<Playlist[]>('/api/playlists'),
    staleTime: 60_000,
  });
}

export function usePlaylistDetail(id: string | null) {
  return useQuery({
    queryKey: ['playlist', id],
    queryFn: () => get<Playlist>(`/api/playlists/${encodeURIComponent(id ?? '')}`),
    enabled: !!id,
    // 千首以上的歌单要分批补详情，一次要发好几个请求。
    // staleTime 给长一点，来回切歌单不要反复拉。
    staleTime: 10 * 60_000,
  });
}
