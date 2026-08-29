import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import type { Track } from '../core/types.ts';
import { warn, debug } from '../core/logger.ts';
import { artistLabel } from './naming.ts';

// 用 execFile 而不是 exec：不经过 shell，歌名里的引号、分号、反引号
// 就没有任何被解释的机会。
const run = promisify(execFile);

let probe: Promise<boolean> | null = null;

export function hasFfmpeg(): Promise<boolean> {
  if (!probe) {
    probe = run('ffmpeg', ['-version'], { timeout: 5000 })
      .then(() => true)
      .catch(() => {
        warn('没找到 ffmpeg，跳过封面/歌词内嵌（独立的 cover.jpg 和 lyric.lrc 照常生成）');
        return false;
      });
  }
  return probe;
}

export interface EmbedOptions {
  audioPath: string;
  coverPath?: string;
  /** 只写原文歌词，不写翻译 —— 两份时间轴叠在一起播放器会重复显示 */
  lyricText?: string;
  track: Track;
  publishTime?: number;
}

// 歌词走 argv 传给 ffmpeg，太长会撞 E2BIG。逐字歌词偶尔能到几十 KB。
const MAX_LYRIC_ARG = 60000;

export function buildArgs(
  audioPath: string,
  outPath: string,
  ext: string,
  opts: EmbedOptions,
  withCover: boolean,
): string[] {
  const { track, lyricText, publishTime } = opts;
  const args = ['-nostdin', '-y', '-loglevel', 'error', '-i', audioPath];

  if (withCover && opts.coverPath) args.push('-i', opts.coverPath);

  args.push('-map', '0:a');
  if (withCover && opts.coverPath) args.push('-map', '1:v');

  args.push('-c:a', 'copy');
  if (withCover && opts.coverPath) {
    // mp3 需要真的编成 mjpeg，其他容器直接 copy 就行
    args.push('-c:v', ext === 'mp3' ? 'mjpeg' : 'copy');
    args.push('-disposition:v', 'attached_pic');
    args.push('-metadata:s:v', 'title=Album cover');
    args.push('-metadata:s:v', 'comment=Cover (front)');
  }

  args.push('-metadata', `title=${track.name}`);
  args.push('-metadata', `artist=${artistLabel(track)}`);
  if (track.album.name) args.push('-metadata', `album=${track.album.name}`);
  if (publishTime) args.push('-metadata', `date=${new Date(publishTime).getFullYear()}`);
  if (lyricText && lyricText.length <= MAX_LYRIC_ARG) {
    args.push('-metadata', `lyrics=${lyricText}`);
  }

  // ID3v2.4 有些播放器不认，固定写 v2.3
  if (ext === 'mp3') args.push('-id3v2_version', '3');

  args.push(outPath);
  return args;
}

/**
 * 把封面、歌词、基本元数据写进音频文件。
 *
 * ffmpeg 不能原地改文件，所以写临时文件再 rename 覆盖；失败就删临时文件，原文件不动。
 *
 * 内嵌是加分项而不是必需项 —— 产物结构本来就是"每首一个文件夹、cover.jpg 独立成文件"，
 * 所以这里任何失败都只记 warning，绝不让整首歌算 failed。
 * FLAC 内嵌封面在不同 ffmpeg 版本上行为不一致，带封面失败时会再试一次不带封面的，
 * 至少把标题/歌手/歌词写进去。
 */
export async function embedTags(opts: EmbedOptions): Promise<void> {
  if (!(await hasFfmpeg())) return;
  if (!fs.existsSync(opts.audioPath)) return;

  const ext = opts.audioPath.split('.').pop()?.toLowerCase() ?? 'mp3';
  const tmpPath = `${opts.audioPath}.tag.${ext}`;

  const attempt = async (withCover: boolean): Promise<void> => {
    const args = buildArgs(opts.audioPath, tmpPath, ext, opts, withCover);
    try {
      await run('ffmpeg', args, { timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
      fs.renameSync(tmpPath, opts.audioPath);
    } catch (error) {
      fs.rmSync(tmpPath, { force: true });
      throw error;
    }
  };

  const hadCover = !!opts.coverPath && fs.existsSync(opts.coverPath);

  try {
    await attempt(hadCover);
  } catch (error) {
    debug(`ffmpeg 内嵌失败: ${error instanceof Error ? error.message : error}`);
    if (hadCover) {
      try {
        await attempt(false);
        warn(`封面内嵌失败，已只写文字标签: ${opts.track.name}`);
        return;
      } catch (retryError) {
        debug(`ffmpeg 重试仍失败: ${retryError instanceof Error ? retryError.message : retryError}`);
      }
    }
    warn(`元数据内嵌失败（文件本身没问题）: ${opts.track.name}`);
  }
}
