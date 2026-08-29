// 歌单内搜索。规则放在 lib 里而不是组件里，是为了能用 node:test 钉住：
// "输入什么能搜到什么" 是这个功能的全部定义，而组件里的东西 node 直接跑不了（JSX）。
//
// 纯本地过滤，不碰网络。歌单详情早就把全部曲目发到浏览器了（虚拟列表就是渲染它），
// 在内存里筛是零延迟的；网易那个 /search 接口搜的是全站曲库，不是这个歌单，用不上。

import type { Track } from '../../server/core/types.ts';

/** 一条命中：歌本身 + 它在歌单里的原始位置（0 起） */
export interface TrackHit {
  track: Track;
  index: number;
}

/**
 * 归一化到"能直接 includes 的形状"。
 *
 * NFKC 是这里唯一不显然的一步：中文输入法下打出来的字母、数字和空格常常是全角的
 * （`ＭＶ`、`２`、`　`），不折一下就搜不到半角写法的歌名。NFKC 正好把全角 ASCII
 * 折成半角、把全角空格折成普通空格 —— 后者顺带让下面的 `split(/\s+/)` 认得它。
 */
export function normalizeText(text: string): string {
  return text.normalize('NFKC').toLowerCase();
}

/**
 * 关键词按空白切开。多个关键词之间是 AND，且允许**跨字段**命中：
 * `周杰伦 晴天` 要能搜到，而歌手在 artists 里、歌名在 name 里。
 */
export function searchTerms(query: string): string[] {
  return normalizeText(query)
    .split(/\s+/)
    .filter(Boolean);
}

// 歌名 + 歌手 + 专辑拼成一条串，每首只算一次。
// 上万首的歌单每敲一个键重算一万次 NFKC 是能感觉到的；Track 对象来自 Query 缓存，
// 同一个歌单里始终是同一个引用，WeakMap 正好，歌单换掉就跟着回收。
const haystacks = new WeakMap<Track, string>();

function haystackOf(track: Track): string {
  const cached = haystacks.get(track);
  if (cached !== undefined) return cached;
  const text = normalizeText(
    [track.name, ...track.artists.map((artist) => artist.name), track.album.name].join(' '),
  );
  haystacks.set(track, text);
  return text;
}

/** 单首是否命中。`terms` 必须是 `searchTerms()` 的产物（已归一化）；为空视为命中 —— 没搜就是全都要 */
export function matchesTerms(track: Track, terms: string[]): boolean {
  const haystack = haystackOf(track);
  return terms.every((term) => haystack.includes(term));
}

/**
 * 过滤，并把每首歌在**歌单里的原始序号**一起带出来。
 *
 * 序号必须是原始位置，不能是"筛选结果里的第几个"：它就是落盘目录的前缀
 * （`007 晴天 - 周杰伦`）。显示成 001 会让人以为下出来的目录叫 001，
 * 而且换个关键词同一首歌的编号还会变。
 */
export function filterTracks(tracks: Track[], query: string): TrackHit[] {
  const terms = searchTerms(query);
  const hits: TrackHit[] = [];
  tracks.forEach((track, index) => {
    if (terms.length === 0 || matchesTerms(track, terms)) hits.push({ track, index });
  });
  return hits;
}
