# 落云 luoyun

把网易云音乐歌单里的**音频、封面、歌词、简介**批量落到本地磁盘。

浏览器里点选，本机磁盘落盘 —— 前端只管界面，所有网易云请求和文件写入都发生在
Vite dev server 进程里（Vite 的 `configureServer` 本身就是一个 Node HTTP 服务器，
所以没有第二个后端框架）。

```
选歌单 →（搜歌名 / 歌手 / 专辑）→ 勾歌 → 勾要下的部分 → 选目录 → 开始 → 实时进度
```

歌单里的搜索框是纯本地过滤（歌单详情早就整份在浏览器里了），空格分开多个关键词，
歌名、歌手、专辑三个字段都算命中，Esc 清空。它**只筛显示，不改勾选** —— 一首都不勾
等于下整个歌单，所以筛出几首之后要先点"全选 N"，界面上也会提示这一点。

## 要求

| | |
|---|---|
| Node.js | **≥ 24**（用到原生 `node:sqlite` 和默认开启的 TS 类型剥离） |
| ffmpeg | 可选。装了就把封面和歌词内嵌进音频文件；没装只是不内嵌，独立的 `cover.jpg` / `lyric.lrc` 照常生成 |
| 网易云账号 | 一个有效的 `MUSIC_U` cookie。无损 / Hi-Res 还需要对应会员 |

## 开始

```bash
npm install
npm run dev          # http://127.0.0.1:5678
```

首屏会要一次 `MUSIC_U`：浏览器登录 music.163.com → 开发者工具 → Application（Safari 是"存储"）
→ Cookies → `https://music.163.com` → 复制 `MUSIC_U` 的值，粘进输入框。整条 Cookie 头一起粘也行。

也可以点"从浏览器导入"直接读本机浏览器的 cookie，但需要额外装
`npm i @steipete/sweet-cookie`，且 macOS 会弹钥匙串授权（Safari 还要给终端 App
完全磁盘访问权限）。手填更省事。

## 产物长什么样

默认落在 `~/Music/luoyun/<歌单名>/`，**每首歌一个子目录**：

```
我喜欢的音乐/
├── playlist.json              # 歌单元信息 + 完整曲目清单 + 本次任务参数
├── 001 晴天 - 周杰伦/
│   ├── audio.flac             # 扩展名跟实际拿到的档位走
│   ├── cover.jpg              # 1000×1000 原图
│   ├── lyric.lrc              # 原文
│   ├── lyric.zh.lrc           # 翻译（有才写）
│   ├── lyric.roma.lrc         # 罗马音（有才写）
│   └── info.json              # 曲目 / 专辑 / 歌手简介、时长、发行时间、实际音质
└── 002 …
```

序号宽度按歌单总数定（100 首以上用 3 位），顺序取自歌单本身的
`trackIds`，不是接口返回顺序。歌名里的 `/`、控制字符、Windows 保留名都会被清洗。

## 音质与"跳过"

档位直接传给网易的 `level` 参数：`standard` / `higher` / `exhigh` /
`lossless`（黑胶 VIP）/ `hires`（黑胶 VIP）/ `jymaster`（SVIP）。
权限不够时网易**静默降级**——请求 `lossless` 拿回 `exhigh` 是正常返回而不是报错，
`info.json` 里记的是实际拿到的档位。

进度面板把两种结果分得很清楚：

- **跳过** = 网易不给这首歌（无版权 / 要会员 / 本地已下过），属正常现象；
- **失败** = 网络或程序出了问题，可以点"重试失败项"。

已下过的记录存在 `~/.config/luoyun/downloads.db`，按 `(歌曲, 歌单目录, 音质, 已下部分)`
判重；目录被手动删掉会重新下。勾上"忽略已下记录"可以强制重下。

判重位置是**歌单目录**而不是你选的根目录 —— 同一首歌出现在两个歌单里时，
两个歌单各自下一份，每个歌单都是一份自洽的备份。

## 命令

```bash
npm run dev          # 开发服务器（前端 + API）
npm run build        # 只构建前端静态产物；API 是 dev-only 插件，产物里不含服务端代码
npm run typecheck    # 前端 + server 两套 tsconfig
npm test             # node:test 跑单元测试，零依赖
npm run smoke        # 打一遍 /api/*，看状态码和跨站防护是否还在；只读
npm run verify       # 只读地验四个网易云端点的真实返回，需要已登录
```

`npm run smoke` 会在 5678 上没有 dev server 时自己起一个、跑完收掉。它不需要登录
（未登录正好验那批 401），也不会改任何记录。

`npm run verify` 打印 `url/v1` 的 `level` 实际取值和降级行为、专辑/歌手简介的字段名、
超 1000 首歌单 `tracks` 与 `trackIds` 的实际数量，以及歌词的四个字段哪些有值。
它不下载任何文件。

## 安全

`MUSIC_U` **等于你的账号本身** —— 拿着它能改密码、清歌单、发评论。所以：

- 它只存在 `~/.config/luoyun/session.json`（权限 `0600`，目录 `0700`），
  **永远不下发给页面**，也不写进日志。`/api/auth/status` 只返回昵称、头像和一个布尔值。
- dev server 只监听 `127.0.0.1`。**不要加 `--host`** —— CLI 参数会覆盖
  `vite.config.ts` 里的 `server.host`，而这个进程能用你的账号做任何事，还能读你的家目录。
- 目录选择和下载路径都会解析符号链接后强制要求落在家目录以内，
  相对路径按**家目录**展开（不是按当前工作目录）。
- `/api/*` 全部拒绝跨站请求：`Sec-Fetch-Site` 只放同源、`Origin` 必须和 `Host` 一致、
  写请求必须带 `Content-Type: application/json`。凭据在 `session.json` 里而不是浏览器里，
  SameSite cookie 那套帮不上忙 —— 别的网页里一行 `fetch` 打到 5678 就是带着你的账号执行的。
  同理关掉了 Vite 默认的 CORS（它默认给**所有** localhost 来源发头，
  于是本机任何一个别的 dev server 上的页面都能读到 `/api/fs/list` 的响应）。
- 交出本机状态的路由（列目录、任务列表、进度流）也要求已登录，不只是碰网易云的那些。

## 结构

```
server/            仅 dev 期存在的 API，挂在 /api/*
  core/            网易云接口层（crypto / client / auth / api/*），从 neteasecli 复制并整理
  download/        任务编排、落盘、ffmpeg 内嵌、幂等库
  http.ts          路由匹配 + JSON/SSE 应答的最小工具
  plugin.ts        Vite 插件入口
src/               React 前端
scripts/           只读脚本：端点真实返回验证 + /api/* 冒烟
*.test.ts          单元测试跟被测文件放一起（命名规则、家目录边界）
DESIGN.md          完整设计文档：每个文件有哪些函数、为什么这么写
```

前端直接 `import` `server/core/types.ts` 拿接口类型，所以前后端的数据形状不可能对不上；
那个文件因此必须保持零依赖。项目内所有相对 import 都写全 `.ts` 扩展名（Vite 8 的
原生 config loader 不认省略写法）。

改动细节和取舍理由见 [DESIGN.md](./DESIGN.md)。

## 说明

仅供个人备份自己账号内的歌单使用。下载到的音频受版权保护，不要再分发。
