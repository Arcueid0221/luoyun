import type { IncomingMessage, ServerResponse } from 'node:http';

// 这就是"框架"的全部。Connect 只给了中间件栈，body 解析、路由、SSE 都得自己来 ——
// 加起来一百行，比引一个 Web 框架划算。

export interface RouteCtx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  body<T>(): Promise<T>;
}

/** 返回 undefined 表示 handler 自己接管了 res（SSE 走这条） */
export type Handler = (ctx: RouteCtx) => Promise<unknown> | unknown;

export type Route = [method: string, pattern: string, handler: Handler];

/** 带 HTTP 状态码的错误，plugin.ts 会把它翻成对应的响应码 */
export class HttpError extends Error {
  // 不写成构造器参数属性（`constructor(readonly status: number)`）：那是要生成代码的
  // 语法，Node 的 strip-only 类型剥离直接报 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX。
  // Vite 转译得了，`node --test` 和 scripts/ 下用 node 直接跑的脚本转译不了。
  // 两个 tsconfig 都开了 erasableSyntaxOnly，这类写法在 typecheck 阶段就会被拦住。
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'HttpError';
  }
}

export function json(res: ServerResponse, data: unknown, status = 200): void {
  const payload = JSON.stringify(data ?? null);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

export function fail(res: ServerResponse, status: number, message: string): void {
  json(res, { error: message }, status);
}

const MAX_BODY = 1024 * 1024;

/**
 * 跨站请求防护。分发之前跑，`/api/*` 全都要过。
 *
 * 为什么必须有：这个进程持着等于账号本身的 cookie，还能读写家目录，
 * 而它固定监听 127.0.0.1:5678 —— 任何网页里的一行 fetch 都能命中它。
 * 凭据不在浏览器里（在 session.json 里），所以 SameSite cookie 那一套
 * 完全不起作用：请求只要送达，就是带着你的账号身份执行的。攻击者甚至
 * 不需要读到响应 —— 把 `POST /api/auth/cookie` 换成他自己的 MUSIC_U 就够了。
 *
 * 三道检查，任一条不满足就拒：
 *   1. `Sec-Fetch-Site`：现代浏览器强制发，页面改不了。除 same-origin / none 全拒，
 *      `same-site` 也拒 —— 本机另一个端口上的页面（别的项目的 dev server、
 *      Storybook、`http://anything.localhost`）同样不可信。
 *   2. `Origin`：出现了就必须和 `Host` 一致。兜不发 Sec-Fetch-* 的老浏览器。
 *   3. 带 body 的写请求（POST 这类）的 `Content-Type` 必须是 `application/json`：
 *      跨站不触发预检就能送达的只有 form-urlencoded / multipart / text-plain
 *      这三种"简单请求"，而 `application/json` 一定触发预检，我们又不给任何
 *      CORS 响应头（`vite.config.ts` 里 `cors: false`）。
 *      DELETE 不在这条里：简单请求的方法只有 GET / HEAD / POST，跨站发 DELETE
 *      一定先预检、一定被挡，这个头对它没有防护价值；反过来要求它会误伤正经
 *      调用方 —— Java 的 HttpClient / RestTemplate / WebClient 对无 body 的
 *      DELETE 默认不发 `Content-Type`，Provider 的"退出登录"就是这样被 415 挡掉的。
 *
 * 命令行客户端（curl、脚本）三个头都不发，照常放行 —— 它们不在这个威胁模型里。
 */
export function guardRequest(req: IncomingMessage): void {
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') {
    throw new HttpError(403, '拒绝跨站请求');
  }

  const origin = req.headers.origin;
  if (origin) {
    let sameHost = false;
    try {
      sameHost = new URL(origin).host === req.headers.host;
    } catch {
      // `Origin: null`（sandbox iframe、file://）会走到这儿
      sameHost = false;
    }
    if (!sameHost) throw new HttpError(403, '拒绝跨站请求');
  }

  const method = (req.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && method !== 'DELETE') {
    const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') {
      throw new HttpError(415, '写请求必须带 Content-Type: application/json');
    }
  }
}

export async function readBody<T>(req: IncomingMessage): Promise<T> {
  // 先看 content-length，超了就直接 413。
  // 只靠边读边数的话，从 for await 里抛出去会顺手把 socket 拆掉，
  // 客户端看到的是连接被重置而不是那条 413。
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY) throw new HttpError(413, '请求体太大');

  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY) throw new HttpError(413, '请求体太大');
    chunks.push(buf);
  }

  if (size === 0) return {} as T;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON');
  }
  // handler 拿到 body 就直接取字段。`null`、数字、数组会让 `body.x` 抛 TypeError，
  // 那被归成 500 并把内部错误原文吐给客户端。在这儿挡掉，返回 400。
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, '请求体必须是一个 JSON 对象');
  }
  return parsed as T;
}

export interface RouteHit {
  handler: Handler;
  params: Record<string, string>;
}

/** 按 "/" 切段比对，":xxx" 段收进 params。没有正则，够用 */
export function matchRoute(routes: Route[], method: string, pathname: string): RouteHit | undefined {
  const segs = pathname.split('/').filter(Boolean);

  for (const [routeMethod, pattern, handler] of routes) {
    if (routeMethod !== method) continue;

    const patternSegs = pattern.split('/').filter(Boolean);
    if (patternSegs.length !== segs.length) continue;

    const params: Record<string, string> = {};
    let matched = true;
    for (let i = 0; i < patternSegs.length; i++) {
      const p = patternSegs[i];
      if (p.startsWith(':')) {
        // `%` 这种坏转义会让 decodeURIComponent 抛 URIError。抛出去的话会越过
        // plugin.ts 的 try 落到 Vite 自己的错误中间件，返回一整页带完整堆栈的
        // HTML（顺带弹出错误浮层）。当成不匹配就好，最后落到 404。
        let value: string;
        try {
          value = decodeURIComponent(segs[i]);
        } catch {
          matched = false;
          break;
        }
        params[p.slice(1)] = value;
      } else if (p !== segs[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return { handler, params };
  }

  return undefined;
}

export interface SseChannel {
  send(event: string, data: unknown): void;
  close(): void;
}

/**
 * 开一条 SSE 通道。
 *
 * flushHeaders() 必须调 —— 不调的话首个事件可能一直卡在缓冲里，
 * 前端表现为"连上了但什么都不来"。
 * 另外每 25 秒发一个注释行做心跳，防止中间层把空闲连接掐掉。
 */
export function sse(res: ServerResponse): SseChannel {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write(': ok\n\n');

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, 25000);

  return {
    send(event, data) {
      if (res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    close() {
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    },
  };
}
