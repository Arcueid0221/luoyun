/**
 * 端点验证脚本。只读，不下载任何文件。
 *
 *   node scripts/verify-endpoints.ts            # 自动挑最大的歌单
 *   node scripts/verify-endpoints.ts 123456     # 指定歌单 id
 *
 * 验 DESIGN.md 第九节那四条：url/v1 的 level 取值和返回结构、非会员请求
 * 无损时的降级行为、album/artist 简介的字段名、>1000 首歌单的实际返回。
 */
import { getAuthManager } from '../server/core/auth.ts';
import { getApiClient } from '../server/core/client.ts';
import { getUserPlaylists } from '../server/core/api/playlist.ts';
import { getTrackUrls, getLyric } from '../server/core/api/track.ts';
import { getAlbumDescription, getArtistDescription } from '../server/core/api/album.ts';
import { transformTrack, type RawTrack } from '../server/core/api/transform.ts';
import type { Quality } from '../server/core/types.ts';

const QUALITIES_TO_TRY: Quality[] = ['exhigh', 'lossless', 'hires'];

interface RawDetail {
  playlist: {
    id: number;
    name: string;
    trackCount: number;
    trackIds?: { id: number }[];
    tracks?: RawTrack[];
  } | null;
}

function head(text: string): void {
  process.stdout.write(`\n=== ${text} ===\n`);
}

function preview(value: string | undefined, max = 90): string {
  if (!value) return '（空）';
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

async function main(): Promise<void> {
  head('0. 登录状态');
  const check = await getAuthManager().checkAuth();
  if (!check.valid) {
    process.stderr.write(
      `${check.error ?? '未登录'}\n请先跑 npm run dev，在页面里填一次 MUSIC_U。\n`,
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${check.nickname}（uid ${check.userId}）\n`);

  head('4. /v6/playlist/detail 对大歌单的返回');
  let playlistId = process.argv[2];
  if (!playlistId) {
    const playlists = await getUserPlaylists();
    const biggest = [...playlists].sort((a, b) => b.trackCount - a.trackCount)[0];
    if (!biggest) {
      process.stderr.write('这个账号下没有歌单，传一个歌单 id 进来再试\n');
      process.exitCode = 1;
      return;
    }
    playlistId = biggest.id;
    process.stdout.write(`共 ${playlists.length} 个歌单，挑最大的：${biggest.name}\n`);
  }

  const raw = await getApiClient().request<RawDetail>('/v6/playlist/detail', {
    id: playlistId,
    n: 100000,
  });
  const playlist = raw.playlist;
  if (!playlist) {
    process.stderr.write(`歌单 ${playlistId} 拿不到\n`);
    process.exitCode = 1;
    return;
  }
  const idCount = playlist.trackIds?.length ?? 0;
  const trackCount = playlist.tracks?.length ?? 0;
  process.stdout.write(
    `${playlist.name}: trackCount=${playlist.trackCount} trackIds=${idCount} tracks=${trackCount}\n`,
  );
  process.stdout.write(
    idCount === playlist.trackCount
      ? '  → trackIds 是全量，补齐逻辑的前提成立\n'
      : `  → trackIds 也不全（差 ${playlist.trackCount - idCount} 首），补齐逻辑要改\n`,
  );

  const samples = (playlist.tracks ?? []).slice(0, 3).map(transformTrack);
  if (samples.length === 0) {
    process.stderr.write('这个歌单没返回任何曲目详情，后面几项没法验\n');
    return;
  }
  process.stdout.write(
    `  取样：${samples.map((t) => `${t.name} - ${t.artists[0]?.name ?? '?'}`).join(' / ')}\n`,
  );

  head('1 + 2. /song/enhance/player/url/v1 的 level 与降级行为');
  for (const quality of QUALITIES_TO_TRY) {
    const urls = await getTrackUrls(
      samples.map((t) => t.id),
      quality,
    );
    for (const track of samples) {
      const info = urls.get(track.id);
      const got = info
        ? `url=${info.url ? '有' : 'null'} br=${info.br} type=${info.type} level=${info.level ?? '?'} fee=${info.fee ?? '?'} size=${info.size}`
        : '接口没返回这一首';
      process.stdout.write(`  请求 ${quality.padEnd(8)} ${track.name}: ${got}\n`);
    }
  }
  process.stdout.write('  → level 与请求不一致 = 账号权限不够被降级，UI 要标"需会员"\n');

  head('3. 专辑 / 歌手简介的字段名');
  const first = samples[0];
  const albumDescription = await getAlbumDescription(first.album.id);
  const artistDescription = await getArtistDescription(first.artists[0]?.id ?? '');
  process.stdout.write(`  album ${first.album.name}: ${preview(albumDescription)}\n`);
  process.stdout.write(`  artist ${first.artists[0]?.name}: ${preview(artistDescription)}\n`);
  if (!albumDescription && !artistDescription) {
    process.stdout.write('  → 两个都空，字段名很可能对不上，回去看 album.ts\n');
  }

  head('附. 歌词的四个字段');
  const lyric = await getLyric(first.id);
  process.stdout.write(
    `  lrc=${lyric.lrc ? '有' : '无'} tlyric=${lyric.tlyric ? '有' : '无'} romalrc=${lyric.romalrc ? '有' : '无'} klyric=${lyric.klyric ? '有' : '无'}\n`,
  );
}

await main();
