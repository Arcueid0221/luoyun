import axios, { AxiosError, type AxiosInstance, type AxiosResponse } from 'axios';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import * as https from 'node:https';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { weapi, linuxapi, eapi } from './crypto.ts';
import { getAuthManager } from './auth.ts';
import { AuthExpiredError, isLoginRequiredCode } from './errors.ts';
import { verbose, debug } from './logger.ts';

// 强制 IPv4。网易的 CDN 对 IPv6 出口的防盗链判定更严，走 v6 会拿到 403。
const httpAgent = new http.Agent({ family: 4 });
const httpsAgent = new https.Agent({ family: 4 });

const BASE_URL = 'https://music.163.com';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0';

let requestTimeout = 30000;

export type CryptoType = 'weapi' | 'linuxapi' | 'eapi';

export interface RequestOptions {
  crypto?: CryptoType;
  url?: string;
}

/** download 的进度回调。total 来自 content-length，可能缺失 */
export type ProgressFn = (received: number, total?: number) => void;

export interface DownloadStream {
  stream: Readable;
  contentLength?: number;
  contentType?: string;
}

export class ApiClient {
  private client: AxiosInstance;

  private readonly sDeviceId = `unknown-${Math.floor(Math.random() * 1000000)}`;
  private readonly nmtid = crypto.randomBytes(16).toString('hex');

  private sessionCookies: Record<string, string> = {};

  constructor() {
    this.client = axios.create({
      baseURL: BASE_URL,
      timeout: requestTimeout,
      httpAgent,
      httpsAgent,
      headers: {
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: 'https://music.163.com',
      },
    });
  }

  updateTimeout(ms: number): void {
    this.client.defaults.timeout = ms;
  }

  private collectCookies(response: AxiosResponse): void {
    const setCookieHeaders = response.headers['set-cookie'];
    if (!setCookieHeaders) return;
    for (const header of setCookieHeaders) {
      const match = header.match(/^([^=]+)=([^;]*)/);
      if (match) {
        this.sessionCookies[match[1]] = match[2];
      }
    }
  }

  private getCookieHeader(endpoint?: string): string {
    const userCookies = getAuthManager().getCookieString();

    const parts: string[] = ['os=pc', `sDeviceId=${this.sDeviceId}`, '__remember_me=true'];

    if (endpoint && endpoint.includes('login')) {
      parts.push(`NMTID=${this.nmtid}`);
    }

    if (userCookies) {
      parts.push(userCookies);
    }

    for (const [name, value] of Object.entries(this.sessionCookies)) {
      parts.push(`${name}=${value}`);
    }

    // 注意：绝对不要 debug 打印这个返回值，里面有 MUSIC_U。
    return parts.join('; ');
  }

