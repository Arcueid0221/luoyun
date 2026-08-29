# 落云 luoyun 设计文档

网易云歌单批量下载 Web App。本文是实现前的完整设计：为什么这么做、core 从哪来、每个文件里有什么函数、各自负责什么。

代码写完后与本文有出入的地方，统一记在末尾的**第十一节「实现偏差」**，正文保持原样不改，方便对照当初的判断错在哪。

---

## 一、项目开展的想法

### 要什么

一个本机跑的图形界面：登录自己的网易云账号 → 浏览自己的歌单 → 在曲目列表里勾选歌曲 → 勾选要下的资源（封面 / 歌词 / 音频 / 简介）→ 批量下载到本地，每首歌一个文件夹。

### 为什么不能是纯浏览器端

三条硬约束，每一条都单独致命：

| 约束 | 后果 |
|---|---|
| `MUSIC_U` 是 httpOnly cookie | `document.cookie` 读不到，页面 JS 无法拿到登录凭证 |
| `music.163.com` 不返回 CORS 头 | 浏览器直接 fetch 网易 API 一律被拦 |
| `Referer` 是 fetch 的 forbidden header | 音频 CDN 靠 Referer 防盗链，而 JS 无权设置这个头 |

结论：必须有一段代码跑在 Node 里替浏览器发请求、拉流、写盘。

### 为什么不需要后端框架

这段 Node 代码不需要 Hono / Express / Fastify。**Vite dev server 本身就是一个 Node HTTP server**，`configureServer` 钩子提供完整的 Connect 中间件栈，在里面 `node:crypto`、`node:fs`、`child_process`、`node:sqlite` 全部可用。既然它已经在跑（要提供页面和 HMR），再起第二个 server 纯属多余。

所以最终形态：**单进程、单端口、一条 `npm run dev`**。页面和 `/api/*` 由同一个 Vite server 提供。

要复制的 core 文件跟这个选择**完全无关** —— 它们是纯 TS 模块（`crypto.ts` 只 import `node:crypto`，`client.ts` 只 import axios 和 node 内置模块，axios 是 HTTP *客户端* 不是 server 框架）。最有力的证据是 neteasecli 本身没有任何 HTTP server，它是个 CLI，这些文件今天就在零框架环境里跑着。框架只影响 `plugin.ts` 那 ~80 行胶水，以后想抽成独立服务，`core/` 和 `download/` 一行都不用改。

### 已定的三个决策

1. **不动 neteasecli**，新建独立项目并复制一份 core。新项目本来就要改 API 行为（真无损、专辑简介、批量并发），两边会自然分叉，共享反而互相绑手。
2. 产物结构：**每首歌一个子文件夹**。
3. 后端逻辑写成 **Vite 插件中间件**，不引入后端框架。

---

## 二、core 从哪里来

源头：`/Users/lwl/Desktop/project/project replication/neteasecli`（v3.0.0，已发布 npm，本地已 build 且测试通过）。逐文件对照：

| 目标文件 | 来源 | 处理 |
|---|---|---|
| `server/core/crypto.ts` | `src/api/crypto.ts` | **原样复制** 90 行 |
| `server/core/client.ts` | `src/api/client.ts` | 复制，改 import 路径 + `download()` 增强 |
| `server/core/types.ts` | `src/types/index.ts` | 裁掉 CLI 专用类型，新增下载相关类型 |
| `server/core/logger.ts` | `src/output/logger.ts` | 重写成 8 行 shim（原版跟 CLI 输出模式耦合） |
| `server/core/auth.ts` | `src/auth/manager.ts` + `src/auth/storage.ts` | **合并**，去掉多 profile，新增手填入口 |
| `server/core/api/transform.ts` | 四个文件里重复的 `transformTrack` | **去重合并** |
| `server/core/api/user.ts` | `src/api/user.ts` | 只留 `getUserProfile` |
| `server/core/api/playlist.ts` | `src/api/playlist.ts` | 修 >1000 首截断 |
| `server/core/api/track.ts` | `src/api/track.ts` | 换 v1 端点拿真无损、补歌词参数 |
| `server/core/api/album.ts` | —— | **全新**，"歌曲简介"的实现 |
| `src/api/search.ts` | —— | **不复制**，这个项目用不到搜索 |
| `src/cli/*`、`src/player/*`、`src/output/json.ts` | —— | **不复制**，CLI 和 mpv 播放器无关 |

### 原样复制的两处务必别动

`crypto.ts` 的 `rsaEncrypt`（26-40 行）—— "反转明文 + 左补零到 128 字节 + `RSA_NO_PADDING`"，这是 weapi 最容易写错的地方，也顺带回答了"要不要换语言"：整个项目唯一可能需要原生库的就是这里，而 Node 内置 `crypto.constants.RSA_NO_PADDING` 直接支持，全程 TS 没有缺口。

`client.ts` 的两行注释掉的坑：12-14 行 `new http.Agent({ family: 4 })` 强制 IPv4（绕 CDN 的 IPv6 防盗链），168 行下载时带 `Referer: https://music.163.com/`。

### 必须改的七处

1. **`transformTrack` 去重** —— 这个函数在 `search.ts`/`track.ts`/`user.ts`/`playlist.ts` 里各写了一遍，逐字相同。合并到 `transform.ts`。

2. **大歌单静默截断** —— `playlist.ts:64` 的 `getPlaylistDetail` 传了 `n: 100000` 然后直接 `playlist.tracks?.map()`，但网易只在 `tracks` 里给前约 1000 首的完整信息，其余只给 `trackIds`。超过 1000 首的歌单会**悄无声息地少歌**。

3. **真无损拿不到** —— `track.ts:37-43` 的 `qualityBrMap` 里 `lossless: 999000, hires: 999000` 两个值相同，老端点 `/song/enhance/player/url` 按码率取，根本区分不了，也拿不到 FLAC。要换 `/song/enhance/player/url/v1` + `level` 参数。

4. **封面是缩略图** —— `picUrl` 默认小图，要追加 `?param=1000y1000`。

5. **歌词不全** —— `track.ts:96` 只传 `lv:-1, tv:-1`（原文+翻译），补 `rv:-1, kv:-1` 拿罗马音和逐字歌词。

6. **没有歌曲简介** —— 网易经典 API 里根本没这个字段，需要新写 `album.ts` 从专辑和歌手简介合成。

7. **auth 主路径换成手填** —— sweet-cookie 在这台机器上两条路都不通（Chrome 的 keychain 超时是 `chromeSqliteMac.js:18` 里写死的 3000ms，不读 `options.timeoutMs`，外面没法调；Safari 需要给终端授完全磁盘访问权限）。改成前端粘贴 `MUSIC_U` 为主，浏览器导入降级成一个备选按钮。

---

## 三、目录结构

```
project replication/netease-web/
├── package.json
├── vite.config.ts              ← 挂 apiPlugin()，server.host 锁 127.0.0.1
├── tsconfig.json               references 下面两个
├── tsconfig.app.json           前端：lib DOM，不给 node types
├── tsconfig.node.json          server/ + vite.config.ts：node types
├── index.html
├── README.md
│
├── server/                     普通 TS 模块，不是独立进程
│   ├── plugin.ts               Vite 插件 + 迷你路由 + SSE 工具
│   ├── core/
│   │   ├── crypto.ts           weapi/eapi/linuxapi 加密（原样复制）
│   │   ├── client.ts           axios 单例 + 加密请求 + 文件下载
│   │   ├── auth.ts             cookie 存取 + 登录态校验
│   │   ├── logger.ts           verbose/debug shim
│   │   ├── types.ts            所有共享类型
│   │   └── api/
│   │       ├── transform.ts    网易原始字段 → 内部 Track
│   │       ├── user.ts         账号信息
│   │       ├── playlist.ts     歌单列表 / 歌单详情（含全量补齐）
│   │       ├── track.ts        歌曲详情 / 播放地址 / 歌词
│   │       └── album.ts        专辑简介 / 歌手简介（带缓存）
│   ├── routes/
│   │   ├── auth.ts             /api/auth/*
│   │   ├── playlists.ts        /api/playlists/*
│   │   ├── tracks.ts           /api/tracks/*
│   │   ├── download.ts         /api/download/*
│   │   └── fs.ts               /api/fs/*
│   └── download/
│       ├── job.ts              任务状态机 + SSE 广播中枢
│       ├── pipeline.ts         批量调度 + 单首歌流水线
│       ├── tag.ts              ffmpeg 内嵌封面/歌词/元数据
│       ├── db.ts               node:sqlite 幂等记录
│       └── naming.ts           文件名 sanitize
│
└── src/                        前端
    ├── main.tsx
    ├── App.tsx
    ├── index.css               Tailwind 入口
    ├── api/client.ts           fetch 封装
    ├── store/selection.ts      Zustand（勾选集、parts、quality、目录）
    ├── hooks/
    │   ├── useAuth.ts
    │   ├── usePlaylists.ts
    │   └── useJob.ts           SSE 订阅
    └── components/
        ├── LoginPanel.tsx
        ├── PlaylistGrid.tsx
        ├── TrackTable.tsx      虚拟滚动
        ├── DownloadDrawer.tsx
        ├── DirPicker.tsx
        └── JobPanel.tsx
```

