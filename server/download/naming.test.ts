import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  sanitizeName,
  trackDirName,
  audioExt,
  artistLabel,
  uniqueDir,
  playlistDirPath,
} from './naming.ts';
import type { Track } from '../core/types.ts';

// naming.ts 是整个项目里唯一直接决定磁盘上出现什么路径的纯函数，
// 出错的后果是 mkdir 失败、目录互相覆盖、或者产出 Finder 里打不开的目录。
// 所以它的规则全部钉在这里，改规则必须先改测试。

function track(over: Partial<Track> = {}): Track {
  return {
    id: '1',
    name: '晴天',
    artists: [{ id: '10', name: '周杰伦' }],
    album: { id: '100', name: '叶惠美' },
    duration: 269000,
    uri: 'netease:track:1',
    ...over,
  };
}

describe('sanitizeName', () => {
  it('把路径分隔符和 Windows 非法字符换成下划线', () => {
    assert.equal(sanitizeName('爱/恨'), '爱_恨');
    assert.equal(sanitizeName('a\\b:c*d?e"f<g>h|i'), 'a_b_c_d_e_f_g_h_i');
  });

  it('去掉控制字符，包括 NUL 和 DEL', () => {
    // 写成转义而不是控制字符本身，免得被编辑器或 diff 工具吃掉
    assert.equal(sanitizeName('a\u0000b\u001Fc\u007Fd'), 'abcd');
  });

  it('折叠连续空白并去掉首尾空白', () => {
    assert.equal(sanitizeName('  a \t\n b  '), 'a b');
  });

  it('去掉开头的点，否则会变成隐藏目录', () => {
    assert.equal(sanitizeName('...hidden'), 'hidden');
  });

  it('去掉结尾的空格和点，否则同步到 Windows / exFAT 会报错', () => {
    assert.equal(sanitizeName('name.'), 'name');
    assert.equal(sanitizeName('name '), 'name');
    assert.equal(sanitizeName('name . . '), 'name');
  });

  it('按码点截断，不切碎中文和 emoji', () => {
    const out = sanitizeName('😀'.repeat(10), 4);
    assert.equal([...out].length, 4);
    assert.equal(out, '😀😀😀😀');
    assert.ok(!out.includes('�'));
  });

  it('截断后新出现的结尾空格也要去掉', () => {
    assert.equal(sanitizeName('ab cd', 3), 'ab');
  });

  it('空结果兜底成 unknown', () => {
    assert.equal(sanitizeName(''), 'unknown');
    assert.equal(sanitizeName('   '), 'unknown');
    assert.equal(sanitizeName('...'), 'unknown');
  });

  it('Windows 保留名加前缀，大小写都算', () => {
    assert.equal(sanitizeName('CON'), '_CON');
    assert.equal(sanitizeName('nul'), '_nul');
    assert.equal(sanitizeName('COM1'), '_COM1');
    assert.equal(sanitizeName('CONCERT'), 'CONCERT');
  });
});

describe('trackDirName', () => {
  it('99 首以内用两位序号，100 首以上用三位', () => {
    assert.equal(trackDirName(1, track(), 99), '01 晴天 - 周杰伦');
    assert.equal(trackDirName(1, track(), 100), '001 晴天 - 周杰伦');
    assert.equal(trackDirName(7, track(), 1200), '0007 晴天 - 周杰伦');
  });

  it('序号超出宽度时不截断，宁可排序乱也不能丢序号', () => {
    assert.equal(trackDirName(100, track(), 99), '100 晴天 - 周杰伦');
  });

  it('歌名里的斜杠在拼进目录名后依然被清洗', () => {
    assert.equal(trackDirName(2, track({ name: '爱/恨' }), 99), '02 爱_恨 - 周杰伦');
  });
});

describe('artistLabel', () => {
  it('多歌手用逗号连接', () => {
    assert.equal(
      artistLabel(track({ artists: [{ id: '1', name: '周杰伦' }, { id: '2', name: '费玉清' }] })),
      '周杰伦, 费玉清',
    );
  });

  it('没有歌手时给出占位名而不是空串', () => {
    assert.equal(artistLabel(track({ artists: [] })), '未知歌手');
    assert.equal(artistLabel(track({ artists: [{ id: '1', name: '' }] })), '未知歌手');
  });
});

