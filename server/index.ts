// 동시편집 서버 (HWPX·XLSX).
//   - REST  : 로그인, 문서 올리기/목록/원본/내보내기/버전, 편집 권한 주기
//   - WS    : Hocuspocus(Yjs) 동기화 — 같은 포트의 WebSocket 업그레이드, 문서 권한 확인
//   - 저장  : 편집이 멈추면 원본 + Y 상태로 파일을 다시 만들어 저장

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import * as Y from 'yjs';
import { unzipSync } from 'fflate';
import { Server } from '@hocuspocus/server';
import { initRhwp, openDocument, blankHwpx } from '../src/shared/rhwp-node.ts';
import { seedYDoc } from '../src/shared/model.ts';
import { parseXlsx } from '../src/shared/xlsx/parse.ts';
import { blankXlsx } from '../src/shared/xlsx/write.ts';
import type { WorkbookModel } from '../src/shared/xlsx/types.ts';
import { Store } from './store.ts';
import type { DocKind, DocMeta, SaveStatus } from './store.ts';
import { renderHwpx, renderXlsx } from './saver.ts';
import { webdavFromEnv } from './webdav.ts';
import type { WebDav } from './webdav.ts';
import { UserStore, UserError } from './users.ts';
import type { User } from './users.ts';
import { authRouter, requireUser, checkOrigin, parseCookies, sameOrigin, COOKIE } from './auth.ts';
import { FolderStore } from './folders.ts';
import type { Folder } from './folders.ts';

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
  /** 누구나 스스로 가입할 수 있는지 (기본: 환경변수 SIGNUP 이 closed 가 아니면 가능) */
  signup?: boolean;
  /** HTTPS 에서만 로그인 쿠키를 보낸다 (기본: 환경변수 COOKIE_SECURE=1) */
  secureCookie?: boolean;
  log?: Logger;
}