两个 tsconfig 拆开不是洁癖：前端不给 `node` types，能防止 React 组件里手滑 `import fs from 'node:fs'` —— 那会编译通过但运行时炸。

---

## 四、后端逐文件函数清单

### `server/core/types.ts` — 类型总表

无函数，只有类型。从 neteasecli 继承 `Artist` / `Album` / `Track` / `Playlist` / `Lyric` / `UserProfile` / `CookieData`，删掉 `SearchType` / `SearchResult` / `ApiResponse` / `ExitCode`（CLI 专用）。

`Lyric` 加两个字段：`romalrc?`（罗马音）、`klyric?`（逐字）。`Quality` 加 `'jymaster'`（超清母带）。新增：

```ts
export interface TrackUrlInfo {
  id: string;
  url: string | null;      // null 是常态：无版权 / 需要 VIP
  br: number;
  size: number;
  type: string;            // 'flac' | 'mp3' | ...
  level?: string;          // 实际给到的档位，可能低于请求的
  fee?: number;            // 收费标记
}

export interface SongInfo {              // 就是 info.json 的内容
  track: Track;
  publishTime?: number;
  albumDescription?: string;
  artistDescription?: string;
  playlist?: { id: string; name: string };
}

export type DownloadPart = 'audio' | 'cover' | 'lyric' | 'info';
export type TrackStatus  = 'pending' | 'running' | 'done' | 'skipped' | 'failed';

export interface JobTrackState {
  trackId: string;
  name: string;            // "晴天 - 周杰伦"，给 UI 显示
  status: TrackStatus;
  reason?: string;         // skipped 的原因：'no-copyright' | 'vip' | 'already'
  error?: string;
  bytes?: number;
  dir?: string;            // 落盘目录，完成后填
}

export interface Job {
  id: string;
  playlistId: string;
  playlistName: string;
  destDir: string;
  parts: Record<DownloadPart, boolean>;
  quality: Quality;
  tracks: JobTrackState[];
  status: 'running' | 'done' | 'cancelled';
  createdAt: number;
}

export type JobEvent =
  | { type: 'track'; track: JobTrackState }
  | { type: 'done';  summary: { done: number; skipped: number; failed: number } }
  | { type: 'error'; message: string };
```

### `server/core/logger.ts` — 日志 shim

原版跟 CLI 的输出模式耦合，这里重写。`client.ts` 里的 `verbose()` / `debug()` 调用因此可以一行不改地复制过来。

| 函数 | 作用 |
|---|---|
| `verbose(msg: string): void` | `NETEASE_VERBOSE` 或 `NETEASE_DEBUG` 环境变量存在时写 stderr |
| `debug(msg: string): void` | 只在 `NETEASE_DEBUG` 时写 stderr |

写 stderr 而不是 stdout，避免和 Vite 自己的输出抢行。

### `server/core/crypto.ts` — 加密（原样复制，90 行）

| 函数 | 导出 | 作用 |
|---|---|---|
| `createSecretKey(size)` | 私有 | 生成 16 位随机字母数字串 |
| `aesEncrypt(text, key, iv)` | 私有 | AES-128-CBC → base64 |
| `rsaEncrypt(text, pubKey)` | 私有 | **反转明文 → 左补零到 128 字节 → `RSA_NO_PADDING`** → hex |
| `md5(text)` | 私有 | eapi 用 |
| `weapi(data)` | ✓ | 主通道。两层 AES（先固定 `PRESET_KEY`，再随机 `secretKey`）+ RSA 包 `secretKey`，返回 `{ params, encSecKey }` |
| `linuxapi(data)` | ✓ | AES-128-ECB，包 `{method,url,params}`。当前无调用方，保留 |
| `eapi(url, data)` | ✓ | 移动端通道。当前无调用方，**M4 探索单曲百科时要用** |

`eapi` 在 neteasecli 里是死代码（全项目没有一处传 `{ crypto: 'eapi' }`），但通道是完整可用的，所以保留而不是删掉。

### `server/core/client.ts` — HTTP 客户端

模块级两个 agent 强制 IPv4，`BASE_URL = 'https://music.163.com'`，桌面版 Chrome UA。

| 成员 | 作用 |
|---|---|
| `class ApiClient` | axios 实例 + 会话 cookie 累积 |
| `constructor()` | 建 axios 实例，默认头带 UA / `x-www-form-urlencoded` / Referer |
| `updateTimeout(ms)` | 改 `client.defaults.timeout` |
| `private collectCookies(res)` | 从响应的 `set-cookie` 里抽 `k=v` 存进 `sessionCookies` |
| `private getCookieHeader(endpoint?)` | 拼 `os=pc` + 随机 `sDeviceId` + `__remember_me=true` + 用户 `MUSIC_U` + 累积的会话 cookie |
| `request<T>(endpoint, data?, options?)` | **核心**。按 `options.crypto`（默认 weapi）选通道加密 → POST → 收 cookie → 检查业务 `code !== 200` → 归一化 HTTP 错误（401 → 需重新登录，403 → cookie 过期） |
| `download(url, dest, onProgress?)` | ★ 改造版。见下 |
| `getApiClient()` | 单例 |
| `setRequestTimeout(ms)` | 全局超时 |

`download()` 相对原版的三处改造：

1. **返回字节数** `Promise<number>`，进度面板要显示大小
2. **`onProgress?: (bytes: number) => void`** 回调，`response.data.on('data', ...)` 累加
3. **先写 `dest + '.part'`，`pipeline` 成功后 `fs.renameSync`** —— 否则中途断网会留下一个看起来完整的截断文件，而 sqlite 已经记成 done，之后永远不会重下。这是幂等设计的必要配套。

保留原版的 120s 超时、IPv4 agent、`Referer: https://music.163.com/`。

### `server/core/auth.ts` — 认证（合并 manager.ts + storage.ts）

配置目录 `~/.config/netease-web/`，会话文件 `session.json`（权限 **0600**）。去掉 neteasecli 的多 profile 机制 —— Web App 只服务一个人，那套 `setProfile` + 单例失效的绕圈子逻辑（`storage.ts:10-16` 用动态 import 躲循环依赖）没必要带过来。

存储层：

| 函数 | 作用 |
|---|---|
| `ensureConfigDir()` | `mkdirSync(recursive)`，目录权限 0700 |
| `saveCookies(cookies)` | 写 `session.json`，`{ mode: 0o600 }` |
| `loadCookies()` | 读，解析失败返回 `null` 而不是抛 |
| `clearCookies()` | 删文件 |

管理层 `class AuthManager`：

| 方法 | 作用 |
|---|---|
| `constructor()` | 启动时 `loadCookies()` |
| `setMusicU(raw: string)` | ★ **新增，主登录路径**。见下 |
| `importFromBrowser(profile?)` | 备选。动态 import `@steipete/sweet-cookie`，只要 `names: ['MUSIC_U']` |
| `checkAuth()` | 调 `getUserProfile()` 验证 cookie 是否还活着，返回 `{ valid, userId?, nickname?, avatarUrl?, error? }` |
| `isAuthenticated()` | 纯本地判断有没有 `MUSIC_U`，不发网络请求 |
| `getCookieString()` | 给 `client.getCookieHeader()` 用 |
| `getSource()` | 'manual' / 'chrome' / 'safari' …，UI 显示 |
| `logout()` | 清内存 + 删文件 |
| `getAuthManager()` | 单例 |

`setMusicU(raw)` 要做输入清洗，因为人从 devtools 里抄 cookie 的方式五花八门：

- 粘的可能是裸值 `00A1B2C3...`
- 也可能是 `MUSIC_U=00A1B2C3...`
- 也可能是整条 Cookie 头 `NMTID=xxx; MUSIC_U=00A1...; __csrf=yyy`
- 还可能带首尾引号或换行

