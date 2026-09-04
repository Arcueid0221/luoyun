// 前后端共用的类型定义。
//
// 前端直接 import 这个文件（`src/api/client.ts` 等），所以它必须永远保持
// 零依赖：不许 import node: 任何东西，也不许 import 其他 server/ 文件。
// 只放 interface / type / 纯数据常量。这样接口形状不可能前后端对不上。

// ---- 从 neteasecli/src/types/index.ts 继承的部分 ----

export interface Artist {
  id: string;
  name: string;
}

export interface Album {
  id: string;
  name: string;
  picUrl?: string;
}

export interface Track {
  id: string;
  name: string;
  artists: Artist[];
  album: Album;
  duration: number;
  uri: string;
}

export interface Playlist {
  id: string;
  name: string;
  description?: string;
  coverUrl?: string;
  trackCount: number;
  creator?: { id: string; name: string };
  tracks?: Track[];
}

export interface Lyric {
  lrc?: string;
  tlyric?: string;
  romalrc?: string;
  klyric?: string;
}

export type Quality = 'standard' | 'higher' | 'exhigh' | 'lossless' | 'hires' | 'jymaster';

export const QUALITIES: Quality[] = [
  'standard',
  'higher',
  'exhigh',
  'lossless',
  'hires',
  'jymaster',
];

export interface UserProfile {
  id: string;
  nickname: string;
  avatarUrl?: string;
}

export interface CookieData {
  MUSIC_U?: string;
  [key: string]: string | undefined;
}

// ---- 落云新增的部分 ----

export interface TrackUrlInfo {
  id: string;
  /** null 是常态：无版权 / 需要 VIP / 需要单独购买 */
  url: string | null;
  br: number;
  size: number;
  /** 'flac' | 'mp3' | ... */
  type: string;
  /** 实际给到的档位，可能低于请求的 */
  level?: string;
  fee?: number;
}

/** info.json 的内容 */
export interface SongInfo {
  track: Track;
  publishTime?: number;
  albumDescription?: string;
  artistDescription?: string;
  playlist?: { id: string; name: string };
  /**
   * 实际拿到的音频规格。网易对权限不够的请求是静默降级而不是报错，
   * 所以请求 lossless 时这里可能记着 exhigh —— 这是唯一能事后看出来的地方。
   */
  audio?: {
    requested: Quality;
    level?: string;
    br: number;
    type: string;
    size: number;
  };
}

export type DownloadPart = 'audio' | 'cover' | 'lyric' | 'info';

export const DOWNLOAD_PARTS: DownloadPart[] = ['audio', 'cover', 'lyric', 'info'];

export type PartFlags = Record<DownloadPart, boolean>;

export type TrackStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed';

/**
 * skipped 的原因。no-copyright / vip 是网易不给，already 是本地已下过，
 * cancelled 是用户点了取消（这三种都不是错误，UI 不该标红）。
 */
export type SkipReason = 'no-copyright' | 'vip' | 'already' | 'cancelled';

export interface JobTrackState {
  trackId: string;
  /** "晴天 - 周杰伦"，给 UI 直接显示 */
  name: string;
  status: TrackStatus;
  reason?: SkipReason;
  error?: string;
  bytes?: number;
  /** 落盘目录，完成后填 */
  dir?: string;
}

export type JobStatus = 'running' | 'done' | 'cancelled';

export interface Job {
  id: string;
  playlistId: string;
  playlistName: string;
  destDir: string;
  parts: PartFlags;
  quality: Quality;
  tracks: JobTrackState[];
  status: JobStatus;
  createdAt: number;
  /**
   * 任务级错误（创建目录失败、批量取地址失败）。
   *
   * 必须存在 Job 上而不是只发一个事件：`runJob` 在 POST 响应写回之前就开始跑，
   * 目录创建失败时 error 事件发生在页面拿到 jobId 之前，只发事件的话
   * 页面永远收不到 —— 于是一个什么都没下的任务在 UI 上显示成"已结束"。
   */
  error?: string;
}

export interface JobSummary {
  done: number;
  skipped: number;
  failed: number;
}

export type JobEvent =
  | { type: 'track'; track: JobTrackState }
  // status 必须跟着 done 一起发：页面无法从自己手里的状态推断任务是正常结束
  // 还是被取消（取消可能来自另一个标签页，也可能发生在页面订阅之前）
  | { type: 'done'; summary: JobSummary; status: JobStatus }
  | { type: 'error'; message: string };

export interface AuthStatus {
  authenticated: boolean;
  userId?: string;
  nickname?: string;
  avatarUrl?: string;
  source?: string;
  error?: string;
}

/** 本地网页登录流程只返回状态，绝不把浏览器里的 cookie 下发给页面。 */
export interface BrowserLoginPollStatus {
  state: 'waiting' | 'authenticated';
  session?: AuthStatus;
}