describe('audioExt', () => {
  it('优先用网易给的 type', () => {
    assert.equal(audioExt('flac'), 'flac');
    assert.equal(audioExt('MP3'), 'mp3');
    assert.equal(audioExt(' flac '), 'flac');
  });

  it('type 不可用时从 url 里猜，忽略 query', () => {
    assert.equal(audioExt(undefined, 'https://x.com/a/b.m4a?auth=1'), 'm4a');
    assert.equal(audioExt('', 'https://x.com/a/b.FLAC'), 'flac');
  });

  it('两者都不可用时回落到 mp3', () => {
    assert.equal(audioExt(undefined, undefined), 'mp3');
    assert.equal(audioExt('not-an-extension', 'https://x.com/a/b'), 'mp3');
  });
});

describe('playlistDirPath', () => {
  it('歌单名同样要清洗，斜杠会让 mkdir 直接失败', () => {
    assert.equal(playlistDirPath('/tmp/x', '我喜欢的/音乐'), path.join('/tmp/x', '我喜欢的_音乐'));
  });

  it('歌单名的长度上限比歌曲目录宽（120 码点）', () => {
    const long = '歌'.repeat(200);
    assert.equal([...path.basename(playlistDirPath('/tmp/x', long))].length, 120);
  });

  it('空歌单名兜底成 unknown，不能拼出以 destDir 结尾的路径', () => {
    assert.equal(playlistDirPath('/tmp/x', '   '), path.join('/tmp/x', 'unknown'));
  });
});

// uniqueDir 要碰真实文件系统，所以整块用一个临时目录
describe('uniqueDir', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'luoyun-naming-'));
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  /** 造一个已存在的目录，info 传 undefined 表示不写 info.json */
  function existing(name: string, info?: unknown): string {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    if (info !== undefined) {
      fs.writeFileSync(path.join(dir, 'info.json'), typeof info === 'string' ? info : JSON.stringify(info));
    }
    return dir;
  }

  it('目录不存在就直接用', () => {
    assert.equal(uniqueDir(root, '01 新歌 - 某人', '1'), path.join(root, '01 新歌 - 某人'));
  });

  it('目录已存在但没有 info.json 时复用，不能岔出 (2)', () => {
    // 这是回归用例：先下音频（不写 info.json）、事后补歌词的正常流程，
    // 判断方向写反的话第二次会落到 " (2)"，两半产物各躺一个目录
    const dir = existing('02 晴天 - 周杰伦');
    assert.equal(uniqueDir(root, '02 晴天 - 周杰伦', '1'), dir);
  });

  it('info.json 写着同一首歌时复用', () => {
    const dir = existing('03 反方向的钟 - 周杰伦', { track: { id: '7' } });
    assert.equal(uniqueDir(root, '03 反方向的钟 - 周杰伦', '7'), dir);
  });

  it('info.json 写着另一首歌才让路', () => {
    existing('04 同名 - 某人', { track: { id: '7' } });
    assert.equal(uniqueDir(root, '04 同名 - 某人', '8'), path.join(root, '04 同名 - 某人 (2)'));
  });

  it('(2) 也被别的歌占了就继续往后找', () => {
    existing('05 同名 - 某人', { track: { id: '7' } });
    existing('05 同名 - 某人 (2)', { track: { id: '8' } });
    assert.equal(uniqueDir(root, '05 同名 - 某人', '9'), path.join(root, '05 同名 - 某人 (3)'));
  });

  it('info.json 坏了 / 缺 id 时算没有证据，复用', () => {
    const broken = existing('06 坏文件 - 某人', '{ 不是 json');
    assert.equal(uniqueDir(root, '06 坏文件 - 某人', '1'), broken);
    const noId = existing('07 缺 id - 某人', { track: {} });
    assert.equal(uniqueDir(root, '07 缺 id - 某人', '1'), noId);
  });

  it('没传 trackId 时一律复用（补下载场景没有歌 id 可比）', () => {
    const dir = existing('08 无 id - 某人', { track: { id: '7' } });
    assert.equal(uniqueDir(root, '08 无 id - 某人'), dir);
  });
});