所以：trim → 去首尾引号 → 如果含 `MUSIC_U=` 就用正则 `/MUSIC_U=([^;\s]+)/` 抽出来 → 否则当裸值 → 校验非空且不含 `;` 和空白 → 存盘。抽不出来就抛一个说清楚该抄哪个值的错误。

### `server/core/api/transform.ts` — 字段转换（去重后的唯一一份）

| 函数 | 作用 |
|---|---|
| `transformTrack(raw: RawTrack): Track` | 网易两套字段名兼容：`ar \|\| artists`、`al \|\| album`、`dt \|\| duration`，数字 id 转字符串，拼 `uri: netease:track:{id}` |
| `hiresCoverUrl(picUrl?, size = 1000): string \| undefined` | 先剥掉已有的 `?param=`，再拼 `?param={size}y{size}` |

`RawTrack` 接口就是原来在四个文件里各抄一遍的那个内联类型，抽出来导出。

### `server/core/api/user.ts` — 账号

| 函数 | 作用 |
|---|---|
| `getUserProfile(): Promise<UserProfile>` | `/nuser/account/get` → `{ id, nickname, avatarUrl }`。同时充当 cookie 有效性探针 |

原版的 `getLikedTrackIds` / `likeTrack` / `getRecentTracks` 不复制 —— "我喜欢的音乐"本身就是一个歌单，会出现在 `getUserPlaylists()` 结果里。

### `server/core/api/playlist.ts` — 歌单

| 函数 | 作用 |
|---|---|
| `getUserPlaylists(uid?): Promise<Playlist[]>` | 不传 uid 时先 `/nuser/account/get` 拿自己的。再 `/user/playlist` `{ uid, limit: 1000, offset: 0 }`。返回不带 `tracks` 的轻量列表 |
| `getPlaylistDetail(id): Promise<Playlist>` | ★ **全量补齐版**，见下 |

`getPlaylistDetail` 的五步（修 >1000 首静默截断）：

```
1. /v6/playlist/detail { id, n: 100000 }
2. allIds   = playlist.trackIds.map(t => String(t.id))     ← 全量、有序，这是权威顺序
3. haveMap  = new Map(playlist.tracks.map(t => [id, transformTrack(t)]))
              ← 只有前约 1000 首有完整信息
4. missing  = allIds.filter(id => !haveMap.has(id))
   分批 500 → getTrackDetails(batch) → 塞进 haveMap
5. tracks   = allIds.map(id => haveMap.get(id)).filter(Boolean)
              ← 按 allIds 重新索引
```

第 5 步的重新索引不是多余的：`/song/detail` **不保证返回顺序和请求顺序一致**，如果直接把批量结果 concat 上去，歌单顺序会乱，而顺序直接决定文件夹前缀编号（`01 晴天`、`02 稻香`）。

### `server/core/api/track.ts` — 歌曲

| 函数 | 作用 |
|---|---|
| `getTrackDetails(ids: string[]): Promise<Track[]>` | `/song/detail`，一次最多 500 个 id。给 playlist 补齐用 |
| `getTrackUrls(ids, quality): Promise<TrackUrlInfo[]>` | ★ 换 `/song/enhance/player/url/v1`，批量。见下 |
| `getTrackUrl(id, quality): Promise<TrackUrlInfo>` | 单首便利封装，内部转调 `getTrackUrls([id])` |
| `getLyric(id): Promise<Lyric>` | ★ `/song/lyric` 参数补全成 `{ id, lv: -1, tv: -1, rv: -1, kv: -1 }` |
| `pickExtension(info): string` | 优先看 `info.type`，其次从 url 路径猜，兜底 `'mp3'` |

`getTrackUrls` 是这次相对 neteasecli 最实质的改动。旧端点 `/song/enhance/player/url` 传 `br`（码率数字），而 `qualityBrMap` 里 `lossless` 和 `hires` 都是 `999000`，两个档位无法区分，FLAC 拿不到。新端点直接传档位名：

```ts
// Quality 的取值刚好就是 level 的取值，不需要映射表
await client.request('/song/enhance/player/url/v1', {
  ids: JSON.stringify(ids),
  level: quality,          // 'standard' | 'higher' | 'exhigh' | 'lossless' | 'hires' | 'jymaster'
  encodeType: 'flac',
});
```

⚠️ **这个端点的参数名和返回结构我没有联网验证过**，是待验证项第 1 条。如果不成立，音质就只能停在 `exhigh` 320k。

**为什么批量取 url 而不是每首单独取**：一次请求能拿几十首的地址，请求数直接降一个数量级，还能在下载开始之前就把"哪些歌没版权"全部标出来推给 UI，用户不用等到下到第 80 首才发现一半是灰的。流水线因此设计成"先批量取址，再并发下载"两段。

### `server/core/api/album.ts` — 歌曲简介（全新）

网易经典 API 里**没有单曲简介这个字段**，`/song/detail` 的返回里就没有。能稳定拿到的只有专辑简介和歌手简介，所以"歌曲简介"是合成出来的。

| 函数 | 作用 |
|---|---|
| `getAlbumDescription(albumId): Promise<string \| undefined>` | `/album/{id}` → `album.description` |
| `getArtistDescription(artistId): Promise<string \| undefined>` | `/artist/desc` → `briefDesc`，没有就把 `introduction[]` 的 `{ti, txt}` 拼成段落 |
| `getSongInfo(track, playlist?): Promise<SongInfo>` | 组装 `info.json`：元数据 + 专辑简介 + 歌手简介（取第一位歌手） |

两个模块级缓存：

```ts
const albumCache  = new Map<string, Promise<string | undefined>>();
const artistCache = new Map<string, Promise<string | undefined>>();
```

**缓存 Promise 而不是缓存结果值** —— 一个歌单里同专辑的歌常常并发在跑，缓存值的话它们会同时穿透去发一样的请求；缓存 Promise 天然把并发请求合并成一次。一张 12 首歌的专辑因此只发 1 次请求而不是 12 次。

单曲级的"歌曲百科"是较新的 eapi 接口，端点和参数我没验证过，**不要一开始就依赖它**。通道倒是现成的（`crypto.ts` 的 eapi 完整可用、`client.request` 支持 `{ crypto: 'eapi' }`），留作 M4 探索。

### `server/download/naming.ts` — 文件名处理

| 函数 | 作用 |
|---|---|
| `sanitizeName(name, maxLen = 80): string` | 见下 |
| `trackDirName(index, track): string` | `"01 晴天 - 周杰伦"`，序号 `padStart(2, '0')`（超 99 首自动变 3 位），多歌手用 `, ` 连接后整体 sanitize |
| `uniqueDir(parent, name): string` | 目标已存在且不是同一首歌时追加 ` (2)`，避免同名歌互相覆盖 |

`sanitizeName` 要处理的具体情况，每一条都是真实会炸的：

- 替换 `/ \ : * ? " < > |` 为 `_` —— 中文歌名里的斜杠很常见（`爱/恨`），`/` 会直接让 `mkdir` 失败
- 去掉 ASCII 控制字符
- 折叠连续空白为单个空格
- **去掉结尾的空格和点** —— macOS 能建但 Finder 显示异常，同步到 Windows/exFAT 会直接报错
- 截断到 80 字符（按码点不是字节，别把中文切半个）
- 空字符串兜底成 `'unknown'`
- 避开 Windows 保留名（`CON` `PRN` `AUX` `NUL` `COM1..9` `LPT1..9`），加下划线前缀

### `server/download/db.ts` — 幂等记录（node:sqlite）

用 Node 内置的 `node:sqlite`（`DatabaseSync`），零依赖。库文件 `~/.config/netease-web/downloads.db`。

```sql
CREATE TABLE IF NOT EXISTS downloads (
  track_id TEXT    NOT NULL,
  dest_dir TEXT    NOT NULL,
  parts    TEXT    NOT NULL,   -- 排序后的 'audio,cover,info,lyric'
  quality  TEXT    NOT NULL,
  file_dir TEXT    NOT NULL,   -- 实际落盘目录，用于存在性校验
  bytes    INTEGER,
  done_at  INTEGER NOT NULL,
  PRIMARY KEY (track_id, dest_dir)
);
```

| 函数 | 作用 |
|---|---|
| `getDb(): DatabaseSync` | 懒初始化 + 建表 |
| `isDone(trackId, destDir, parts, quality): boolean` | 见下 |
| `markDone(rec): void` | `INSERT OR REPLACE` |
| `forget(trackId, destDir): void` | 删记录，给"重试这首"用 |
| `forgetDir(destDir): void` | 删整个目标目录的记录，给"全部重下"用 |