export interface CoeditServer {
  app: express.Express;
  server: Server;
  store: Store;
  users: UserStore;
  folders: FolderStore;
  listen(port?: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

/** 실시간 접속마다 붙는 정보 */
interface ConnContext {
  userId: string;
}

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const MIME: Record<DocKind, string> = {
  hwpx: 'application/hwp+zip',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** 문서를 열고 고칠 수 있는지: 올린 사람, 편집 권한을 받은 사람, 문서가 든 폴더의 구성원 */
export const canEdit = (meta: DocMeta, userId: string, folder?: Folder | null): boolean =>
  meta.owner === userId || meta.editors.includes(userId) || (!!folder && meta.folderId === folder.id && FolderStore.isMember(folder, userId));

/** 올린 파일의 종류를 알아낸다. */
function detectKind(bytes: Uint8Array, filename: string): DocKind {
  if (/\.xls$/i.test(filename)) throw new UserError('예전 엑셀 형식(.xls)은 열 수 없습니다. 엑셀에서 .xlsx 로 저장한 뒤 올리세요.');
  if (/\.(csv|ods|xlsm|xlsb)$/i.test(filename)) throw new UserError('XLSX 파일만 올릴 수 있습니다.');
  // zip 이면서 xl/workbook.xml 이 있으면 XLSX
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    try {
      const names = Object.keys(unzipSync(bytes, { filter: (f) => f.name === 'xl/workbook.xml' }));
      if (names.length) return 'xlsx';
    } catch {
      /* zip 이 아니면 한글 문서로 본다 */
    }
  }
  return 'hwpx';
}

export async function createServer({
  dataDir = process.env.DATA_DIR || path.join(here, '..', 'data'),
  webDir = path.join(here, '..', 'dist', 'web'),
  webdav = webdavFromEnv(),
  debounce = 2000,
  maxDebounce = 10000,
  signup = process.env.SIGNUP !== 'closed',
  secureCookie = process.env.COOKIE_SECURE === '1',
  log = console,
}: ServerOptions = {}): Promise<CoeditServer> {
  await initRhwp();
  const store = new Store(dataDir);
  const users = new UserStore(dataDir);
  const folders = new FolderStore(dataDir);

  async function canAccess(meta: DocMeta, userId: string): Promise<boolean> {
    return canEdit(meta, userId, await folders.get(meta.folderId));
  }

  // XLSX 해석 결과는 문서마다 한 번만 읽는다.
  const models = new Map<string, WorkbookModel>();
  async function modelOf(id: string): Promise<WorkbookModel | null> {
    const hit = models.get(id);
    if (hit) return hit;
    const json = await store.modelJson(id);
    if (!json) return null;
    const m = JSON.parse(json) as WorkbookModel;
    models.set(id, m);
    return m;
  }

  // Y 상태와 저장본을 기록한다. 문서가 열려 있으면 살아 있는 Y 문서를 쓴다.
  async function persist(id: string, ydoc: Y.Doc): Promise<Uint8Array | null> {
    const meta = await store.meta(id);
    const base = await store.base(id);
    if (!meta || !base) return null;
    await store.saveYdoc(id, Y.encodeStateAsUpdate(ydoc));
    const save: SaveStatus = { at: new Date().toISOString(), ok: true, diffs: 0, webdav: null };
    let bytes: Uint8Array | null = null;
    try {
      let out: { bytes: Uint8Array; diffs: unknown[] };
      if (meta.kind === 'xlsx') {
        const model = await modelOf(id);
        if (!model) throw new Error('XLSX 해석 결과가 없습니다.');
        out = renderXlsx(base, model, ydoc);
      } else {
        out = renderHwpx(base, ydoc);
      }
      bytes = out.bytes;
      save.diffs = out.diffs.length;
      save.ok = out.diffs.length === 0;
      if (out.diffs.length) log.warn(`[저장 검사] ${id}: 불일치 ${out.diffs.length}건`, out.diffs.slice(0, 3));
      await store.saveFile(id, meta.kind, bytes);
    } catch (e) {
      save.ok = false;
      save.error = errorMessage(e);
      log.error(`[저장 실패] ${id}:`, e);
    }
    const updated = await store.updateMeta(id, { updatedAt: save.at, save });
    if (bytes && webdav && updated) {
      try {
        save.webdav = await webdav.put(updated, bytes);
      } catch (e) {
        save.webdav = errorMessage(e);
        log.warn(`[WebDAV] ${id}:`, save.webdav);
      }
      await store.updateMeta(id, { save });
    }
    return bytes;
  }

  /** 권한이 빠진 사람의 실시간 접속을 끊는다. */
  async function kickUnauthorized(id: string, meta: DocMeta | null): Promise<void> {
    const doc = hocuspocus.documents.get(id);
    if (!doc) return;
    const folder = meta ? await folders.get(meta.folderId) : null;
    for (const conn of doc.getConnections()) {
      const ctx = conn.context as ConnContext | undefined;
      if (!meta || !ctx || !canEdit(meta, ctx.userId, folder)) conn.close({ code: 4403, reason: 'Forbidden' });
    }
  }

  /** 폴더 안 문서들의 접속을 다시 검사한다 (구성원이 바뀌거나 폴더가 없어졌을 때). */
  async function recheckFolder(folderId: string): Promise<void> {
    for (const m of await store.list()) if (m.folderId === folderId) await kickUnauthorized(m.id, m);
  }

  const app = express();
  app.disable('x-powered-by');
  if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);
  app.use('/api', checkOrigin);
  app.use('/api/auth', authRouter({ users, signup, secureCookie }));

  const api = express.Router();
  api.use(requireUser(users));
  const asyncRoute =
    (fn: (req: Request, res: Response) => Promise<unknown>) =>
    (req: Request, res: Response, next: NextFunction): void => {
      fn(req, res).catch(next);
    };
  const notFound = (res: Response, what = '문서를'): void => {
    res.status(404).json({ error: `${what} 찾을 수 없습니다.` });
  };
  const me = (req: Request): User => req.user!;

  /** 경로의 문서를 읽고 권한을 확인한다. 권한이 없으면 문서가 없는 것처럼 답한다. */
  async function docFor(req: Request, res: Response, { ownerOnly = false } = {}): Promise<DocMeta | null> {
    const id = String(req.params.id);
    const meta = Store.isId(id) ? await store.meta(id) : null;
    if (!meta || !(await canAccess(meta, me(req).id))) {
      notFound(res);
      return null;
    }
    if (ownerOnly && meta.owner !== me(req).id) {
      res.status(403).json({ error: '문서를 올린 사람만 할 수 있습니다.' });
      return null;
    }
    return meta;
  }

  /** 화면에 보낼 사람 정보 */
  async function people(ids: string[]): Promise<Map<string, { id: string; username: string; name: string }>> {
    const list = await users.getMany(ids);
    return new Map(list.map((u) => [u.id, { id: u.id, username: u.username, name: u.name }]));
  }

  /** 화면에 보낼 문서 정보 (소유자·편집자 이름, 폴더 포함) */
  async function docView(meta: DocMeta, userId: string): Promise<object> {
    const byId = await people([meta.owner, ...meta.editors]);
    const folder = await folders.get(meta.folderId);
    return {
      ...meta,
      role: meta.owner === userId ? 'owner' : meta.editors.includes(userId) ? 'editor' : 'folder',
      ownerUser: byId.get(meta.owner) ?? null,
      editorUsers: meta.editors.map((id) => byId.get(id)).filter(Boolean),
      folder: folder ? { id: folder.id, name: folder.name } : null,
    };
  }

  /** 화면에 보낼 폴더 정보 */
  async function folderView(f: Folder, userId: string, docCount: number): Promise<object> {
    const byId = await people([f.owner, ...f.members]);
    return {
      id: f.id,
      name: f.name,
      owner: f.owner,
      members: f.members,
      createdAt: f.createdAt,
      role: f.owner === userId ? 'owner' : 'member',
      ownerUser: byId.get(f.owner) ?? null,
      memberUsers: f.members.map((id) => byId.get(id)).filter(Boolean),
      docCount,
    };
  }

  /** 폴더를 읽고 구성원인지 확인한다. 아니면 없는 것처럼 답한다. */
  async function folderFor(req: Request, res: Response, { ownerOnly = false } = {}): Promise<Folder | null> {
    const f = await folders.get(String(req.params.fid));
    if (!f || !FolderStore.isMember(f, me(req).id)) {
      notFound(res, '폴더를');
      return null;
    }
    if (ownerOnly && f.owner !== me(req).id) {
      res.status(403).json({ error: '폴더를 만든 사람만 할 수 있습니다.' });
      return null;
    }
    return f;
  }

  api.get('/users', asyncRoute(async (req, res) => {
    const q = String(req.query.q ?? '').slice(0, 50);
    const found = await users.search(q);
    res.json(found.filter((u) => u.id !== me(req).id).map((u) => ({ id: u.id, username: u.username, name: u.name })));
  }));

  // 문서 목록. ?folder=<폴더 id> 면 그 폴더만, ?folder=none 이면 폴더에 넣지 않은 것만.
  api.get('/docs', asyncRoute(async (req, res) => {
    const uid = me(req).id;
    const myFolders = new Map((await folders.forUser(uid)).map((f) => [f.id, f]));
    const filter = typeof req.query.folder === 'string' ? req.query.folder : '';
    const mine = (await store.list()).filter((m) => {
      if (!canEdit(m, uid, m.folderId ? myFolders.get(m.folderId) : null)) return false;
      if (filter === 'none') return !m.folderId || !myFolders.has(m.folderId);
      if (filter) return m.folderId === filter;
      return true;
    });
    res.json(await Promise.all(mine.map((m) => docView(m, uid))));
  }));

  // ── 업무 폴더 ──
  api.get('/folders', asyncRoute(async (req, res) => {
    const uid = me(req).id;
    const list = await folders.forUser(uid);
    const docs = await store.list();
    res.json(await Promise.all(list.map((f) => folderView(f, uid, docs.filter((d) => d.folderId === f.id).length))));
  }));

  api.post('/folders', express.json(), asyncRoute(async (req, res) => {
    const body = req.body as { name?: unknown } | undefined;
    const f = await folders.create(String(body?.name ?? ''), me(req).id);
    res.status(201).json(await folderView(f, me(req).id, 0));
  }));

  api.get('/folders/:fid', asyncRoute(async (req, res) => {
    const f = await folderFor(req, res);
    if (!f) return;
    const count = (await store.list()).filter((d) => d.folderId === f.id).length;
    res.json(await folderView(f, me(req).id, count));
  }));

  api.patch('/folders/:fid', express.json(), asyncRoute(async (req, res) => {
    const f = await folderFor(req, res, { ownerOnly: true });
    if (!f) return;
    const body = req.body as { name?: unknown } | undefined;
    const updated = await folders.update(f.id, { name: String(body?.name ?? '') });
    res.json(await folderView(updated, me(req).id, (await store.list()).filter((d) => d.folderId === f.id).length));
  }));

  // 폴더 구성원 정하기: 만든 사람이 구성원 목록을 통째로 정한다.
  api.put('/folders/:fid/members', express.json(), asyncRoute(async (req, res) => {
    const f = await folderFor(req, res, { ownerOnly: true });
    if (!f) return;
    const body = req.body as { userIds?: unknown } | undefined;
    const ids = Array.isArray(body?.userIds) ? body.userIds.filter((x): x is string => typeof x === 'string') : null;
    if (!ids) {
      res.status(400).json({ error: 'userIds 가 필요합니다.' });
      return;
    }
    const known = (await users.getMany(ids)).map((u) => u.id);
    const updated = await folders.update(f.id, { members: known });
    await recheckFolder(f.id);
    res.json(await folderView(updated, me(req).id, (await store.list()).filter((d) => d.folderId === f.id).length));
  }));

  // 폴더 지우기: 안의 문서는 지우지 않고 폴더 밖으로 꺼낸다.
  api.delete('/folders/:fid', asyncRoute(async (req, res) => {
    const f = await folderFor(req, res, { ownerOnly: true });
    if (!f) return;
    await folders.remove(f.id);
    for (const m of await store.list()) {
      if (m.folderId !== f.id) continue;
      const updated = await store.updateMeta(m.id, { folderId: null });
      await kickUnauthorized(m.id, updated);
    }
    res.status(204).end();
  }));

  // 문서 만들기: 본문에 파일 바이트를 실어 보내면 그 문서로, 비어 있으면 ?kind= 의 빈 문서로 시작한다.
  api.post('/docs', express.raw({ type: () => true, limit: '100mb' }), asyncRoute(async (req, res) => {
    const filename = String(req.query.filename || '').slice(0, 200);
    let folderId: string | null = null;
    if (req.query.folder) {
      const f = await folders.get(String(req.query.folder));
      if (!f || !FolderStore.isMember(f, me(req).id)) {
        res.status(404).json({ error: '폴더를 찾을 수 없습니다.' });
        return;
      }
      folderId = f.id;
    }
    const body: unknown = req.body;
    const uploaded = Buffer.isBuffer(body) && body.length ? new Uint8Array(body) : null;
    let kind: DocKind;
    try {
      kind = uploaded ? detectKind(uploaded, filename) : req.query.kind === 'xlsx' ? 'xlsx' : 'hwpx';
    } catch (e) {
      res.status(400).json({ error: errorMessage(e) });
      return;
    }
    const base = uploaded ?? (kind === 'xlsx' ? blankXlsx() : blankHwpx());
    let title = String(req.query.title || '').trim().slice(0, 200);
    if (!title) title = filename.replace(/\.(hwpx?|hml|xlsx)$/i, '') || (kind === 'xlsx' ? '새 통합 문서' : '새 문서');

    const ydoc = new Y.Doc();
    let model: WorkbookModel | undefined;
    try {
      if (kind === 'xlsx') {
        model = parseXlsx(base);
      } else {
        const hwp = openDocument(base);
        try {
          seedYDoc(ydoc, hwp);
        } finally {
          hwp.free();
        }
      }
    } catch (e) {
      res.status(400).json({ error: `문서를 열 수 없습니다: ${errorMessage(e)}` });
      return;
    }
    const meta = await store.create({
      kind,
      title,
      filename,
      owner: me(req).id,
      folderId,
      base,
      ydocUpdate: Y.encodeStateAsUpdate(ydoc),
      model,
    });
    if (model) models.set(meta.id, model);
    res.status(201).json(await docView(meta, me(req).id));
  }));

  api.get('/docs/:id', asyncRoute(async (req, res) => {
    const meta = await docFor(req, res);
    if (!meta) return;
    res.json({ ...(await docView(meta, me(req).id)), versions: await store.versions(meta.id) });
  }));

  api.patch('/docs/:id', express.json(), asyncRoute(async (req, res) => {
    const meta = await docFor(req, res, { ownerOnly: true });
    if (!meta) return;
    const body = req.body as { title?: unknown } | undefined;
    const title = String(body?.title || '').trim().slice(0, 200);
    if (!title) {
      res.status(400).json({ error: '제목이 비어 있습니다.' });
      return;
    }
    const updated = await store.updateMeta(meta.id, { title });
    res.json(await docView(updated!, me(req).id));
  }));

  // 편집 권한 주기: 올린 사람이 편집자 목록을 통째로 정한다.
  api.put('/docs/:id/editors', express.json(), asyncRoute(async (req, res) => {
    const meta = await docFor(req, res, { ownerOnly: true });
    if (!meta) return;
    const body = req.body as { userIds?: unknown } | undefined;
    const ids = Array.isArray(body?.userIds) ? body.userIds.filter((x): x is string => typeof x === 'string') : null;
    if (!ids) {
      res.status(400).json({ error: 'userIds 가 필요합니다.' });
      return;
    }
    const known = await users.getMany(ids);
    const editors = [...new Set(known.map((u) => u.id))].filter((id) => id !== meta.owner).slice(0, 200);
    const updated = await store.updateMeta(meta.id, { editors });
    await kickUnauthorized(meta.id, updated);
    res.json(await docView(updated!, me(req).id));
  }));

  // 문서를 폴더에 넣거나 꺼낸다. 문서를 올린 사람이 자신이 구성원인 폴더로만 옮길 수 있다.
  api.put('/docs/:id/folder', express.json(), asyncRoute(async (req, res) => {
    const meta = await docFor(req, res, { ownerOnly: true });
    if (!meta) return;
    const body = req.body as { folderId?: unknown } | undefined;
    let folderId: string | null = null;
    if (body?.folderId) {
      const f = await folders.get(String(body.folderId));
      if (!f || !FolderStore.isMember(f, me(req).id)) {
        res.status(404).json({ error: '폴더를 찾을 수 없습니다.' });
        return;
      }
      folderId = f.id;
    }
    const updated = await store.updateMeta(meta.id, { folderId });
    await kickUnauthorized(meta.id, updated);
    res.json(await docView(updated!, me(req).id));
  }));

  api.delete('/docs/:id', asyncRoute(async (req, res) => {
    const meta = await docFor(req, res, { ownerOnly: true });
    if (!meta) return;
    await kickUnauthorized(meta.id, null);
    models.delete(meta.id);
    await store.remove(meta.id);
    res.status(204).end();
  }));

  api.get('/docs/:id/base', asyncRoute(async (req, res) => {
    const meta = await docFor(req, res);
    if (!meta) return;
    const bytes = await store.base(meta.id);
    if (!bytes) return notFound(res);
    res.set('Cache-Control', 'private, max-age=31536000, immutable');
    res.type('application/octet-stream').send(Buffer.from(bytes));
  }));

  api.get('/docs/:id/model', asyncRoute(async (req, res) => {
    const meta = await docFor(req, res);
    if (!meta) return;
    const json = meta.kind === 'xlsx' ? await store.modelJson(meta.id) : null;
    if (!json) return notFound(res, 'XLSX 정보를');
    res.set('Cache-Control', 'private, max-age=31536000, immutable');
    res.type('application/json').send(json);
  }));

  const sendFile = (res: Response, kind: DocKind, title: string, bytes: Uint8Array): void => {
    res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(title)}.${kind}`);
    res.set('Cache-Control', 'no-store');
    res.type(MIME[kind]).send(Buffer.from(bytes));
  };

  // 지금 상태를 파일로 내려받는다.
  api.get('/docs/:id/export', asyncRoute(async (req, res) => {
    const meta = await docFor(req, res);
    if (!meta) return;
    let ydoc: Y.Doc | undefined = hocuspocus.documents.get(meta.id);
    if (!ydoc) {
      const update = await store.ydoc(meta.id);
      if (!update) return notFound(res);
      ydoc = new Y.Doc();
      Y.applyUpdate(ydoc, update);
    }
    const bytes = await persist(meta.id, ydoc);
    if (!bytes) {
      res.status(500).json({ error: '파일을 만들지 못했습니다.' });
      return;
    }
    sendFile(res, meta.kind, meta.title, bytes);
  }));

  api.get('/docs/:id/versions/:name', asyncRoute(async (req, res) => {
    const meta = await docFor(req, res);
    if (!meta) return;
    const name = String(req.params.name);
    const bytes = await store.version(meta.id, name);
    if (!bytes) return notFound(res, '저장본을');
    sendFile(res, meta.kind, `${meta.title} ${name.replace(/\.(hwpx|xlsx)$/, '')}`, bytes);
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
    if (res.headersSent) return next(err);
    if (err instanceof UserError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    log.error(err);
    const e = err as { status?: number; type?: string };
    res.status(e.status || 500).json({ error: e.type === 'entity.too.large' ? '파일이 너무 큽니다.' : '서버 오류' });
  });

  const server = new Server({
    quiet: true,
    stopOnSignals: false,
    debounce,
    maxDebounce,

    // 로그인 쿠키로 사람을 확인하고, 그 문서의 편집 권한이 있는지 본다.
    async onAuthenticate({ documentName, requestHeaders }): Promise<ConnContext> {
      if (!sameOrigin(requestHeaders.get('origin'), requestHeaders.get('host'))) throw new Error('Forbidden');
      const user = await users.userForToken(parseCookies(requestHeaders.get('cookie'))[COOKIE]);
      const meta = user && Store.isId(documentName) ? await store.meta(documentName) : null;
      if (!user || !meta || !(await canAccess(meta, user.id))) throw new Error('Forbidden');
      return { userId: user.id };
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
    users,
    folders,
    async listen(port = Number(process.env.PORT) || 8787, host = process.env.HOST || '0.0.0.0') {
      server.configuration.address = host;
      // listen(0) 은 0 을 무시하므로 설정에 직접 넣는다 (0 = 빈 포트 자동 선택).
      server.configuration.port = port;
      await server.listen();
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
  console.log(`동시편집 서버: http://localhost:${port}`);
  if ((await srv.users.count()) === 0) {
    console.log('아직 계정이 없습니다. 화면에서 가입하거나 `node scripts/users.ts add <아이디> <이름> <암호>` 로 만드세요.');
  }
  const stop = async (): Promise<void> => {
    await srv.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
