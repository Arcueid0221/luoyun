import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { filterTracks, matchesTerms, normalizeText, searchTerms } from './search.ts';
import type { Track } from '../../server/core/types.ts';

// 搜索框是"我明明有这首歌，为什么搜不到"最容易出问题的地方，
// 而且 filterTracks 带出去的 index 直接决定界面上显示的序号（= 落盘目录前缀）。
// 两件事都钉在这里。

function track(name: string, artists: string[] = ['周杰伦'], album = '叶惠美'): Track {
  return {
    id: `${name}/${artists.join(',')}`,
    name,
    artists: artists.map((artist, i) => ({ id: String(i), name: artist })),
    album: { id: '100', name: album },
    duration: 269000,
    uri: 'netease:track:1',
  };
}

describe('normalizeText', () => {
  it('转小写', () => {
    assert.equal(normalizeText('Bohemian RHAPSODY'), 'bohemian rhapsody');
  });

  it('全角字母数字折成半角（中文输入法下常打出全角）', () => {
    assert.equal(normalizeText('ＭＶ２'), 'mv2');
  });

  it('中文不受影响', () => {
    assert.equal(normalizeText('晴天'), '晴天');
  });
});

describe('searchTerms', () => {
  it('按空白切开，两边的空格不算', () => {
    assert.deepEqual(searchTerms('  周杰伦 晴天 '), ['周杰伦', '晴天']);
  });

  it('全角空格也算分隔符（NFKC 先把它折成普通空格）', () => {
    assert.deepEqual(searchTerms('周杰伦　晴天'), ['周杰伦', '晴天']);
  });

  it('空串和纯空白得到空数组，也就是"没在搜"', () => {
    assert.deepEqual(searchTerms(''), []);
    assert.deepEqual(searchTerms('   　 '), []);
  });
});

describe('matchesTerms', () => {
  const qingtian = track('晴天', ['周杰伦'], '叶惠美');

  it('多个关键词是 AND，且可以跨字段命中', () => {
    assert.ok(matchesTerms(qingtian, ['周杰伦', '晴天']));
    assert.ok(matchesTerms(qingtian, ['晴天', '叶惠美']));
  });

  it('有一个词落空就不算命中', () => {
    assert.ok(!matchesTerms(qingtian, ['周杰伦', '夜曲']));
  });

  it('英文不分大小写（关键词也走 searchTerms 归一化）', () => {
    const bohemian = track('Bohemian Rhapsody', ['Queen'], 'A Night at the Opera');
    assert.ok(matchesTerms(bohemian, searchTerms('QUEEN Opera')));
    assert.ok(matchesTerms(bohemian, searchTerms('rhapsody')));
  });

  it('全角关键词能搜到半角写法', () => {
    assert.ok(matchesTerms(track('Live MV'), searchTerms('ＭＶ')));
  });

  it('多个歌手里任意一个都能搜到', () => {
    const duet = track('因为爱情', ['陈奕迅', '王菲']);
    assert.ok(matchesTerms(duet, ['王菲']));
  });

  it('关键词为空视为命中', () => {
    assert.ok(matchesTerms(qingtian, []));
  });
});

describe('filterTracks', () => {
  const tracks = [
    track('晴天', ['周杰伦'], '叶惠美'),
    track('因为爱情', ['陈奕迅', '王菲'], '认了吧'),
    track('夜曲', ['周杰伦'], '十一月的萧邦'),
    track('富士山下', ['陈奕迅'], 'What is Going On'),
  ];

  it('没搜的时候原样全给，序号是 0 起的下标', () => {
    const hits = filterTracks(tracks, '   ');
    assert.equal(hits.length, 4);
    assert.deepEqual(
      hits.map((hit) => hit.index),
      [0, 1, 2, 3],
    );
  });

  it('带出来的 index 是歌单里的原始位置，不是筛选结果里的第几个', () => {
    // 这条是回归测试：序号会显示在界面上，也是落盘目录的前缀，
    // 用筛选后的下标会让"第 3 首"和目录 `003 …` 对不上
    const hits = filterTracks(tracks, '陈奕迅');
    assert.deepEqual(
      hits.map((hit) => hit.index),
      [1, 3],
    );
    assert.deepEqual(
      hits.map((hit) => hit.track.name),
      ['因为爱情', '富士山下'],
    );
  });

  it('专辑名也能筛', () => {
    const hits = filterTracks(tracks, '萧邦');
    assert.deepEqual(
      hits.map((hit) => hit.track.name),
      ['夜曲'],
    );
  });

  it('一个都没命中就是空数组', () => {
    assert.deepEqual(filterTracks(tracks, '不存在的歌'), []);
  });

  it('不改原数组，也不复制 track 对象', () => {
    const hits = filterTracks(tracks, '晴天');
    assert.equal(tracks.length, 4);
    assert.equal(hits[0]?.track, tracks[0]);
  });
});
