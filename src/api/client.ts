import type { Job, JobEvent } from '../../server/core/types.ts';

// 页面和 API 是同一个 Vite server，所以全都是同源相对请求 ——
// 不需要配 proxy，也不需要 CORS。

export class ApiError extends Error {
  // 和 server/http.ts 的 HttpError 一样不用构造器参数属性，见那边的注释
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = 'ApiError';
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    // 写请求一律带 application/json，即使没有 body：
    // 服务端靠这个头拒掉跨站表单 / text-plain 提交（那两种浏览器不预检就能送达），
    // 见 server/http.ts 的 guardRequest。
    headers: method === 'GET' ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  // 后端崩到 Vite 自己的错误页时会返回 HTML，所以先读文本再试着解析
  const text = await response.text();
  let data: unknown;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
  }

  if (!response.ok) {
    throw new ApiError(errorMessage(data, response.status), response.status);
  }
  return data as T;
}

function errorMessage(data: unknown, status: number): string {
  if (data && typeof data === 'object' && 'error' in data) {
    const { error } = data as { error: unknown };
    if (typeof error === 'string' && error) return error;
  }
  return `请求失败（HTTP ${status}）`;
}

export function get<T>(path: string): Promise<T> {
  return request<T>('GET', path);
}

export function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>('POST', path, body);
}

/**
 * 事件流里除了后端定义的 JobEvent，还有两个只存在于前端的：
 * snapshot 是连上时推的全量快照，closed 是连接断掉且 EventSource 放弃重连。
 */
export type StreamEvent = JobEvent | { type: 'snapshot'; job: Job } | { type: 'closed' };

/** 返回关闭函数。useEffect 的清理里必须调，否则切走再回来会叠加多个 EventSource。 */
export function openEvents(jobId: string, onEvent: (event: StreamEvent) => void): () => void {
  const source = new EventSource(`/api/download/${encodeURIComponent(jobId)}/events`);

  source.addEventListener('snapshot', (e) => {
    onEvent({ type: 'snapshot', job: JSON.parse((e as MessageEvent<string>).data) as Job });
  });
  for (const name of ['track', 'done', 'error'] as const) {
    source.addEventListener(name, (e) => {
      // 'error' 既是后端任务级错误的事件名，也是 EventSource 自己汇报传输失败的事件名。
      // 后者是个光秃秃的 Event，没有 data，直接 JSON.parse 会在每次断线重连时抛一次。
      const data = (e as MessageEvent<unknown>).data;
      if (typeof data !== 'string') return;
      onEvent(JSON.parse(data) as JobEvent);
    });
  }

  source.onerror = () => {
    // 网络抖动时 EventSource 会自己重连（readyState 回到 CONNECTING），
    // 只有它彻底放弃（比如任务 404 了）才通知上层
    if (source.readyState === EventSource.CLOSED) onEvent({ type: 'closed' });
  };

  return () => source.close();
}
