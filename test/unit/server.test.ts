import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { createServer } from '../../server/index.ts';
import { WebDav } from '../../server/webdav.ts';
import type { DocMeta } from '../../server/store.ts';
import { sampleHwpx, list, textAt } from './helpers.ts';
import { openDocument } from '../../src/shared/rhwp-node.ts';
import { getLists } from '../../src/shared/model.ts';
import * as ops from '../../src/shared/ops.ts';

const quiet = { warn() {}, error() {}, log() {} };

interface Client {
  ydoc: Y.Doc;
  provider: HocuspocusProvider;
  synced: Promise<void>;
}

function connect(port: number, id: string): Client {
  const ydoc = new Y.Doc();
  const provider = new HocuspocusProvider({ url: `ws://127.0.0.1:${port}/collab`, name: id, document: ydoc });
  const synced = new Promise<void>((resolve) => provider.on('synced', () => resolve()));
  return { ydoc, provider, synced };
}

const until = async (fn: () => boolean | Promise<boolean>, ms = 5000): Promise<void> => {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error('시간 초과');
    await new Promise((r) => setTimeout(r, 30));
  }
};

type DocInfo = DocMeta & { versions: string[] };

test('올리기 → 두 사람이 동시편집 → HWPX 저장·내보내기·WebDAV', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hwpx-coedit-'));

  // 가짜 WebDAV 서버
  const puts: { method?: string; url: string; auth?: string; size: number }[] = [];
  const dav = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      puts.push({
        method: req.method,
        url: decodeURIComponent(req.url ?? ''),
        auth: req.headers.authorization,
        size: Buffer.concat(chunks).length,
      });
      res.writeHead(201).end();
    });
  });
  await new Promise<void>((r) => dav.listen(0, '127.0.0.1', r));
  const webdav = new WebDav(`http://127.0.0.1:${(dav.address() as AddressInfo).port}/dav/공동편집/`, 'bot', 'pw');

  const srv = await createServer({ dataDir, webdav, debounce: 50, maxDebounce: 200, log: quiet, webDir: '/nonexistent' });
  const port = await srv.listen(0, '127.0.0.1');
  const api = `http://127.0.0.1:${port}/api`;
  const info = async (id: string): Promise<DocInfo> => (await (await fetch(`${api}/docs/${id}`)).json()) as DocInfo;

  try {
    // 잘못된 파일은 거절
    const bad = await fetch(`${api}/docs?filename=x.hwpx`, { method: 'POST', body: new Uint8Array([1, 2, 3, 4]) });
    assert.equal(bad.status, 400);

    const created = await fetch(`${api}/docs?filename=${encodeURIComponent('시험 서식.hwpx')}`, {
      method: 'POST',
      body: sampleHwpx(),
    });
    assert.equal(created.status, 201);
    const meta = (await created.json()) as DocMeta;
    assert.equal(meta.title, '시험 서식');
    const all = (await (await fetch(`${api}/docs`)).json()) as DocMeta[];
    assert.deepEqual(all.map((d) => d.id), [meta.id]);
    assert.equal((await fetch(`${api}/docs/zzzzzzzzzzzz`)).status, 404);
    assert.equal((await fetch(`${api}/docs/..%2F..%2Fetc`)).status, 404);

    const a = connect(port, meta.id);
    const b = connect(port, meta.id);
    await Promise.all([a.synced, b.synced]);
    const bodyA = list(getLists(a.ydoc), 's0');
    const bodyB = list(getLists(b.ydoc), 's0');
    assert.equal(textAt(bodyB, 0), '동시편집 시험 문서');

    a.ydoc.transact(() => ops.insertText(bodyA, 0, 0, '[가] '), ops.LOCAL);
    b.ydoc.transact(() => ops.insertText(bodyB, 1, 0, '[나] '), ops.LOCAL);
    await until(() => textAt(bodyA, 1).startsWith('[나] ') && textAt(bodyB, 0).startsWith('[가] '));

    // 편집이 멈추면 자동 저장된다.
    await until(async () => (await info(meta.id)).save?.ok === true);
    const saved = await info(meta.id);
    assert.equal(saved.save?.diffs, 0);
    assert.equal(saved.versions.length, 1);
    await until(() => puts.length > 0);
    const put = puts[0]!;
    assert.equal(put.method, 'PUT');
    assert.equal(put.url, `/dav/공동편집/시험 서식 (${meta.id}).hwpx`);
    assert.ok(put.auth?.startsWith('Basic '));

    // 내보낸 파일을 다시 열어 확인
    const res = await fetch(`${api}/docs/${meta.id}/export`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition') ?? '', /filename\*=UTF-8''/);
    const doc = openDocument(new Uint8Array(await res.arrayBuffer()));
    assert.equal(doc.getTextRange(0, 0, 0, 100), '[가] 동시편집 시험 문서');
    assert.equal(doc.getTextRange(0, 1, 0, 100), '[나] 둘째 문단입니다.');
    doc.free();

    // 없는 문서에는 접속할 수 없다.
    const ghost = connect(port, 'aaaaaaaaaaaa');
    let ghostSynced = false;
    void ghost.synced.then(() => (ghostSynced = true));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(ghostSynced, false);
    ghost.provider.destroy();

    a.provider.destroy();
    b.provider.destroy();

    // 모두 나간 뒤 다시 들어와도 내용이 남아 있다.
    await until(() => srv.server.hocuspocus.getDocumentsCount() === 0);
    const c = connect(port, meta.id);
    await c.synced;
    assert.equal(textAt(list(getLists(c.ydoc), 's0'), 0), '[가] 동시편집 시험 문서');
    c.provider.destroy();

    assert.equal((await fetch(`${api}/docs/${meta.id}`, { method: 'DELETE' })).status, 204);
    assert.equal((await fetch(`${api}/docs/${meta.id}`)).status, 404);
  } finally {
    await srv.close();
    await new Promise((r) => dav.close(r));
    await rm(dataDir, { recursive: true, force: true });
  }
});
