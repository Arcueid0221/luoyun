import type { Plugin } from 'vite';
import { HttpError, fail, guardRequest, json, matchRoute, readBody } from './http.ts';
import { routes } from './routes/index.ts';
import { debug, warn } from './core/logger.ts';

/**
 * 后端的全部"框架"。
 *
 * Vite 的 dev server 本身就是一个 Node HTTP 服务器，configureServer 给到的
 * server.middlewares 就是一个 Connect 中间件栈 —— node:crypto、node:fs、
 * node:sqlite、child_process 全都能用。所以不需要 Hono / Express / Fastify。
 *
 * 注意：中间件必须直接注册在钩子体里。如果 return 一个函数延后注册，
 * 就会排在 Vite 内部中间件之后，/api/* 会被 SPA fallback 抢去返回 index.html。
 */
export function apiPlugin(): Plugin {
  return {
    name: 'luoyun-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const rawUrl = req.url ?? '/';
        const url = new URL(rawUrl, 'http://127.0.0.1');
        if (!url.pathname.startsWith('/api/')) return next();

        const method = req.method ?? 'GET';

        void (async () => {
          try {
            // 分发之前先挡跨站请求：这个进程能用你的账号做任何事，
            // 而任何网页都能往 127.0.0.1:5678 发请求
            guardRequest(req);

            const hit = matchRoute(routes, method, url.pathname);
            if (!hit) throw new HttpError(404, `没有这个接口: ${method} ${url.pathname}`);

            debug(`${method} ${url.pathname}`);

            const result = await hit.handler({
              req,
              res,
              url,
              params: hit.params,
              body: <T>() => readBody<T>(req),
            });
            // SSE 分支自己接管了 res，返回 undefined，这里就不能再写
            if (result !== undefined) json(res, result);
          } catch (error) {
            if (res.headersSent) {
              // 已经开始写响应了（比如 SSE），只能记一条日志
              warn(`${method} ${url.pathname} 响应中途出错: ${message(error)}`);
              if (!res.writableEnded) res.end();
              return;
            }
            const status = error instanceof HttpError ? error.status : 500;
            if (status >= 500) warn(`${method} ${url.pathname} -> ${status}: ${message(error)}`);
            fail(res, status, message(error));
          }
        })();
      });

      server.httpServer?.once('listening', () => {
        process.stderr.write('[luoyun] API 已挂载在 /api/*\n');
      });
    },
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
