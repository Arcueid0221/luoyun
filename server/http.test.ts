import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { describe, it } from 'node:test';
import { HttpError, guardRequest, matchRoute, type Route } from './http.ts';

function req(method: string, headers: Record<string, string> = {}): IncomingMessage {
  return { method, headers } as unknown as IncomingMessage;
}

function status(fn: () => void): number | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error instanceof HttpError ? error.status : -1;
  }
}

describe('guardRequest', () => {
  it('命令行客户端三个头都不发，放行', () => {
    assert.equal(status(() => guardRequest(req('GET'))), undefined);
  });

  it('跨站一律拒，same-site 也拒（本机另一个端口的页面同样不可信）', () => {
    assert.equal(status(() => guardRequest(req('GET', { 'sec-fetch-site': 'cross-site' }))), 403);
    assert.equal(status(() => guardRequest(req('GET', { 'sec-fetch-site': 'same-site' }))), 403);
    assert.equal(status(() => guardRequest(req('GET', { 'sec-fetch-site': 'same-origin' }))), undefined);
  });

  it('Origin 出现了就必须和 Host 一致', () => {
    const bad = { origin: 'http://evil.example', host: '127.0.0.1:5678' };
    assert.equal(status(() => guardRequest(req('GET', bad))), 403);
    const same = { origin: 'http://127.0.0.1:5678', host: '127.0.0.1:5678' };
    assert.equal(status(() => guardRequest(req('GET', same))), undefined);
    // `Origin: null`（sandbox iframe、file://）解析不出 host
    assert.equal(status(() => guardRequest(req('GET', { origin: 'null', host: '127.0.0.1:5678' }))), 403);
  });

  it('POST 必须带 application/json，charset 后缀不影响', () => {
    assert.equal(status(() => guardRequest(req('POST'))), 415);
    assert.equal(status(() => guardRequest(req('POST', { 'content-type': 'text/plain' }))), 415);
    assert.equal(
      status(() => guardRequest(req('POST', { 'content-type': 'application/json; charset=utf-8' }))),
      undefined,
    );
  });

  it('无 body 的 DELETE 不要求 Content-Type —— Java 客户端默认不发这个头', () => {
    // 回归：要求它会让 Provider 的"退出登录"永远 415，而跨站发不出 DELETE
    // （简单请求只有 GET/HEAD/POST），这个头对 DELETE 没有防护价值。
    assert.equal(status(() => guardRequest(req('DELETE'))), undefined);
    assert.equal(
      status(() => guardRequest(req('DELETE', { 'content-type': 'application/json' }))),
      undefined,
    );
    // 跨站的 DELETE 仍然被前两道挡住
    assert.equal(status(() => guardRequest(req('DELETE', { 'sec-fetch-site': 'cross-site' }))), 403);
  });
});

describe('matchRoute', () => {
  const routes: Route[] = [
    ['GET', '/v1/health', () => 'health'],
    ['GET', '/v1/tracks/:id/audio', (ctx) => ctx.params.id],
  ];

  it('按段匹配并把 :id 收进 params', () => {
    const hit = matchRoute(routes, 'GET', '/v1/health');
    assert.ok(hit);
    assert.deepEqual(hit.params, {});
    assert.deepEqual(matchRoute(routes, 'GET', '/v1/tracks/123/audio')?.params, { id: '123' });
  });

  it('方法必须完全一致：HEAD 不会命中 GET 路由', () => {
    // 存活探测得用 GET；换成 HEAD 探针会拿到 404 而不是 200
    assert.equal(matchRoute(routes, 'HEAD', '/v1/health'), undefined);
  });

  it('段数不同、坏转义都当不匹配（最后落 404，而不是抛 URIError）', () => {
    assert.equal(matchRoute(routes, 'GET', '/v1/health/extra'), undefined);
    assert.equal(matchRoute(routes, 'GET', '/v1/tracks/%/audio'), undefined);
  });
});
