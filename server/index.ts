// HWPX 실시간 동시편집 서버.
//   - REST  : 문서 올리기/목록/원본/내보내기/버전
//   - WS    : Hocuspocus(Yjs) 동기화 — 같은 포트의 WebSocket 업그레이드
//   - 저장  : 편집이 멈추면 원본 + Y 상태로 HWPX 를 다시 만들어 저장

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import * as Y from 'yjs';
import { Server } from '@hocuspocus/server';
import { initRhwp, openDocument, blankHwpx } from '../src/shared/rhwp-node.ts';
import { seedYDoc } from '../src/shared/model.ts';
import { Store } from './store.ts';
import type { SaveStatus } from './store.ts';
import { renderHwpx } from './saver.ts';
import { webdavFromEnv } from './webdav.ts';
import type { WebDav } from './webdav.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

type Logger = Pick<Console, 'log' | 'warn' | 'error'>;

export interface ServerOptions {
  dataDir?: string;
  webDir?: string;
  webdav?: WebDav | null;
  /** 편집이 멈춘 뒤 저장까지 기다리는 시간(ms) */
  debounce?: number;
  /** 편집이 계속되어도 이 시간(ms)이 지나면 저장 */
  maxDebounce?: number;
  log?: Logger;
}

export interface CoeditServer {
  app: express.Express;
  server: Server;
  store: Store;
  listen(port?: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function createServer({
  dataDir = process.env.DATA_DIR || path.join(here, '..', 'data'),
  webDir = path.join(here, '..', 'dist', 'web'),
  webdav = webdavFromEnv(),
  debounce = 2000,
  maxDebounce = 10000,
  log = console,
}: ServerOptions = {}): Promise<CoeditServer> {
  await initRhwp();
  const store = new Store(dataDir);

  // Y 상태와 HWPX 저장본을 기록한다. 문서가 열려 있으면 살아 있는 Y 문서를 쓴다.
  async function persist(id: string, ydoc: Y.Doc): Promise<Uint8Array | null> {
    const base = await store.base(id);
    if (!base) return null;
    await store.saveYdoc(id, Y.encodeStateAsUpdate(ydoc));
    const save: SaveStatus = { at: new Date().toISOString(), ok: true, diffs: 0, webdav: null };
    let bytes: Uint8Array | null = null;
    try {
      const out = renderHwpx(base, ydoc);
      bytes = out.bytes;
      save.diffs = out.diffs.length;
      save.ok = out.diffs.length === 0;
      if (out.diffs.length) log.warn(`[저장 검사] ${id}: 불일치 ${out.diffs.length}건`, out.diffs.slice(0, 3));
      await store.saveHwpx(id, bytes);
    } catch (e) {
      save.ok = false;
      save.error = errorMessage(e);
      log.error(`[저장 실패] ${id}:`, e);
    }
    const meta = await store.updateMeta(id, { updatedAt: save.at, save });
    if (bytes && webdav && meta) {
      try {
        save.webdav = await webdav.put(meta, bytes);
      } catch (e) {
        save.webdav = errorMessage(e);
        log.warn(`[WebDAV] ${id}:`, save.webdav);
      }
      await store.updateMeta(id, { save });
    }
    return bytes;
  }

  const app = express();
  app.disable('x-powered-by');
  const api = express.Router();
  const asyncRoute =
    (fn: (req: Request, res: Response) => Promise<unknown>) =>
    (req: Request, res: Response, next: NextFunction): void => {
      fn(req, res).catch(next);
    };
  const notFound = (res: Response, what = '문서를'): void => {
    res.status(404).json({ error: `${what} 찾을 수 없습니다.` });
  };
  /** 경로의 문서 id (api.param 에서 형식을 이미 검사했다) */
  const docId = (req: Request): string => String(req.params.id);

  api.param('id', (req, res, next, id) => {
    if (!Store.isId(id)) return notFound(res);
    next();
  });

  api.get('/docs', asyncRoute(async (req, res) => {
    res.json(await store.list());
  }));

  // 문서 만들기: 본문에 HWP/HWPX 바이트를 실어 보내면 그 문서로, 비어 있으면 빈 문서로 시작한다.
  api.post('/docs', express.raw({ type: () => true, limit: '100mb' }), asyncRoute(async (req, res) => {
    const filename = String(req.query.filename || '').slice(0, 200);
    const body: unknown = req.body;
    const base = Buffer.isBuffer(body) && body.length ? new Uint8Array(body) : blankHwpx();
    let title = String(req.query.title || '').trim().slice(0, 200);
    if (!title) title = filename.replace(/\.(hwpx?|hml)$/i, '') || '새 문서';

    const ydoc = new Y.Doc();
    let hwp;
    try {
      hwp = openDocument(base);
    } catch (e) {
      res.status(400).json({ error: `문서를 열 수 없습니다: ${errorMessage(e)}` });
      return;
    }
    try {
      seedYDoc(ydoc, hwp);
    } finally {
      hwp.free();
    }
    const meta = await store.create({ title, filename, base, ydocUpdate: Y.encodeStateAsUpdate(ydoc) });
    res.status(201).json(meta);
  }));

  api.get('/docs/:id', asyncRoute(async (req, res) => {
    const id = docId(req);
    const meta = await store.meta(id);
    if (!meta) return notFound(res);
    res.json({ ...meta, versions: await store.versions(id) });
  }));

  api.patch('/docs/:id', express.json(), asyncRoute(async (req, res) => {
    const body = req.body as { title?: unknown } | undefined;
    const title = String(body?.title || '').trim().slice(0, 200);
    if (!title) {
      res.status(400).json({ error: '제목이 비어 있습니다.' });
      return;
    }
    const meta = await store.updateMeta(docId(req), { title });
    if (!meta) return notFound(res);
    res.json(meta);
  }));

  api.delete('/docs/:id', asyncRoute(async (req, res) => {
    const id = docId(req);
    hocuspocus.closeConnections(id);
    await store.remove(id);
    res.status(204).end();
  }));

  api.get('/docs/:id/base', asyncRoute(async (req, res) => {
    const bytes = await store.base(docId(req));
    if (!bytes) return notFound(res);
    res.set('Cache-Control', 'private, max-age=31536000, immutable');
    res.type('application/octet-stream').send(Buffer.from(bytes));
  }));

  const sendHwpx = (res: Response, title: string, bytes: Uint8Array): void => {
    res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(title)}.hwpx`);
    res.set('Cache-Control', 'no-store');
    res.type('application/hwp+zip').send(Buffer.from(bytes));
  };

  // 지금 상태를 HWPX 로 내려받는다.
  api.get('/docs/:id/export', asyncRoute(async (req, res) => {
    const id = docId(req);
    const meta = await store.meta(id);
    if (!meta) return notFound(res);
    let ydoc: Y.Doc | undefined = hocuspocus.documents.get(id);
    if (!ydoc) {
      const update = await store.ydoc(id);
      if (!update) return notFound(res);
      ydoc = new Y.Doc();
      Y.applyUpdate(ydoc, update);
    }
    const bytes = await persist(id, ydoc);
    if (!bytes) {
      res.status(500).json({ error: 'HWPX 를 만들지 못했습니다.' });
      return;
    }
    sendHwpx(res, meta.title, bytes);
  }));

  api.get('/docs/:id/versions/:name', asyncRoute(async (req, res) => {
    const id = docId(req);
    const name = String(req.params.name);
    const meta = await store.meta(id);
    const bytes = meta && (await store.version(id, name));
    if (!meta || !bytes) return notFound(res, '저장본을');
    sendHwpx(res, `${meta.title} ${name.replace('.hwpx', '')}`, bytes);
  }));

  app.use('/api', api);
  app.use('/api', (req, res) => {
    res.status(404).json({ error: '없는 API 입니다.' });
  });

  if (existsSync(webDir)) {
    app.use(express.static(webDir, { index: 'index.html' }));
    app.use((req, res, next) => {
      if (req.method !== 'GET') return next();
      res.sendFile(path.join(webDir, 'index.html'));
    });
  }

  app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
    log.error(err);
    if (res.headersSent) return next(err);
    const e = err as { status?: number; type?: string };
    res.status(e.status || 500).json({ error: e.type === 'entity.too.large' ? '파일이 너무 큽니다.' : '서버 오류' });
  });

  const server = new Server({
    quiet: true,
    stopOnSignals: false,
    debounce,
    maxDebounce,

    // 없는 문서로의 접속은 받지 않는다.
    async onConnect({ documentName }) {
      if (!Store.isId(documentName) || !(await store.meta(documentName))) {
        throw new Error('문서를 찾을 수 없습니다.');
      }
    },

    async onLoadDocument({ documentName, document }) {
      const update = Store.isId(documentName) ? await store.ydoc(documentName) : null;
      if (!update) throw new Error('문서를 찾을 수 없습니다.');
      Y.applyUpdate(document, update);
      return document;
    },

    async onStoreDocument({ documentName, document }) {
      await persist(documentName, document);
    },

    // 일반 HTTP 요청은 Express 가 처리한다. (거절해야 Hocuspocus 기본 응답이 나가지 않는다.)
    onRequest({ request, response }) {
      return new Promise<void>((resolve, reject) => {
        app(request, response);
        reject();
      });
    },
  });
  const hocuspocus = server.hocuspocus;

  return {
    app,
    server,
    store,
    async listen(port = Number(process.env.PORT) || 8787, host = process.env.HOST || '0.0.0.0') {
      server.configuration.address = host;
      await server.listen(port);
      return (server.httpServer.address() as AddressInfo).port;
    },
    async close() {
      hocuspocus.flushPendingStores();
      await server.destroy();
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const srv = await createServer();
  const port = await srv.listen();
  console.log(`HWPX 동시편집 서버: http://localhost:${port}`);
  const stop = async (): Promise<void> => {
    await srv.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
