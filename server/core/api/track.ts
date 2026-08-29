import { getApiClient } from '../client.ts';
import { transformTrack, type RawTrack } from './transform.ts';
import type { Lyric, Quality, Track, TrackUrlInfo } from '../types.ts';
import { verbose } from '../logger.ts';

// 网易对单次请求的 id 数量没有明文上限，但批量越大越容易被限流，
// 而且 url 接口返回的地址有效期只有二十分钟左右，攒太多也没意义。
const DETAIL_BATCH = 500;
const URL_BATCH = 100;
const BATCH_GAP_MS = 200;

interface NeteaseTrackDetailResponse {
  code: number;
  songs?: RawTrack[];
}

interface NeteaseUrlV1Response {
  code: number;
  data?: {
    id: number;
    url: string | null;
    br: number;
    size: number;
    type: string;
    level?: string;
    fee?: number;
  }[];
}

interface NeteaseLyricResponse {
  code: number;
  lrc?: { lyric?: string };
  tlyric?: { lyric?: string };
  romalrc?: { lyric?: string };
  klyric?: { lyric?: string };
}

/** 一首歌的完整信息。publishTime / fee 只有 /song/detail 给，歌单接口不给 */
export interface TrackDetail {
  track: Track;
  publishTime?: number;
  fee?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function fetchDetailBatch(ids: string[]): Promise<RawTrack[]> {
  const client = getApiClient();
  const c = JSON.stringify(ids.map((id) => ({ id: Number(id) })));
  const response = await client.request<NeteaseTrackDetailResponse>('/song/detail', {
    c,
    ids: `[${ids.join(',')}]`,
  });
  return response.songs || [];
}

/**
 * 批量取歌曲详情，内部自动分批。
 *
 * 返回顺序不保证和入参一致 —— /song/detail 不承诺顺序，
 * 需要顺序的调用方自己按 id 重排（见 playlist.ts）。
 */
export async function getTrackDetails(ids: string[]): Promise<TrackDetail[]> {
  if (ids.length === 0) return [];

  const batches = chunk(ids, DETAIL_BATCH);
  const out: TrackDetail[] = [];

  for (let i = 0; i < batches.length; i++) {
    if (i > 0) await sleep(BATCH_GAP_MS);
    verbose(`song/detail 第 ${i + 1}/${batches.length} 批（${batches[i].length} 首）`);
    for (const raw of await fetchDetailBatch(batches[i])) {
      out.push({
        track: transformTrack(raw),
        publishTime: raw.publishTime,
        fee: raw.fee,
      });
    }
  }

  return out;
}

export async function getTrackDetail(id: string): Promise<TrackDetail> {
  const [detail] = await getTrackDetails([id]);
  if (!detail) throw new Error(`找不到这首歌: ${id}`);
  return detail;
}

/**
 * 批量取播放地址。
 *
 * 用 v1 端点而不是 neteasecli 用的老端点：老端点靠 br 数值选音质，
 * 而它的 qualityBrMap 里 lossless 和 hires 都写成 999000，
 * 结果永远拿不到真正的 hires。v1 直接传 level 字符串，
 * Quality 的取值就是 level 的取值，不需要映射表。
 *
 * url 为 null 是常态（无版权 / 要 VIP / 要单独买），不是错误。
 * 所以下载前先把所有地址批量拿回来，一次性把不可用的标出来，
 * 而不是下到一半才发现。
 */
export async function getTrackUrls(
  ids: string[],
  quality: Quality = 'exhigh',
): Promise<Map<string, TrackUrlInfo>> {
  const result = new Map<string, TrackUrlInfo>();
  if (ids.length === 0) return result;

  const client = getApiClient();
  const batches = chunk(ids, URL_BATCH);

  for (let i = 0; i < batches.length; i++) {
    if (i > 0) await sleep(BATCH_GAP_MS);
    verbose(`song/url 第 ${i + 1}/${batches.length} 批（${batches[i].length} 首，${quality}）`);

    const response = await client.request<NeteaseUrlV1Response>('/song/enhance/player/url/v1', {
      ids: JSON.stringify(batches[i].map(Number)),
      level: quality,
      encodeType: 'flac',
    });

    for (const item of response.data || []) {
      result.set(String(item.id), {
        id: String(item.id),
        url: item.url ?? null,
        br: item.br,
        size: item.size,
        type: item.type,
        level: item.level,
        fee: item.fee,
      });
    }
  }

  return result;
}

/**
 * 取歌词。neteasecli 只传 lv/tv（原文 + 翻译），
 * 这里补上 rv（罗马音，日文歌有用）和 kv（逐字时间轴）。
 */
export async function getLyric(id: string): Promise<Lyric> {
  const client = getApiClient();
  const response = await client.request<NeteaseLyricResponse>('/song/lyric', {
    id,
    lv: -1,
    tv: -1,
    rv: -1,
    kv: -1,
  });

  return {
    lrc: response.lrc?.lyric || undefined,
    tlyric: response.tlyric?.lyric || undefined,
    romalrc: response.romalrc?.lyric || undefined,
    klyric: response.klyric?.lyric || undefined,
  };
}
