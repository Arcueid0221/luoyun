import { getApiClient } from '../client.ts';
import type { UserProfile } from '../types.ts';

interface NeteaseUserAccountResponse {
  code: number;
  /** 未登录时是 null，而不是报错 —— neteasecli 在这里会直接 TypeError */
  profile: {
    userId: number;
    nickname: string;
    avatarUrl?: string;
  } | null;
}

export async function getUserProfile(): Promise<UserProfile> {
  const client = getApiClient();
  const response = await client.request<NeteaseUserAccountResponse>('/nuser/account/get');

  // 关键：cookie 失效时这个接口返回 code 200 + profile: null。
  // 必须在这里抛，checkAuth 才能判断出"未登录"。
  if (!response.profile) {
    throw new Error('未登录或 MUSIC_U 已失效');
  }

  return {
    id: String(response.profile.userId),
    nickname: response.profile.nickname,
    avatarUrl: response.profile.avatarUrl,
  };
}
