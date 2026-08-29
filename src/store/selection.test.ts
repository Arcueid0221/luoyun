import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

// zustand 的 persist 默认存储读的是 `window.localStorage`（不是裸的 localStorage），
// node 里没有 window，它会每次 set 都警告一行、并且完全不走序列化那条路。
// 先塞一个内存版进去，warning 没了，partialize / merge 那两段也真的跑了一遍。
// 塞完再动态 import store —— 静态 import 会被提到这之前执行。
const saved = new Map<string, string>();
const memoryStorage = {
  getItem: (key: string): string | null => saved.get(key) ?? null,
  setItem: (key: string, value: string): void => void saved.set(key, value),
  removeItem: (key: string): void => void saved.delete(key),
};
(globalThis as { window?: unknown }).window = { localStorage: memoryStorage };

const { useSelection } = await import('./selection.ts');

const state = () => useSelection.getState();
const picked = (): string[] => [...state().selected].sort();

beforeEach(() => {
  useSelection.setState({ playlistId: 'p1', selected: new Set() });
});

// 这三个动作的作用域是"调用方给的这批 id"，搜索时传的是筛出来的那些。
// 换成覆盖 / 取补集在不搜索时看不出区别，一搜索就会悄悄丢掉勾选。
describe('勾选的作用域', () => {
  it('全选是并集：搜 A 全选、再搜 B 全选，A 那批不能丢', () => {
    state().selectAll(['a', 'b']);
    state().selectAll(['c']);
    assert.deepEqual(picked(), ['a', 'b', 'c']);
  });

  it('反选只翻转给的这批，集合里其他的不动', () => {
    state().selectAll(['a', 'b']);
    state().invert(['b', 'c']);
    assert.deepEqual(picked(), ['a', 'c']);
  });

  it('不搜索时反选整个列表 = 取补集（和旧行为一致）', () => {
    state().selectAll(['b']);
    state().invert(['a', 'b', 'c']);
    assert.deepEqual(picked(), ['a', 'c']);
  });

  it('取消只去掉给的这批', () => {
    state().selectAll(['a', 'b', 'c']);
    state().deselect(['b', 'z']);
    assert.deepEqual(picked(), ['a', 'c']);
  });

  it('清空是全部清掉，跟筛选无关', () => {
    state().selectAll(['a', 'b']);
    state().clear();
    assert.equal(state().selected.size, 0);
  });

  it('toggle 来回一次回到原样', () => {
    state().toggle('a');
    assert.deepEqual(picked(), ['a']);
    state().toggle('a');
    assert.deepEqual(picked(), []);
  });
});

describe('换歌单与退出登录', () => {
  it('换歌单清勾选：trackId 跨歌单没有意义', () => {
    state().selectAll(['a']);
    state().openPlaylist('p2');
    assert.equal(state().playlistId, 'p2');
    assert.deepEqual(picked(), []);
  });

  it('点开当前歌单不清勾选', () => {
    state().selectAll(['a']);
    state().openPlaylist('p1');
    assert.deepEqual(picked(), ['a']);
  });

  it('退出登录丢掉歌单和勾选，留下本机的下载偏好', () => {
    useSelection.setState({ quality: 'lossless', destDir: '/tmp/x' });
    state().selectAll(['a']);
    state().reset();
    assert.equal(state().playlistId, null);
    assert.deepEqual(picked(), []);
    assert.equal(state().quality, 'lossless');
    assert.equal(state().destDir, '/tmp/x');
  });
});

describe('落 localStorage 的形状', () => {
  it('Set 存成数组 —— 直接 JSON.stringify 一个 Set 得到的是 {}', () => {
    state().selectAll(['b', 'a']);
    const raw = saved.get('luoyun-selection');
    assert.ok(raw, '应该真的写进了存储');
    const parsed = JSON.parse(raw) as { state: { selected: string[] }; version: number };
    assert.deepEqual([...parsed.state.selected].sort(), ['a', 'b']);
    assert.equal(parsed.version, 1);
  });
});