`isDone` 不能只查数据库，三个条件都要满足才算已完成：

1. 有记录，且 `quality` 相同
2. 记录的 `parts` **是本次请求 parts 的超集** —— 上次只下了音频，这次要音频+歌词，得补歌词
3. **`fs.existsSync(file_dir)` 为真** —— 用户手动删了文件夹就该重下，否则"数据库说下过了"会变成永远拿不到文件

`parts` 存成排序后的逗号串（`'audio,cover,info,lyric'`），比较时转 Set 做超集判断。

> `node:sqlite` 在 Node 24 是稳定 API（neteasecli 的 `engines` 就写了 `>=24.0.0`）。如果实际 node 版本更低，退路是换成一个 `downloads.json`（`Record<string, Record<string, Rec>>`），接口签名完全不变，只换实现。

### `server/download/tag.ts` — ffmpeg 内嵌

ffmpeg 已装在 `/opt/homebrew/bin/ffmpeg`，用 `promisify(execFile)` 调，不走 shell（避免歌名里的引号和分号被解释）。

| 函数 | 作用 |
|---|---|
| `hasFfmpeg(): Promise<boolean>` | `ffmpeg -version` 探测一次并缓存结果 |
| `embedTags(opts): Promise<void>` | 主入口，`opts = { audioPath, coverPath?, lyricText?, track }` |
| `buildArgs(...)` | 按容器（flac / mp3 / m4a）拼参数 |

三点实现约束：

1. **ffmpeg 不能原地改文件**。写到 `audioPath + '.tag.' + ext`，成功后 `renameSync` 覆盖原文件；失败就删掉临时文件，原文件保持不动。
2. **mp3 要 `-id3v2_version 3`**，否则 v2.4 的标签有些播放器不认；封面走 `-map 1 -c:v mjpeg -disposition:v attached_pic`。
3. **FLAC 内嵌封面 ffmpeg 处理得比较别扭**，不同版本行为不一致。因为产物结构本来就是"每首一个文件夹、`cover.jpg` 独立成文件"，**内嵌只是加分项**：失败时记一条 warning 继续，绝不让整首歌算失败。

歌词以 `-metadata lyrics=` 写入（写原文 `lrc`，不写翻译，避免时间轴重复）。

### `server/download/job.ts` — 任务状态机 + SSE 广播中枢

模块级两个 Map。任务状态只活在内存里，不落盘。

```ts
const jobs      = new Map<string, Job>();
const listeners = new Map<string, Set<(e: JobEvent) => void>>();
const aborters  = new Map<string, AbortController>();
```

| 函数 | 作用 |
|---|---|
| `createJob(opts): Job` | 生成 `crypto.randomUUID()` 的 id，把 tracks 全部初始化成 `pending` |
| `getJob(id): Job \| undefined` | 快照查询，SSE 断线重连后补状态用 |
| `listJobs(): Job[]` | 调试用 |
| `updateTrack(jobId, trackId, patch)` | 改一首歌的状态**并自动 `emit`**，保证内存状态和推送不会脱节 |
| `subscribe(jobId, fn): () => void` | 注册监听，返回取消函数 |
| `emit(jobId, event)` | 广播给所有监听者，单个监听者抛错不影响其他人 |
| `finishJob(jobId)` | 状态置 `done`，统计 `{done, skipped, failed}`，emit `done` 事件 |
| `cancelJob(id)` | `aborters.get(id)?.abort()`，状态置 `cancelled` |
| `isCancelled(id): boolean` | 流水线在每个步骤之间查这个 |

`updateTrack` 把"改状态"和"推事件"绑在一起，是为了避免最常见的一类 bug：改了内存忘了推送，UI 卡在"下载中"不动。

⚠️ 内存态意味着 **dev server 重启会清空所有任务**。而 Vite 会监听 `vite.config.ts` 的整个依赖图，所以改 `server/` 下任何文件都会触发重启 + 整页刷新（不是 HMR）。这是纯 Vite 方案唯一实质的开发期代价，对策见前端的 `store/selection.ts`。

### `server/download/pipeline.ts` — 下载流水线

| 函数 | 作用 |
|---|---|
| `runJob(job): Promise<void>` | 批量调度，见下 |
| `downloadOne(job, track, index, urlInfo?)` | 单首歌的完整流水线 |
| `withRetry(fn, times = 2, delayMs = 800)` | 通用重试，指数退避 |
| `writePlaylistJson(job, playlist)` | 顶层 `playlist.json`：歌单元信息 + 完整曲目清单 + 本次任务参数 |
| `sleep(ms)` | 请求间隔 |

`runJob` 的流程：

```
1. mkdir  destDir/sanitizeName(playlistName)/
2. writePlaylistJson()
3. 若 parts.audio：
     分批调 getTrackUrls(ids, quality)   ← 一次几十首
     url === null 的立刻 updateTrack(status:'skipped', reason:'no-copyright')
     并把有效的 TrackUrlInfo 存进 Map 传给下一步
4. p-limit(3) 并发跑 downloadOne，每次启动前 sleep(250)
5. finishJob()
```

`downloadOne` 的流程：

```
1. isCancelled(job.id) → 直接返回
2. isDone(...) → updateTrack(status:'skipped', reason:'already')，返回
3. mkdir  <歌单目录>/trackDirName(index, track)/
4. Promise.all 拉勾选的部分：
     audio → client.download(url, 'audio.'+ext, onProgress)
     cover → client.download(hiresCoverUrl(track.album.picUrl), 'cover.jpg')
     lyric → getLyric() → 写 'lyric.lrc'（原文）+ 有翻译时写 'lyric.zh.lrc'
     info  → getSongInfo() → 写 'info.json'
5. hasFfmpeg() && parts.audio && (cover||lyric) → embedTags()   ← 失败只 warning
6. markDone()
7. updateTrack(status:'done', bytes, dir)
```

**并发和限流**：`p-limit(3)` + 每首之间 250ms 间隔 + 单步失败重试 2 次。网易会限流，并行发几十个 url 请求很容易返回一堆 `null`，**表现上和"全都没版权"一模一样**，极难 debug —— 这是保守并发的真实原因，不是性能洁癖。

**失败容忍**：单首歌任何一步失败都只把这首标 `failed` 并记 `error`，绝不中断整批。`url === null` 更是常态（无版权、需要 VIP），归到 `skipped` 而不是 `failed`，UI 上用不同颜色区分。

### `server/plugin.ts` — Vite 插件 + 迷你路由

这就是"框架"的全部，约 80 行。

| 函数 | 作用 |
|---|---|
| `apiPlugin(): Plugin` | 导出给 `vite.config.ts` |
| `readBody<T>(req): Promise<T>` | Connect 不带 body parser，手动收流 + `JSON.parse`，限 1MB |
| `json(res, data, status = 200)` | 统一 JSON 响应 |
| `fail(res, status, message)` | 统一错误响应 `{ error: message }` |
| `matchRoute(method, pathname)` | 按 `/` 切段比对，`:xxx` 段收进 `params` |
| `sse(res)` | 返回 `{ send(event, data), close() }` |

```ts
export function apiPlugin(): Plugin {
  return {
    name: 'netease-api',
    configureServer(server) {
      // 直接加在钩子体里 = 排在 Vite 内部中间件之前。
      // 如果 return 一个函数延后注册，/api/* 会被 SPA fallback 抢去返回 index.html
      server.middlewares.use('/api', async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const hit = matchRoute(req.method ?? 'GET', url.pathname);
        if (!hit) return fail(res, 404, 'Not found');
        try {
          const result = await hit.handler({ req, res, url, params: hit.params,
                                             body: () => readBody(req) });
          if (result !== undefined) json(res, result);   // SSE 分支自己接管 res，返回 undefined
        } catch (e) {
          fail(res, 500, e instanceof Error ? e.message : String(e));
        }
      });
    },
  };
}
```

`sse(res)` 的要点：`writeHead` 带 `Content-Type: text/event-stream` + `Cache-Control: no-cache` + `Connection: keep-alive`，然后 **`res.flushHeaders()`**（不调的话首个事件可能被缓冲住），并且**绝不调 `next()`** —— 这个响应由我们全权接管。另外注册 `req.on('close', unsubscribe)`，浏览器关页面时要摘掉监听器，不然 Map 会漏。