  async request<T>(endpoint: string, data: object = {}, options: RequestOptions = {}): Promise<T> {
    const { crypto: cryptoType = 'weapi' } = options;

    let url: string;
    let postData: Record<string, string>;

    const requestData = { ...data };

    switch (cryptoType) {
      case 'weapi': {
        url = `/weapi${endpoint}`;
        const encrypted = weapi(requestData);
        postData = {
          params: encrypted.params,
          encSecKey: encrypted.encSecKey,
        };
        break;
      }
      case 'linuxapi': {
        url = '/api/linux/forward';
        const encrypted = linuxapi({
          method: 'POST',
          url: `${BASE_URL}/api${endpoint}`,
          params: requestData,
        });
        postData = { eparams: encrypted.eparams };
        break;
      }
      case 'eapi': {
        const eapiUrl = options.url || `/api${endpoint}`;
        url = `/eapi${endpoint}`;
        const encrypted = eapi(eapiUrl, requestData);
        postData = { params: encrypted.params };
        break;
      }
    }

    verbose(`${cryptoType.toUpperCase()} ${endpoint}`);
    debug(`POST ${url}`);

    try {
      const response = await this.client.post<T>(url, new URLSearchParams(postData).toString(), {
        headers: {
          Cookie: this.getCookieHeader(endpoint),
        },
      });

      this.collectCookies(response);

      const responseData = response.data as { code?: number; message?: string; msg?: string };
      debug(`Response code: ${responseData.code ?? 200}`);
      if (responseData.code && responseData.code !== 200) {
        const msg = responseData.message || responseData.msg || 'Unknown error';
        // code 301 是"需要登录"，HTTP 状态码仍然是 200。它和别的失败要分开：
        // 调用方看到 AuthExpiredError 应该去要一次新的 MUSIC_U，而不是重试。
        if (isLoginRequiredCode(responseData.code)) {
          throw new AuthExpiredError(`${msg} (code: ${responseData.code})`);
        }
        throw new Error(`${msg} (code: ${responseData.code})`);
      }

      return response.data;
    } catch (error) {
      if (error instanceof AxiosError) {
        if (error.response) this.collectCookies(error.response);
        debug(`HTTP error: ${error.response?.status ?? error.code}`);
        if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
          throw new Error('网络连接失败');
        }
        if (error.response?.status === 401) {
          throw new AuthExpiredError('登录已失效，请重新填入 MUSIC_U');
        }
        if (error.response?.status === 403) {
          throw new AuthExpiredError('访问被拒绝，cookie 可能已过期');
        }
        throw new Error(`请求失败: ${error.message}`);
      }
      throw error;
    }
  }

  /**
   * 下载到 destPath，返回实际写入的字节数。
   *
   * 关键点：先写 destPath + '.part'，pipeline 成功后才 rename。
   * 否则中途断网会留下一个被截断的 audio.flac，而 sqlite 里已经记成 done ——
   * 之后永远不会重下，用户拿到一个播一半就断的文件。
   */
  async download(
    url: string,
    destPath: string,
    onProgress?: ProgressFn,
    signal?: AbortSignal,
  ): Promise<number> {
    verbose(`Downloading -> ${path.basename(path.dirname(destPath))}/${path.basename(destPath)}`);

    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const partPath = `${destPath}.part`;

    try {
      const response = await axios.get<Readable>(url, {
        responseType: 'stream',
        timeout: 120000,
        httpAgent,
        httpsAgent,
        signal,
        headers: {
          'User-Agent': USER_AGENT,
          // 音频 CDN 要 Referer，缺了就 403。浏览器里 fetch 改不了这个头，
          // 这也是为什么下载必须走 Node 这一层。
          Referer: 'https://music.163.com/',
        },
      });

      const totalHeader = response.headers['content-length'];
      const total = totalHeader ? Number(totalHeader) : undefined;

      let received = 0;
      if (onProgress) {
        response.data.on('data', (chunk: Buffer) => {
          received += chunk.length;
          onProgress(received, Number.isFinite(total) ? total : undefined);
        });
      } else {
        response.data.on('data', (chunk: Buffer) => {
          received += chunk.length;
        });
      }

      await pipeline(response.data, fs.createWriteStream(partPath));
      fs.renameSync(partPath, destPath);
      return received;
    } catch (error) {
      // 失败就把 .part 清掉，不留垃圾
      try {
        fs.rmSync(partPath, { force: true });
      } catch {
        /* 清理失败无所谓 */
      }
      throw error;
    }
  }

  /**
   * 打开网易音频 CDN 的响应流，供受保护的 Provider 接口转发。
   *
   * 这里复用和本地下载相同的 IPv4 Agent、User-Agent 与 Referer；调用方负责
   * 消费并关闭 stream。整个过程中不把音频缓存在 Node 堆内存里。
   */
  async openDownloadStream(url: string, signal?: AbortSignal): Promise<DownloadStream> {
    try {
      const response = await axios.get<Readable>(url, {
        responseType: 'stream',
        timeout: 120000,
        httpAgent,
        httpsAgent,
        signal,
        headers: {
          'User-Agent': USER_AGENT,
          Referer: 'https://music.163.com/',
        },
      });
      const rawLength = response.headers['content-length'];
      const contentLength = typeof rawLength === 'string' ? Number(rawLength) : undefined;
      const rawType = response.headers['content-type'];
      return {
        stream: response.data,
        contentLength: Number.isFinite(contentLength) ? contentLength : undefined,
        contentType: typeof rawType === 'string' ? rawType : undefined,
      };
    } catch (error) {
      if (error instanceof AxiosError) {
        throw new Error(`音频下载失败: ${error.response?.status ?? error.code ?? error.message}`);
      }
      throw error;
    }
  }
}

export function setRequestTimeout(ms: number): void {
  requestTimeout = ms;
  if (clientInstance) {
    clientInstance.updateTimeout(ms);
  }
}

let clientInstance: ApiClient | null = null;

export function getApiClient(): ApiClient {
  if (!clientInstance) {
    clientInstance = new ApiClient();
  }
  return clientInstance;
}
