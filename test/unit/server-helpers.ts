// 서버 시험 도우미: 서버 띄우기, 로그인한 사용자로 API·실시간 접속
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import * as Y from 'yjs';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { createServer } from '../../server/index.ts';
import type { ServerOptions, CoeditServer } from '../../server/index.ts';

export const quiet = { warn() {}, error() {}, log() {} };

export interface TestServer {
  srv: CoeditServer;
  port: number;
  origin: string;
  close(): Promise<void>;
}

export async function startServer(opts: ServerOptions = {}): Promise<TestServer> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'coedit-'));
  const srv = await createServer({ dataDir, debounce: 50, maxDebounce: 200, log: quiet, webDir: '/nonexistent', webdav: null, ...opts });
  const port = await srv.listen(0, '127.0.0.1');
  return {
    srv,
    port,
    origin: `http://127.0.0.1:${port}`,
    async close() {
      await srv.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

/** 로그인 쿠키를 들고 다니는 사용자 */
export class Agent {
  readonly origin: string;
  cookie = '';
  id = '';

  constructor(origin: string) {
    this.origin = origin;
  }

  async fetch(p: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookie) headers.set('cookie', this.cookie);
    headers.set('origin', this.origin);
    const res = await fetch(`${this.origin}${p}`, { ...init, headers });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0]!;
    return res;
  }

  json(p: string, method: string, body: unknown): Promise<Response> {
    return this.fetch(p, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }

  async signup(username: string, name = username, password = 'password1234'): Promise<this> {
    const res = await this.json('/api/auth/signup', 'POST', { username, name, password });
    if (res.status !== 201) throw new Error(`가입 실패 ${res.status}: ${await res.text()}`);
    this.id = ((await res.json()) as { user: { id: string } }).user.id;
    return this;
  }

  /** 실시간 접속 */
  connect(port: number, docId: string): Client {
    const cookie = this.cookie;
    const origin = this.origin;
    class CookieWebSocket extends WebSocket {
      constructor(url: string | URL) {
        // Node(undici) 의 WebSocket 은 머리글을 넣을 수 있다.
        super(url, { headers: { cookie, origin } } as unknown as string[]);
      }
    }
    const ydoc = new Y.Doc();
    const websocketProvider = new HocuspocusProviderWebsocket({
      url: `ws://127.0.0.1:${port}/collab`,
      WebSocketPolyfill: CookieWebSocket,
    });
    const provider = new HocuspocusProvider({ websocketProvider, name: docId, document: ydoc, token: 'cookie' });
    // 따로 만든 연결을 넘기면 직접 붙여야 한다.
    provider.attach();
    let denied = false;
    let closedReason = '';
    const result = new Promise<'synced' | 'denied'>((resolve) => {
      provider.on('synced', () => resolve('synced'));
      provider.on('authenticationFailed', () => {
        denied = true;
        resolve('denied');
      });
      // 접속 중에 권한을 잃으면 서버가 그 문서 연결만 닫는다.
      provider.on('close', ({ event }: { event: { reason?: string } }) => {
        closedReason = event?.reason ?? '';
        if (event?.reason === 'Forbidden') {
          denied = true;
          resolve('denied');
        }
      });
    });
    return {
      ydoc,
      provider,
      result,
      get denied() {
        return denied;
      },
      get closedReason() {
        return closedReason;
      },
      destroy() {
        provider.destroy();
        websocketProvider.destroy();
      },
    };
  }
}

export interface Client {
  ydoc: Y.Doc;
  provider: HocuspocusProvider;
  result: Promise<'synced' | 'denied'>;
  readonly denied: boolean;
  /** 서버가 이 문서 연결을 닫은 까닭 (Forbidden, RoleChanged) */
  readonly closedReason: string;
  destroy(): void;
}

export const until = async (fn: () => boolean | Promise<boolean>, ms = 5000): Promise<void> => {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error('시간 초과');
    await new Promise((r) => setTimeout(r, 30));
  }
};

export const timeout = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);
