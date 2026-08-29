import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  DOWNLOAD_PARTS,
  type DownloadPart,
  type PartFlags,
  type Quality,
} from '../../server/core/types.ts';

interface SelectionState {
  /** 当前打开的歌单；null = 停在歌单网格 */
  playlistId: string | null;
  selected: Set<string>;
  parts: PartFlags;
  quality: Quality;
  destDir: string;

  openPlaylist(id: string | null): void;
  toggle(id: string): void;
  /** 把这些 id 并进勾选集。搜索时传的是筛出来的那些，所以是并集而不是覆盖 */
  selectAll(ids: string[]): void;
  /** 只翻转这些 id，集合里其他的不动 */
  invert(ids: string[]): void;
  /** 从勾选集里去掉这些 id */
  deselect(ids: string[]): void;
  clear(): void;
  /** 退出登录时调：把跟账号绑定的东西丢掉，下载偏好留着 */
  reset(): void;
  setPart(part: DownloadPart, on: boolean): void;
  setQuality(quality: Quality): void;
  setDestDir(dir: string): void;
}

/** 落 localStorage 的形状：Set 不能直接 JSON 序列化，存成数组 */
interface Persisted {
  playlistId: string | null;
  selected: string[];
  parts: PartFlags;
  quality: Quality;
  destDir: string;
}

/**
 * 勾选集必须持久化，理由很具体：改 server/ 下任何文件都会让 Vite 整体重启
 * 并整页刷新。调流水线时几乎每改一行就刷一次，没有 persist 的话
 * "从 300 首里挑好的 40 首" 每次都白挑。
 */
export const useSelection = create<SelectionState>()(
  persist<SelectionState, [], [], Persisted>(
    (set, get) => ({
      playlistId: null,
      selected: new Set<string>(),
      parts: { audio: true, cover: true, lyric: true, info: true },
      quality: 'exhigh',
      destDir: '',

      // 换歌单就清勾选：trackId 跨歌单没有意义，留着会误下
      openPlaylist(id) {
        if (id === get().playlistId) return;
        set({ playlistId: id, selected: new Set() });
      },

      toggle(id) {
        const selected = new Set(get().selected);
        if (!selected.delete(id)) selected.add(id);
        set({ selected });
      },

      // 下面三个动作的作用域都是"调用方给的这批 id"，也就是搜索筛出来的那些。
      // 没搜索时 ids 是整个歌单，行为和以前一样。

      // 并集而不是覆盖：搜 A 全选、再搜 B 全选，覆盖会把 A 那批悄悄丢掉
      selectAll(ids) {
        const selected = new Set(get().selected);
        for (const id of ids) selected.add(id);
        set({ selected });
      },

      // 逐个翻转，不是"在 ids 里取补集"：取补集会把没匹配上关键词的
      // 已勾选项一起清掉。没搜索时两种写法结果相同
      invert(ids) {
        const selected = new Set(get().selected);
        for (const id of ids) if (!selected.delete(id)) selected.add(id);
        set({ selected });
      },

      deselect(ids) {
        const selected = new Set(get().selected);
        for (const id of ids) selected.delete(id);
        set({ selected });
      },

      clear() {
        set({ selected: new Set() });
      },

      // playlistId 和 selected 都是上一个账号的 id，换人之后继续留着会
      // 打开一个新账号根本没有的歌单、并按旧账号的勾选去下载。
      // parts / quality / destDir 是本机偏好，跟账号无关，不动。
      reset() {
        set({ playlistId: null, selected: new Set() });
      },

      setPart(part, on) {
        set({ parts: { ...get().parts, [part]: on } });
      },

      setQuality(quality) {
        set({ quality });
      },

      setDestDir(destDir) {
        set({ destDir });
      },
    }),
    {
      name: 'luoyun-selection',
      version: 1,
      partialize: (state) => ({
        playlistId: state.playlistId,
        selected: [...state.selected],
        parts: state.parts,
        quality: state.quality,
        destDir: state.destDir,
      }),
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<Persisted>;
        return {
          ...current,
          ...saved,
          selected: new Set(saved.selected ?? []),
        };
      },
    },
  ),
);

export function anyPartSelected(parts: PartFlags): boolean {
  return DOWNLOAD_PARTS.some((part) => parts[part]);
}