`configureServer` 只在 dev 生效，`vite build` 出来的 `dist/` 是纯静态的、`/api` 不存在。本地自用工具"永远 `npm run dev`"完全成立；真要脱离 dev，加一个 `configurePreviewServer` 复用同一份中间件（几行），或者套个 Hono 抽成独立进程 —— `core/` 和 `download/` 一行都不用改。

### `server/routes/*.ts` — 路由表

每个模块导出一个 `[method, pattern, handler][]` 数组，`plugin.ts` concat 起来。

**`routes/auth.ts`**

| 路由 | 处理 |
|---|---|
| `POST /api/auth/cookie` | `body.musicU` → `setMusicU()` → `checkAuth()`，无效则不落盘并返回错误 |
| `POST /api/auth/import` | `importFromBrowser(body.profile)`，sweet-cookie 备选路径 |
| `GET /api/auth/status` | `checkAuth()` → `{ authenticated, nickname, avatarUrl, source }` |
| `POST /api/auth/logout` | `logout()` |

**`routes/playlists.ts`**

| 路由 | 处理 |
|---|---|
| `GET /api/playlists` | `getUserPlaylists()` |
| `GET /api/playlists/:id` | `getPlaylistDetail(params.id)`，含 >1000 首补齐 |

**`routes/tracks.ts`**

| 路由 | 处理 |
|---|---|
| `GET /api/tracks/:id/lyric` | `getLyric()` |
| `GET /api/tracks/:id/info` | `getTrackDetails([id])` → `getSongInfo()`，给"下载前预览简介"用 |

**`routes/download.ts`**

| 路由 | 处理 |
|---|---|
| `POST /api/download` | 校验目录 → `createJob()` → **不 await 地** `runJob(job)` → 立刻返回 `{ jobId }` |
| `GET /api/download/:id` | `getJob()` 快照，SSE 重连补状态 |
| `GET /api/download/:id/events` | `sse()` + `subscribe()`；先把当前全量状态推一遍再进增量 |
| `POST /api/download/:id/cancel` | `cancelJob()` |

`POST /api/download` 请求体：`{ playlistId, trackIds: string[], parts: {audio,cover,lyric,info}, quality, destDir }`。

**`routes/fs.ts`**

| 路由 | 处理 |
|---|---|
| `GET /api/fs/default` | 返回 `~/Music/netease-web` |
| `GET /api/fs/list?path=` | 列子目录 → `{ path, parent, dirs }`，只列目录不列文件 |

---

## 五、前端逐文件函数清单

栈沿用 `Gali-Player` 里已经验证过的组合：Vite + React + TS + Tailwind + lucide-react，加 TanStack Query（服务端数据缓存）+ Zustand（勾选集这类纯本地状态）+ TanStack Virtual（长列表）。不引 react-router —— 三个视图用一个 `view` state 切就够了。

### `src/api/client.ts` — fetch 封装

| 函数 | 作用 |
|---|---|
| `get<T>(path): Promise<T>` | 统一解 JSON，非 2xx 时抛出后端返回的 `error` 文案 |
| `post<T>(path, body?): Promise<T>` | 同上 |
| `openEvents(jobId, onEvent): () => void` | `new EventSource('/api/download/'+id+'/events')`，返回关闭函数 |

同源请求，不需要配 proxy 也不需要 CORS —— 页面和 API 是同一个 Vite server。

### `src/store/selection.ts` — Zustand

| 状态 / 动作 | 作用 |
|---|---|
| `playlistId: string \| null` | 当前打开的歌单 |
| `selected: Set<string>` | 勾选的 trackId |
| `toggle(id)` | 单首翻转 |
| `selectAll(ids)` / `invert(ids)` / `deselect(ids)` | 作用域是"调用方给的这批 id"，搜索时给的是筛出来的那些：`selectAll` 取并集（不是覆盖）、`invert` 逐个翻转（不是在 ids 里取补集）、`deselect` 只去掉这批。没搜索时 ids 是整个歌单，和旧行为一致 |
| `clear()` | 清空全部，跟筛选无关 |
| `parts: Record<DownloadPart, boolean>` | 默认 audio+cover+lyric 开、info 开 |
| `quality: Quality` | 默认 `'exhigh'` |
| `destDir: string` | 首次从 `/api/fs/default` 填 |

**必须包 `persist` 中间件存 localStorage**。原因很具体：改 `server/` 下任何文件会触发 Vite 整体重启和整页刷新，M2 调流水线时几乎每改一行就刷一次 —— 没有 persist 的话每次都丢掉"从 300 首里挑好的 40 首"。`Set` 不能直接 JSON 序列化，要在 `partialize` / `merge` 里转数组。

### `src/hooks/*`

| 文件 | 导出 | 作用 |
|---|---|---|
| `useAuth.ts` | `useAuthStatus()` | `useQuery(['auth'])` → `/api/auth/status` |
| | `useLoginByCookie()` | `useMutation` → `POST /api/auth/cookie`，成功后 invalidate `['auth']` |
| | `useImportFromBrowser()` | `useMutation` → `POST /api/auth/import` |
| | `useLogout()` | `useMutation` → `POST /api/auth/logout` |
| `usePlaylists.ts` | `usePlaylists()` | `useQuery(['playlists'])` |
| | `usePlaylistDetail(id)` | `useQuery(['playlist', id])`，`enabled: !!id`，`staleTime` 给长一点（大歌单补齐要发好几个请求，别反复拉） |
| `useJob.ts` | `useJob(jobId)` | 见下 |

`useJob` 是唯一有点门道的 hook：先 `GET /api/download/:id` 拿全量快照塞进本地 state，再 `openEvents` 订阅增量，收到 `track` 事件就按 trackId 局部替换，收到 `done` 就停止订阅。用本地 `useState` 而不是 Query 缓存，因为这是推送流不是拉取源。`useEffect` 的清理函数里必须调返回的关闭函数，否则切走再回来会叠加多个 EventSource。

### `src/components/*`

| 组件 | 职责 |
|---|---|
| `LoginPanel.tsx` | `MUSIC_U` 粘贴框（`type="password"`，提交后立刻清空 state）+ "从浏览器导入"备选按钮 + **手把手的抄 cookie 图文说明**（devtools → Application → Cookies → music.163.com → MUSIC_U）。这是用户第一眼看到的东西，说明写清楚比什么都重要 |
| `PlaylistGrid.tsx` | 封面网格，显示歌单名和 `trackCount`，点进详情 |
| `TrackTable.tsx` | 曲目表格，每行 checkbox + 序号 + 歌名 + 歌手 + 专辑 + 时长。**必须用 `@tanstack/react-virtual`** —— 上千首歌全渲染 DOM 会直接卡死。搜索框（歌名 / 歌手 / 专辑，纯本地过滤，见下面"歌单内搜索"）+ 工具条：全选 N / 反选 N / 取消 N / 清空 / 已选 N 首 |
| `DownloadDrawer.tsx` | 四个 parts 复选框 + 音质下拉（标注哪些档位需要会员）+ 目标目录（带 `DirPicker`）+ "开始下载"按钮 |
| `DirPicker.tsx` | 由 `/api/fs/list` 驱动的目录浏览器，面包屑 + 子目录列表 + 上一级 |
| `JobPanel.tsx` | 进度列表，每首一行状态徽章：等待 / 下载中 / 完成 / **跳过（无版权）** / 失败。顶部总进度条 + 取消按钮 + 失败项的"重试"按钮 |

`skipped` 和 `failed` 在 UI 上必须用不同颜色和不同文案区分：前者是"网易不给你这首歌"（灰色，正常现象，占比可能很高），后者是"我们的代码或网络出了问题"（红色，需要关注）。混在一起会让用户以为程序坏了。

---

## 六、三条主链路走一遍

**登录**

```
LoginPanel 粘贴 MUSIC_U
  → POST /api/auth/cookie
  → AuthManager.setMusicU()  清洗输入（裸值 / MUSIC_U= / 整条 Cookie 头都吃）
  → checkAuth() → getUserProfile() → client.request('/nuser/account/get')
  → weapi 加密 + Cookie 头拼装 → music.163.com
  → 有效才 saveCookies() 落盘 0600
  → 返回 { authenticated, nickname, avatarUrl }
```

**浏览歌单**

```
PlaylistGrid → GET /api/playlists → getUserPlaylists()
  → /nuser/account/get 拿 uid → /user/playlist
点进某个歌单
  → GET /api/playlists/:id → getPlaylistDetail()
  → /v6/playlist/detail 拿 trackIds（权威顺序）+ 前 1000 首详情
  → 缺的分批 500 走 /song/detail 补齐 → 按 trackIds 重新索引
  → TrackTable 虚拟滚动渲染
```

