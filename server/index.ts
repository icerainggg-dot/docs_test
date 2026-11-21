// 동시편집 서버 (HWPX·XLSX).
//   - REST  : 로그인, 업무 폴더, 문서 올리기/목록/원본/내보내기/버전, 권한(편집·보기, 사람·부서), 관리자
//   - WS    : Hocuspocus(Yjs) 동기화 — 같은 포트의 WebSocket 업그레이드, 문서 권한 확인(보기 권한은 읽기 전용)
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
import { FolderStore, MAX_FOLDER_DEPTH } from './folders.ts';
import type { Folder } from './folders.ts';
import { OrgStore } from './org.ts';
import { Access, atLeast } from './access.ts';
import type { Grant, Role, Who } from './access.ts';
import { adminRouter } from './admin.ts';

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
  org: OrgStore;
  access: Access;
  listen(port?: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

/** 실시간 접속마다 붙는 정보 */
interface ConnContext {
  userId: string;
  readOnly: boolean;
}

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const MIME: Record<DocKind, string> = {
  hwpx: 'application/hwp+zip',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

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
  const org = new OrgStore(dataDir);
  const access = new Access(folders, org, users);

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

  /**
   * 열려 있는 모든 실시간 연결의 권한을 다시 검사한다 (권한·조직·계정이 바뀐 뒤).
   * 권한이 없어졌으면 끊고(Forbidden), 편집↔보기가 바뀌었으면 끊어서 새 권한으로 다시 열게 한다(RoleChanged).
   */
  async function recheck(): Promise<void> {
    for (const [id, doc] of hocuspocus.documents) {
      const meta = await store.meta(id);
      for (const conn of doc.getConnections()) {
        const ctx = conn.context as ConnContext | undefined;
        const role = meta && ctx ? await access.docRole(meta, await access.who(ctx.userId)) : null;
        if (!role) conn.close({ code: 4403, reason: 'Forbidden' });
        else if ((role === 'view') !== ctx!.readOnly) conn.close({ code: 4409, reason: 'RoleChanged' });
      }
    }
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
  const whoOf = (req: Request): Promise<Who> => access.who(me(req));

  // ── 화면에 보낼 모양 ──
  const personView = async (u: User): Promise<object> => ({
    id: u.id,
    username: u.username,
    name: u.name,
    title: u.title,
    dept: u.deptId ? await org.pathName(u.deptId) : '',
  });

  async function grantsView(grants: Grant[]): Promise<object[]> {
    const people = new Map((await users.getMany(grants.filter((g) => g.type === 'user').map((g) => g.id))).map((u) => [u.id, u]));
    const out: object[] = [];
    for (const g of grants) {
      if (g.type === 'user') {
        const u = people.get(g.id);
        if (u) out.push({ ...g, name: u.name, sub: u.username, active: u.active });
      } else {
        const d = await org.get(g.id);
        if (d) out.push({ ...g, name: d.name, sub: await org.pathName(d.id) });
      }
    }
    return out;
  }

  async function folderPath(folderId: string | null): Promise<{ id: string; name: string }[]> {
    return (await folders.chain(folderId)).reverse().map((f) => ({ id: f.id, name: f.name }));
  }

  async function docView(meta: DocMeta, role: Role): Promise<object> {
    const owner = await users.get(meta.owner);
    const folder = await folders.get(meta.folderId);
    return {
      ...meta,
      role,
      ownerUser: owner ? await personView(owner) : null,
      shares: await grantsView(meta.shares),
      folder: folder ? { id: folder.id, name: folder.name } : null,
      path: await folderPath(meta.folderId),
    };
  }

  async function folderView(f: Folder, role: Role, docCount: number): Promise<object> {
    const owner = await users.get(f.owner);
    const chain = await folders.chain(f.id);
    return {
      id: f.id,
      name: f.name,
      parentId: f.parentId,
      depth: chain.length,
      canAddChild: chain.length < MAX_FOLDER_DEPTH && atLeast(role, 'edit'),
      owner: f.owner,
      role,
      ownerUser: owner ? await personView(owner) : null,
      grants: await grantsView(f.grants),
      path: chain.reverse().map((x) => ({ id: x.id, name: x.name })),
      docCount,
      createdAt: f.createdAt,
    };
  }

  /** 경로의 문서를 읽고 권한을 확인한다. 권한이 없으면 문서가 없는 것처럼 답한다. */
  async function docFor(req: Request, res: Response, need: Role = 'view'): Promise<{ meta: DocMeta; role: Role } | null> {
    const id = String(req.params.id);
    const meta = Store.isId(id) ? await store.meta(id) : null;
    const role = meta ? await access.docRole(meta, await whoOf(req)) : null;
    if (!meta || !role) {
      notFound(res);
      return null;
    }
    if (!atLeast(role, need)) {
      res.status(403).json({ error: need === 'owner' ? '문서를 올린 사람만 할 수 있습니다.' : '편집 권한이 없습니다.' });
      return null;
    }
    return { meta, role };
  }

  /** 경로의 폴더를 읽고 권한을 확인한다. */
  async function folderFor(req: Request, res: Response, need: Role = 'view'): Promise<{ folder: Folder; role: Role } | null> {
    const folder = await folders.get(String(req.params.fid));
    const role = folder ? await access.folderRole(folder.id, await whoOf(req)) : null;
    if (!folder || !role) {
      notFound(res, '폴더를');
      return null;
    }
    if (!atLeast(role, need)) {
      res.status(403).json({ error: need === 'owner' ? '폴더를 만든 사람(또는 상위 폴더를 만든 사람)만 할 수 있습니다.' : '이 폴더의 편집 권한이 없습니다.' });
      return null;
    }
    return { folder, role };
  }

  // ── 사람·부서 찾기 (권한 줄 때) ──
  api.get('/people', asyncRoute(async (req, res) => {
    const q = String(req.query.q ?? '').slice(0, 50);
    const found = (await users.search(q)).filter((u) => u.id !== me(req).id);
    const depts = await org.search(q);
    res.json({
      users: await Promise.all(found.map(personView)),
      depts: await Promise.all(depts.map(async (d) => ({ id: d.id, name: d.name, path: await org.pathName(d.id) }))),
    });
  }));

  // ── 문서 ──

  // 문서 목록. ?folder=<폴더 id> 면 그 폴더만, ?folder=none 이면 폴더에 넣지 않은 것만.
  api.get('/docs', asyncRoute(async (req, res) => {
    const who = await whoOf(req);
    const filter = typeof req.query.folder === 'string' ? req.query.folder : '';
    const out: object[] = [];
    for (const m of await store.list()) {
      if (filter === 'none' && m.folderId && (await access.folderRole(m.folderId, who))) continue;
      if (filter && filter !== 'none' && m.folderId !== filter) continue;
      const role = await access.docRole(m, who);
      if (role) out.push(await docView(m, role));
    }
    res.json(out);
  }));

  // 문서 만들기: 본문에 파일 바이트를 실어 보내면 그 문서로, 비어 있으면 ?kind= 의 빈 문서로 시작한다.
  api.post('/docs', express.raw({ type: () => true, limit: '100mb' }), asyncRoute(async (req, res) => {
    const filename = String(req.query.filename || '').slice(0, 200);
    let folderId: string | null = null;
    if (req.query.folder) {
      const f = await folders.get(String(req.query.folder));
      const role = f ? await access.folderRole(f.id, await whoOf(req)) : null;
      if (!f || !role) return notFound(res, '폴더를');
      if (!atLeast(role, 'edit')) {
        res.status(403).json({ error: '이 폴더에 문서를 올릴 권한이 없습니다(보기 권한).' });
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
    const meta = await store.create({ kind, title, filename, owner: me(req).id, folderId, base, ydocUpdate: Y.encodeStateAsUpdate(ydoc), model });
    if (model) models.set(meta.id, model);
    res.status(201).json(await docView(meta, 'owner'));
  }));

  api.get('/docs/:id', asyncRoute(async (req, res) => {
    const d = await docFor(req, res);
    if (!d) return;
    res.json({ ...(await docView(d.meta, d.role)), versions: await store.versions(d.meta.id) });
  }));

  api.patch('/docs/:id', express.json(), asyncRoute(async (req, res) => {
    const d = await docFor(req, res, 'owner');
    if (!d) return;
    const body = req.body as { title?: unknown } | undefined;
    const title = String(body?.title || '').trim().slice(0, 200);
    if (!title) {
      res.status(400).json({ error: '제목이 비어 있습니다.' });
      return;
    }
    const updated = await store.updateMeta(d.meta.id, { title });
    res.json(await docView(updated!, d.role));
  }));

  // 문서 권한: 올린 사람이 사람·부서별 편집/보기 권한 목록을 통째로 정한다.
  api.put('/docs/:id/shares', express.json(), asyncRoute(async (req, res) => {
    const d = await docFor(req, res, 'owner');
    if (!d) return;
    const shares = await access.cleanGrants((req.body as { grants?: unknown } | undefined)?.grants, [d.meta.owner]);
    const updated = await store.updateMeta(d.meta.id, { shares });
    await recheck();
    res.json(await docView(updated!, d.role));
  }));

  // 문서를 폴더에 넣거나 꺼낸다. 문서를 올린 사람이, 편집 권한이 있는 폴더로만 옮길 수 있다.
  api.put('/docs/:id/folder', express.json(), asyncRoute(async (req, res) => {
    const d = await docFor(req, res, 'owner');
    if (!d) return;
    const body = req.body as { folderId?: unknown } | undefined;
    let folderId: string | null = null;
    if (body?.folderId) {
      const f = await folders.get(String(body.folderId));
      const role = f ? await access.folderRole(f.id, await whoOf(req)) : null;
      if (!f || !role) return notFound(res, '폴더를');
      if (!atLeast(role, 'edit')) {
        res.status(403).json({ error: '이 폴더에 문서를 넣을 권한이 없습니다(보기 권한).' });
        return;
      }
      folderId = f.id;
    }
    const updated = await store.updateMeta(d.meta.id, { folderId });
    await recheck();
    res.json(await docView(updated!, d.role));
  }));

  api.delete('/docs/:id', asyncRoute(async (req, res) => {
    const d = await docFor(req, res, 'owner');
    if (!d) return;
    for (const conn of hocuspocus.documents.get(d.meta.id)?.getConnections() ?? []) conn.close({ code: 4403, reason: 'Forbidden' });
    models.delete(d.meta.id);
    await store.remove(d.meta.id);
    res.status(204).end();
  }));

  api.get('/docs/:id/base', asyncRoute(async (req, res) => {
    const d = await docFor(req, res);
    if (!d) return;
    const bytes = await store.base(d.meta.id);
    if (!bytes) return notFound(res);
    res.set('Cache-Control', 'private, max-age=31536000, immutable');
    res.type('application/octet-stream').send(Buffer.from(bytes));
  }));

  api.get('/docs/:id/model', asyncRoute(async (req, res) => {
    const d = await docFor(req, res);
    if (!d) return;
    const json = d.meta.kind === 'xlsx' ? await store.modelJson(d.meta.id) : null;
    if (!json) return notFound(res, 'XLSX 정보를');
    res.set('Cache-Control', 'private, max-age=31536000, immutable');
    res.type('application/json').send(json);
  }));

  const sendFile = (res: Response, kind: DocKind, title: string, bytes: Uint8Array): void => {
    res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(title)}.${kind}`);
    res.set('Cache-Control', 'no-store');
    res.type(MIME[kind]).send(Buffer.from(bytes));
  };

  // 지금 상태를 파일로 내려받는다 (보기 권한도 가능).
  api.get('/docs/:id/export', asyncRoute(async (req, res) => {
    const d = await docFor(req, res);
    if (!d) return;
    let ydoc: Y.Doc | undefined = hocuspocus.documents.get(d.meta.id);
    if (!ydoc) {
      const update = await store.ydoc(d.meta.id);
      if (!update) return notFound(res);
      ydoc = new Y.Doc();
      Y.applyUpdate(ydoc, update);
    }
    const bytes = await persist(d.meta.id, ydoc);
    if (!bytes) {
      res.status(500).json({ error: '파일을 만들지 못했습니다.' });
      return;
    }
    sendFile(res, d.meta.kind, d.meta.title, bytes);
  }));

  api.get('/docs/:id/versions/:name', asyncRoute(async (req, res) => {
    const d = await docFor(req, res);
    if (!d) return;
    const name = String(req.params.name);
    const bytes = await store.version(d.meta.id, name);
    if (!bytes) return notFound(res, '저장본을');
    sendFile(res, d.meta.kind, `${d.meta.title} ${name.replace(/\.(hwpx|xlsx)$/, '')}`, bytes);
  }));

  // ── 업무 폴더 (최대 3단계) ──

  // 내가 볼 수 있는 모든 폴더 (위 폴더 권한을 받으면 아래 폴더도 보인다)
  api.get('/folders', asyncRoute(async (req, res) => {
    const who = await whoOf(req);
    const docs = await store.list();
    const out: object[] = [];
    for (const f of await folders.all()) {
      const role = await access.folderRole(f.id, who);
      if (role) out.push(await folderView(f, role, docs.filter((d) => d.folderId === f.id).length));
    }
    res.json(out);
  }));

  api.post('/folders', express.json(), asyncRoute(async (req, res) => {
    const body = req.body as { name?: unknown; parentId?: unknown } | undefined;
    let parentId: string | null = null;
    if (body?.parentId) {
      const p = await folders.get(String(body.parentId));
      const role = p ? await access.folderRole(p.id, await whoOf(req)) : null;
      if (!p || !role) return notFound(res, '상위 폴더를');
      if (!atLeast(role, 'edit')) {
        res.status(403).json({ error: '이 폴더 안에 폴더를 만들 권한이 없습니다(보기 권한).' });
        return;
      }
      parentId = p.id;
    }
    const f = await folders.create(String(body?.name ?? ''), me(req).id, parentId);
    res.status(201).json(await folderView(f, 'owner', 0));
  }));

  const docCount = async (fid: string): Promise<number> => (await store.list()).filter((d) => d.folderId === fid).length;

  api.get('/folders/:fid', asyncRoute(async (req, res) => {
    const f = await folderFor(req, res);
    if (!f) return;
    res.json(await folderView(f.folder, f.role, await docCount(f.folder.id)));
  }));

  api.patch('/folders/:fid', express.json(), asyncRoute(async (req, res) => {
    const f = await folderFor(req, res, 'owner');
    if (!f) return;
    const body = req.body as { name?: unknown } | undefined;
    const updated = await folders.update(f.folder.id, { name: String(body?.name ?? '') });
    res.json(await folderView(updated, f.role, await docCount(f.folder.id)));
  }));

  // 폴더 권한: 사람·부서별 편집/보기 권한 목록을 통째로 정한다. 아래 폴더와 문서에도 그대로 간다.
  api.put('/folders/:fid/grants', express.json(), asyncRoute(async (req, res) => {
    const f = await folderFor(req, res, 'owner');
    if (!f) return;
    const grants = await access.cleanGrants((req.body as { grants?: unknown } | undefined)?.grants, [f.folder.owner]);
    const updated = await folders.update(f.folder.id, { grants });
    await recheck();
    res.json(await folderView(updated, f.role, await docCount(f.folder.id)));
  }));

  // 폴더 지우기: 하위 폴더도 함께 지우고, 안의 문서는 지운 폴더의 상위 폴더(맨 위면 폴더 밖)로 옮긴다.
  api.delete('/folders/:fid', asyncRoute(async (req, res) => {
    const f = await folderFor(req, res, 'owner');
    if (!f) return;
    const gone = await folders.removeTree(f.folder.id);
    for (const m of await store.list()) {
      if (m.folderId && gone.has(m.folderId)) await store.updateMeta(m.id, { folderId: f.folder.parentId });
    }
    await recheck();
    res.status(204).end();
  }));

  // ── 조직도 (누구나 볼 수 있음, 고치기는 관리자) ──
  api.get('/org', asyncRoute(async (req, res) => {
    res.json(await org.list());
  }));

  api.use('/admin', adminRouter({ users, org, folders, store, recheck }));

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

    // 로그인 쿠키로 사람을 확인하고 그 문서의 권한을 본다. 보기 권한이면 읽기 전용으로 연다.
    async onAuthenticate({ documentName, requestHeaders, connectionConfig }): Promise<ConnContext> {
      if (!sameOrigin(requestHeaders.get('origin'), requestHeaders.get('host'))) throw new Error('Forbidden');
      const user = await users.userForToken(parseCookies(requestHeaders.get('cookie'))[COOKIE]);
      const meta = user && Store.isId(documentName) ? await store.meta(documentName) : null;
      const role = user && meta ? await access.docRole(meta, await access.who(user)) : null;
      if (!user || !role) throw new Error('Forbidden');
      const readOnly = role === 'view';
      connectionConfig.readOnly = readOnly;
      return { userId: user.id, readOnly };
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
    org,
    access,
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
    console.log('아직 계정이 없습니다. 화면에서 가입하면 첫 계정이 관리자가 됩니다. 또는 `node scripts/users.ts add <아이디> <이름> <암호> --admin`');
  }
  const stop = async (): Promise<void> => {
    await srv.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
