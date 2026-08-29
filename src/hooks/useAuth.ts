import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post } from '../api/client.ts';
import { useSelection } from '../store/selection.ts';
import type { AuthStatus } from '../../server/core/types.ts';

export function useAuthStatus() {
  return useQuery({
    queryKey: ['auth'],
    queryFn: () => get<AuthStatus>('/api/auth/status'),
    // 每次都打一次网易的接口确认 cookie 还活着，不吃缓存
    staleTime: 0,
  });
}

export function useLoginByCookie() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (musicU: string) => post<AuthStatus>('/api/auth/cookie', { musicU }),
    onSuccess: (status) => {
      client.setQueryData(['auth'], status);
      void client.invalidateQueries({ queryKey: ['playlists'] });
    },
  });
}

/** 备选路径：sweet-cookie 没装 / 钥匙串超时的时候后端会给出明确文案 */
export function useImportFromBrowser() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (profile?: string) => post<AuthStatus>('/api/auth/import', { profile }),
    onSuccess: (status) => {
      client.setQueryData(['auth'], status);
      void client.invalidateQueries({ queryKey: ['playlists'] });
    },
  });
}

export function useLogout() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => post<AuthStatus>('/api/auth/logout'),
    onSuccess: () => {
      // 换账号时旧歌单必须一起丢掉，否则会看到上一个人的列表
      client.clear();
      // 勾选集是 persist 到 localStorage 的，光清 Query 缓存清不掉它
      useSelection.getState().reset();
    },
  });
}