**下载**

```
DownloadDrawer 点开始
  → POST /api/download { playlistId, trackIds, parts, quality, destDir }
  → 校验 destDir 在 homedir 之下
  → createJob() → 立刻返回 jobId（不等下载完）
  → 后台 runJob()：
       mkdir 歌单目录 → writePlaylistJson()
       批量 getTrackUrls() → null 的直接标 skipped 推给 UI
       p-limit(3) 跑 downloadOne，每首间隔 250ms
  → 前端 useJob(jobId) 拿快照 + 订阅 SSE
  → JobPanel 逐行更新
```

产物：

```
~/Music/netease-web/我喜欢的音乐/
├── 01 晴天 - 周杰伦/
│   ├── audio.flac
│   ├── cover.jpg
│   ├── lyric.lrc
│   └── info.json
├── 02 稻香 - 周杰伦/
└── playlist.json
```

---

## 七、依赖清单

```jsonc
"dependencies": {
  "axios": "^1.6.0",              // core 复制过来就带
  "p-limit": "^6.1.0",            // 并发闸门
  "react": "^19.0.0",
  "react-dom": "^19.0.0",
  "@tanstack/react-query": "^5.59.0",
  "@tanstack/react-virtual": "^3.10.0",
  "zustand": "^5.0.0",
  "lucide-react": "^0.460.0"
},
"devDependencies": {
  "vite": "^6.0.0",
  "@vitejs/plugin-react": "^4.3.0",
  "@tailwindcss/vite": "^4.0.0",  // Tailwind v4 的 Vite 插件
  "tailwindcss": "^4.0.0",
  "typescript": "^5.6.0",
  "@types/node": "^22.0.0",
  "@types/react": "^19.0.0",
  "@types/react-dom": "^19.0.0"
},
"optionalDependencies": {
  "@steipete/sweet-cookie": "^0.1.0"   // 只有"从浏览器导入"用得到
}
```

依赖清单短得反常，因为**没有后端框架**：`node:crypto` / `node:fs` / `node:sqlite` / `child_process` 全是内置的，ffmpeg 是外部二进制不占依赖。版本号是写文档时的合理值，实际装的时候让 npm 决定。

Tailwind v4 的路子最省事：装 `@tailwindcss/vite` 插件，`index.css` 里一行 `@import "tailwindcss";`，不需要 `tailwind.config.js` 也不需要 postcss 配置。要是想用 v3，得回到 postcss + config 那套。

---

## 八、安全边界（不是可选项）

**绝不给 vite 传 `--host`。** 这条在纯 Vite 方案里比用独立后端时更要紧。Vite 默认只监听 `localhost`，但 `--host` 是很多人为了"用手机看一下"随手加的标志，而且**CLI 标志会覆盖 config 里的 `server.host`**。这个 dev server 现在不只是页面服务器，它是"用你的网易云账号执行任意操作 + 读你的家目录"的代理 —— 暴露到局域网意味着同一个 WiFi 下任何人都能用你的账号下歌、改你的歌单。`vite.config.ts` 里显式写 `server: { host: '127.0.0.1' }` 表明意图，但真正的保障是 `package.json` 的 dev 脚本里没有 `--host`。

**`MUSIC_U` 绝不返回给前端**，也不进 localStorage。它等于账号完全控制权：能改密码、清空歌单、发评论。所以：

- `/api/auth/status` 只回昵称、头像和一个布尔值，永远不回 cookie 值本身
- 落盘 `session.json` 权限 0600，目录 0700
- `LoginPanel` 提交后立刻清掉输入框的 state
- 日志里不打 cookie 值（`logger.ts` 的调用点要注意别把整个 Cookie 头 debug 出来）

**`/api/fs/list` 要防路径穿越。** 虽然是本地工具，它确实暴露了任意目录读取能力。`path.resolve` 之后校验必须落在 `os.homedir()` 前缀之下，拒绝含 `..` 的输入。`POST /api/download` 的 `destDir` 走同一套校验。

**版权**：下载的音频自用，别分发。

---

## 九、待验证项（写代码前先确认）

这四条我都**没有联网确认过**。验证成本很低：在 neteasecli 里写个一次性 tsx 脚本，它的 `client.request()` 接受任意 endpoint，直接打就行，跑完删掉。

| # | 要确认什么 | 不成立的后果 |
|---|---|---|
| 1 | `/song/enhance/player/url/v1` 的 `level` 取值和返回结构 | 真无损做不了，音质只能停在 `exhigh` 320k，UI 文案要改 |
| 2 | 非会员账号请求 `lossless`/`hires` 的实际降级行为 | 决定音质下拉要不要标"需要会员"、要不要显示实际拿到的档位 |
| 3 | `/album/{id}` 和 `/artist/desc` 的返回字段名 | `album.ts` 拿不到简介，`info.json` 只剩元数据 |
| 4 | `/v6/playlist/detail` 对超 1000 首歌单的实际返回（`tracks` 到底给多少、`trackIds` 是否真的全量） | 补齐逻辑的分界点要调整 |

**前置条件**：这四条都需要一个有效的 `MUSIC_U`。目前 `neteasecli auth login` 在这台机器上还没跑通（Chrome keychain 3000ms 超时 / Safari 缺完全磁盘访问权限），所以第一步要么解决其中之一，要么直接从浏览器 devtools 里手抄一份 —— 反正新项目的主登录路径就是手填。

---

## 十、里程碑

| 阶段 | 内容 | 验收 |
|---|---|---|
| **M1 打通链路** | `npm create vite` + 复制 core + 上面四条验证 + `plugin.ts` 骨架 + auth/playlists 路由 | `curl 127.0.0.1:5173/api/playlists` 返回自己的歌单；一个 >1000 首的歌单能拿到全量 |
| **M2 下载流水线** | `naming` / `db` / `tag` / `job` / `pipeline` + download 路由 | curl 触发 3 首歌的 job，磁盘出现正确目录结构，`ffprobe` 能看到内嵌封面 |
| **M3 前端** | 六个组件按登录 → 歌单 → 曲目 → 抽屉 → 进度的顺序做通 | 全流程点一遍不用碰终端 |
| **M4 打磨** | 失败重试按钮、双语 lrc 合并、`/song/wiki/summary` 的 eapi 探索、需要的话补 `configurePreviewServer` | —— |

### 验证方式

- 端点验证：在 neteasecli 里 `npx tsx verify.ts`，一次性脚本，跑完删
- 后端：`npm run dev` + curl 打每个路由（同一个端口，不用管两个进程）
- 前端：同一条 `npm run dev`，手点一遍全流程
- 端到端：选一个 3-5 首的小歌单全勾选跑完 → 检查目录结构 → `ffprobe` 验内嵌标签 → **再重跑一次确认幂等跳过** → 手动删掉一个歌的文件夹再跑，确认它会重下（验证 `isDone` 的存在性校验）
- 收尾：`npx tsc --noEmit -b` 走 references 把两个 tsconfig 都过一遍

---

## 十一、实现偏差

代码写完后与前十节不一致的地方，按"为什么"分组。正文没改，看这一节即可。

### 多出来的文件

| 文件 | 为什么 |
|---|---|
| `server/http.ts` | 第五节把路由匹配、JSON 应答、SSE 写头都塞在 `plugin.ts` 里。真写下来发现 `matchRoute` / `json` / `fail` / `HttpError` / SSE 起头这几件事和 Vite 完全无关，`plugin.ts` 只该负责"把中间件挂上去"。拆开后 `plugin.ts` 剩 65 行 |
| `src/lib/format.ts` | `messageOf` / `formatBytes` / `formatDuration` / `tildify` / `joinPath` 被四个组件重复用到 |
| `src/lib/search.ts` | 歌单内搜索的整套规则（归一化、切词、命中判定、`filterTracks`）。放在组件外面是因为这是纯函数，能用 `node --test` 钉住；也因为"命中要带原始序号"这条只有单独写出来才不会被顺手写成 `filter` 后的下标 |
| `scripts/verify-endpoints.ts` | 第九节说"在 neteasecli 里写个一次性脚本，跑完删"。改成留在本仓库里的 `npm run verify`：这四条的答案会随账号会员状态变，删掉等于下次还得重写一遍 |
| `server/download/naming.test.ts` | 第十节的验证方式里没有单元测试。`naming.ts` 是唯一直接决定磁盘上出现什么路径的纯函数（截断切碎代理对、结尾的点、Windows 保留名），规则钉在测试里比钉在注释里可靠。用 Node 自带的 `node:test`，零新依赖，`npm test` 自动发现 |
| `server/routes/fs.test.ts` | 同上的理由，对象换成 `safeDir` —— 它是整个进程唯一的写入边界，"相对路径按家目录展开而不是 cwd""realpath 之后再比前缀""`..foo` 不算逃逸"这三条都是一改就出事、光看代码又看不出来的。用真实家目录测，符号链接那两条会在家目录里建一个 `.luoyun-test-*` 临时目录，跑完删 |
| `src/lib/search.test.ts` | 同上的理由，对象换成搜索规则。17 条里有一半是回归用的：命中必须带**歌单里的原始序号**（搜"陈奕迅"筛出第 2、4 首，序号得是 2 和 4 而不是 1 和 2 —— 那个数字就是落盘目录前缀）、全角关键词要能搜到半角（中文输入法下打英文默认是全角）、`matchesTerms` 不自己归一化 terms（契约写在函数注释里，测试就照契约传 `searchTerms()` 的产物，不许在测试里手动 `.toLowerCase()` 蒙过去） |
| `src/store/selection.test.ts` | 勾选的作用域一旦有了搜索就不再显然：全选写成覆盖、反选写成取补集，在不搜索时和正确实现一模一样，一搜索才开始悄悄丢勾选。这类"两种写法在默认路径上等价"的东西必须有测试。zustand 的 persist 默认存储读的是 `window.localStorage`，node 里得先塞个内存版进 `globalThis.window`，否则它每次 set 警告一行、并且 `partialize`/`merge` 那两段根本不跑 |
| `scripts/smoke.sh` | `npm run smoke`。第十节的"curl 打每个路由"手动做一遍要十几条命令，而下面那批安全检查（跨站、`Content-Type`、401、413、坏转义）全是"平时看不见、回归了也没人发现"的类型。5678 上有 dev server 就用现成的，没有就自己起一个跑完收掉；先问一次 `/api/auth/status`，登录和未登录期望的状态码不同。全程只读：`forget` 那条故意传非字符串 `destDir`，避免真删掉幂等记录 |

### 复审后补上的安全检查

第八节只写了三条（不给 `--host`、`MUSIC_U` 不下发、路径穿越）。实际实现里另外加了四道，都是"这个进程持着等于账号本身的凭据 + 能读写家目录 + 固定监听 5678"这个前提直接推出来的：

- **跨站防护 `guardRequest()`**（`server/http.ts`，分发前对 `/api/*` 全量跑）。凭据在 `session.json` 里而不是浏览器里，所以 SameSite cookie 那一套完全不起作用 —— 任何网页里一行 `fetch('http://127.0.0.1:5678/api/auth/cookie', …)` 只要送达就是带着账号身份执行的，攻击者连响应都不用读。三道：`Sec-Fetch-Site` 只放 `same-origin`/`none`（`same-site` 也拒，本机别的端口同样不可信）、`Origin` 出现了就必须和 `Host` 一致、写请求的 `Content-Type` 必须是 `application/json`（跨站不预检就能送达的只有 form/multipart/text-plain 三种简单请求）。命令行客户端三个头都不发，照常放行。
- **`server.cors: false`**（`vite.config.ts`）。Vite 默认给**所有** localhost 来源发 CORS 头，于是本机任何一个别的 dev server / Storybook / `http://x.localhost` 上的页面都能读我们的响应，`GET /api/fs/list` 能一层层列出整个家目录。页面和 API 同源，一个 CORS 头都不需要。
- **`requireAuth()` 覆盖到所有交出本机状态的路由**，不只是碰网易云的那些：`/api/fs/default`、`/api/fs/list`（否则本机任何页面都能列家目录）、`GET /api/download`、`GET /api/download/:id`、`/api/download/:id/events`、`/api/download/:id/cancel`、`/api/download/forget`。
- **错误一律 JSON、状态码一律精确**。`readBody` 挡掉非对象 body（`null` / 数字 / 数组会让 `body.x` 抛 TypeError → 500，把内部报错原文吐给客户端）、`content-length` 超限提前 413（只靠边读边数的话从 `for await` 里抛会顺手拆掉 socket，客户端看到的是连接重置）；`matchRoute` 里 `decodeURIComponent` 的 `URIError` 当成不匹配（否则 `/api/playlists/%` 会越过 `plugin.ts` 的 try 落到 Vite 的错误中间件，返回一整页带完整堆栈的 HTML）。

### 路径与命名

- **`*.test.ts` 一律归 `server/tsconfig.json`**，包括 `src/` 下的（前端那套加了 `"exclude": ["src/**/*.test.ts"]`，server 那套 `include` 里加了 `"../src/**/*.test.ts"`）。跑测试的是 `node --test` 而不是浏览器，测试文件要 `node:test` 的类型；但不能为此把 `@types/node` 塞进前端那套 —— 那样组件里也能看见 `process` / `Buffer`，编译过、运行时炸（第三节末尾那条的原意）。副作用刚好是想要的：被测的 `src/lib/*.ts` 在一套没有 DOM lib 的配置下也得过 typecheck，纯逻辑不会偷偷用上 `window`。
- 配置目录 `~/.config/luoyun/`（`session.json` 0600、`downloads.db` 0600、目录 0700），默认下载目录 `~/Music/luoyun/`。
- 项目内**所有相对 import 都写全 `.ts` 扩展名**，两个 tsconfig 都开 `allowImportingTsExtensions`。原因是 Vite 8 的原生 config loader 不认省略写法，`vite.config.ts` 及其整个 import 图每次 dev 启动都会刷一屏 forward-compat 警告。共 72 处。
- 两个 tsconfig 都开 **`erasableSyntaxOnly`**。`server/` 那半边是 node 直接跑 `.ts` 的（`node --test`、`node scripts/verify-endpoints.ts`），而 node 只擦类型、不生成代码：`enum`、`namespace`、构造器参数属性（`constructor(readonly status: number)`）一律 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`。`HttpError` 一开始就是参数属性写法，Vite 转译得了所以一直没暴露，直到 `node --test` 去 import `http.ts` 才炸。开着它，这类写法在 typecheck 阶段就被拦下来。
- dev server 端口定在 **5678**（`strictPort`），不是 Vite 默认的 5173 —— 5173 上很可能已经跑着别的项目，而这个服务是拿账号做事的，串端口比报错糟糕得多。

### 接口形状

- **前端直接 `import server/core/types.ts`** 拿 wire 类型，不再前后端各写一份。代价是那个文件必须永远零依赖（不许 `node:`、不许 import 其他 server 文件，只放 `interface` / `type` / 纯数据常量），已写在文件头。构建后验过：产物里没有任何 `node:` import，也没有 weapi 的 preset key。
- `getTrackUrls` 返回 `Map<string, TrackUrlInfo>` 而不是数组 —— 调用方全都是按 id 查。
- `track.ts` 内部自己分批（`/song/detail` 和 `url/v1` 各有各的批大小 + 批间隔），调用方传完整 id 列表即可，不用在 pipeline 里再切一层。
- `runJob(job, items, playlist, total)` 收的是 `JobItem[]`（`{ track, index }` —— 序号必须是歌单里的原始位置，只下其中 5 首时目录前缀不能重排成 01-05），`total` 单独传是因为序号补几位要按歌单总数算。url 和 `/song/detail` 都在 `runJob` 内部一次性批量取完再进并发，为的是提前把没版权的整批标掉，而不是下到第 40 首才发现前面一半是空的。
- `SongInfo` 多一个 `audio` 字段（`requested` / `level` / `br` / `type` / `size`）。第九节第 2 条的降级是**静默**的，不记下请求的档位和实际拿到的档位，事后完全看不出这个 `audio.flac` 其实是 320k mp3 改的名。

### 幂等与任务终态

第四节把幂等库的 key 写成"`destDir` + trackId"，把 `done` 事件写成"跑完发一次"。这两处都不够，实现里改成了：

- **幂等 key 用歌单目录**（`playlistDirPath(destDir, playlistName)`），不是用户选的根目录。用根目录的话，同一首歌出现在两个歌单里时第二个歌单会被判成"已下过"，那首歌在第二个歌单里永远缺席。三处必须算出同一个字符串（流水线落盘、`markDone`/`isDone`、`force` 清记录），所以 `playlistDirPath` 只有一个实现。配套地 `forgetDir` 改成前缀匹配（页面传来的是根目录，记录按歌单目录存），用 `instr(x, prefix) = 1` 而不是 `LIKE` —— 目录名里的 `%`/`_` 在 LIKE 里是通配符。
- **`uniqueDir` 的判断方向是"有确凿证据说明这个目录属于别的歌才让路"**，不是"证明是同一首才复用"。`info.json` 只有勾了"简介"才写，先下音频、事后补歌词的正常流程会被反方向的写法拆成 `xxx` 和 `xxx (2)` 两个目录，而幂等库只记得住最后那个 —— 两半产物各躺一半、还都算"已下过"。反方向安全的前提是目录名带歌单内的序号前缀，同一个歌单里两首不同的歌算不出同名。
- **`done` 恰好发一次，且带上真实终态**。`JobEvent` 的 `done` 多一个 `status` 字段：取消可能来自另一个标签页、也可能发生在这个页面订阅之前，前端拿本地状态去猜会把"已取消"显示成"已结束"。发送由 `job.ts` 的 `doneEmitted` 集合去重（取消路径和 `runJob` 的正常收尾都会走到 `finishJob`），而 `finishJob` 放在 `runJob` 的 `finally` 里 —— 幂等库、命名、`mkdir` 任何一个抛出来，状态都不能永远停在 `running`。
- **任务级错误存在 `Job.error` 上**，`failJob()` 同时写字段和推 `error` 事件。只推事件的话，订阅之前就已经发生的错误在快照里看不到，页面刷新一次就"什么都没发生过"。
- **取消要发真的 `track` 事件**：`SkipReason` 多一个 `cancelled`，`cancelJob` 把还 pending 的歌逐个标成 `skipped/cancelled`。不标的话进度条永远差最后那一截，看着像卡住了。
- 单首歌内部的四个任务用 `Promise.allSettled` 收，再挑第一个 rejected 抛出去 —— `Promise.all` 会在第一个失败时就往上抛，剩下三个的 rejection 变成 unhandled。音频那条的重试是**换 url 重试**：网易的播放地址有有效期，同一个过期 url 重试三次只是等三次，所以第二次起先 `getTrackUrls` 重新解析一次。另外 `withRetry` 收 `signal`，取消之后不再睡下一轮退避。

### 产物

- 歌词除 `lyric.lrc`（原文）、`lyric.zh.lrc`（翻译）外，还写 `lyric.roma.lrc`（罗马音，日文歌常有）。内嵌进音频的只有原文 —— 两份时间轴叠在一起播放器会重复显示。
- 序号宽度按歌单总数定（100 首以上 3 位），`playlist.json` 里额外记本次任务参数（音质、勾了哪些部分、目标目录），方便日后知道这批文件是怎么下的。
- 音频只拿到 0 字节直接算失败（`br`/`size` 对得上但 body 是空的情况真的会出现）；实际字节数明显小于 `size` 时只 warn，不算失败 —— 网易给的 `size` 本身也不总准。

### 前端的几处坑

- **`EventSource` 的 `error` 是两件事**：后端任务级错误的事件名，也是它自己汇报传输失败的事件名。后者是个光秃秃的 `Event`，没有 `data`，直接 `JSON.parse` 会在每次断线重连时抛一次异常，所以监听器里先判 `typeof data === 'string'`。另外它自己会重连（`readyState` 回到 `CONNECTING`），只有 `CLOSED` 才算真的断了，才该给用户看"连接断开"。
- **写请求一律带 `Content-Type: application/json`**，即使没有 body —— 服务端靠这个头拒掉跨站的简单请求（见上面的 `guardRequest`）。
- **退出登录要单独重置勾选集**。`queryClient.clear()` 清得掉歌单缓存，清不掉 Zustand persist 落在 localStorage 里的 `playlistId` + `selected`：换个账号进来会打开一个它根本没有的歌单，还带着上一个账号的勾选。`parts`/`quality`/`destDir` 是本机偏好，跟账号无关，留着。
- **虚拟列表的滚动容器里不能塞别的块级元素**。行是相对容器绝对定位的，容器里多一个 banner 就把所有行整体推下去、和滚动偏移错开一个 banner 的高度（后台刷新失败但旧数据还在的时候就会这样）。错误 banner 放在滚动容器外面。
- **取消按钮点完之后要立刻自己停下来**。`status` 还会是 `running` 一小会儿（要等在跑的那几首收掉），这段时间按钮不 disable 的话看着像没反应，用户会连点。

### 歌单内搜索（第五节没有）

一个歌单几百上千首，靠滚找歌不现实。规则和取舍：

- **纯本地过滤，不发请求**。歌单详情早就整份发到浏览器了（`/v6/playlist/detail` + 分批补齐），在内存里筛是零延迟。网易的 `/search` 搜的是全站曲库，跟"这个歌单里有没有"是两个问题。
- **搜歌名 + 歌手 + 专辑，不搜歌词**。`Track` 上就这些字段（没有 `alias` / `tns`），歌词要一首首去拿，为了搜索发几百个请求不值当。空状态里把这条说出来，不然搜一句歌词搜不到会以为坏了。
- 多个关键词按空白切、**AND 且可跨字段**（"周杰伦 晴天" 一个词命中歌手一个词命中歌名）。
- 输入先 **NFKC 归一化**再小写：中文输入法下打英文默认出全角，`ＭＶ` 和 `MV` 必须是一回事。
- **命中带原始序号**（`TrackHit = { track, index }`）。`index` 是歌单里的位置，也是落盘目录前缀（`007 晴天 - 周杰伦`）；筛选后的行号跟它没关系，表格里显示的是前者，所以筛选时序号会跳号（表头 `#` 上挂了 title 说明这件事）。
- 拼歌单文本的 haystack 走 `WeakMap<Track, string>` 缓存：每敲一个字母都要把整个歌单过一遍，`normalize()` + `join` 重算上千次是白烧的。

前端接线上有四个坑，都是"有了筛选才存在"的：

- **虚拟列表的 `getItemKey` 必须是 trackId**，默认是下标 —— 换个关键词，同一个下标就是另一首歌了，React 会把行的 DOM 连着 checkbox 状态一起复用错。
- **换关键词要把虚拟窗口的偏移归零**。本来滚在第 900 行，筛出 12 行后容器只剩 528px 高，虚拟器还按旧偏移算，第一帧看到的是结果的尾巴或者一片空白。用 `virtualizer.scrollToOffset(0)` 而不是直接改 `scrollTop`（前者会同步改掉它内部记的偏移，不用等浏览器把 scroll 事件派发回来），放在 `useLayoutEffect` 里 —— `useEffect` 会先让错位的那一帧上屏。
- **关键词刚变的那一帧，`getVirtualItems()` 可能还拿着上一轮更长列表的下标**，行渲染里必须 `if (!hit) return null`。
- **关键词是纯视图状态，不进 store、不 persist**。改 `server/` 下任何文件都会让 Vite 整页刷新，一个被记住的关键词会让人以为歌单里的歌自己少了。同理 `App.tsx` 里给 `<TrackTable key={playlistId}>` 加了 key：换歌单时连着关键词和滚动位置一起重挂。

**最要紧的一条：搜索只筛显示，不改"一首都不勾 = 下整个歌单"这条规则。** 筛出 12 首、一首没勾就点开始，下的是整整一个歌单。这个组合太容易踩，所以筛选中且没勾选时在面板里挂一条琥珀色提示，明说"这样开始下的是整个歌单（N 首）；只想要这 12 首先点全选 12"，"全选"的 tooltip 也跟着改。用 `useDeferredValue` 让输入框先响应、过滤晚一帧（上万首的歌单里边打字边筛会顿）。

### 多出来的路由

- `GET /api/download` —— 列当前所有任务。dev server 一重启内存任务就没了，前端要能发现"我记着的 jobId 已经不存在"。
- `POST /api/download/forget` —— 按歌 / 按目录清幂等记录，对应 `db.ts` 的 `forget` / `forgetDir`。UI 上的入口是"忽略已下记录，全部重下"和失败重试（重试必须带 `force`，失败的歌可能已经写了半个目录）。

### 还没做的

- 第九节那四条**仍未联网确认**：需要一个有效 `MUSIC_U`，跑 `npm run verify` 即可，脚本只读不下载。
- M4 里的 `/song/wiki/summary`（eapi）没碰，简介目前只有专辑 + 歌手两段。
- 没配 `configurePreviewServer` —— API 是 dev-only 的，`npm run build` 的产物是纯静态前端，单独 preview 起来没有后端可用。

