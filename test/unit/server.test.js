import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { createServer } from '../../server/index.js';
import { WebDav } from '../../server/webdav.js';
import { sampleHwpx } from './helpers.js';
import { openDocument } from '../../src/shared/rhwp-node.js';
import { getLists } from '../../src/shared/model.js';
import * as ops from '../../src/shared/ops.js';

const quiet = { warn() {}, error() {}, log() {} };

function connect(port, id) {
  const ydoc = new Y.Doc();
  const provider = new HocuspocusProvider({ url: `ws://127.0.0.1:${port}/collab`, name: id, document: ydoc });
  const synced = new Promise((resolve) => provider.on('synced', resolve));
  return { ydoc, provider, synced };
}

const until = async (fn, ms = 5000) => {
  const t0 = Date.now();
  while (!(await fn())) {
    if (Date.now() - t0 > ms) throw new Error('시간 초과');
    await new Promise((r) => setTimeout(r, 30));
  }
};

test('올리기 → 두 사람이 동시편집 → HWPX 저장·내보내기·WebDAV', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hwpx-coedit-'));

  // 가짜 WebDAV 서버
  const puts = [];
  const dav = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      puts.push({ method: req.method, url: decodeURIComponent(req.url), auth: req.headers.authorization, size: Buffer.concat(chunks).length });
      res.writeHead(201).end();
    });
  });
  await new Promise((r) => dav.listen(0, '127.0.0.1', r));
  const webdav = new WebDav(`http://127.0.0.1:${dav.address().port}/dav/공동편집/`, 'bot', 'pw');

  const srv = await createServer({ dataDir, webdav, debounce: 50, maxDebounce: 200, log: quiet, webDir: '/nonexistent' });
  const port = await srv.listen(0, '127.0.0.1');
  const api = `http://127.0.0.1:${port}/api`;

  try {
    // 잘못된 파일은 거절
    const bad = await fetch(`${api}/docs?filename=x.hwpx`, { method: 'POST', body: new Uint8Array([1, 2, 3, 4]) });
    assert.equal(bad.status, 400);

    const created = await fetch(`${api}/docs?filename=${encodeURIComponent('시험 서식.hwpx')}`, {
      method: 'POST',
      body: sampleHwpx(),
    });
    assert.equal(created.status, 201);
    const meta = await created.json();
    assert.equal(meta.title, '시험 서식');
    assert.deepEqual((await (await fetch(`${api}/docs`)).json()).map((d) => d.id), [meta.id]);
    assert.equal((await fetch(`${api}/docs/zzzzzzzzzzzz`)).status, 404);
    assert.equal((await fetch(`${api}/docs/..%2F..%2Fetc`)).status, 404);

    const a = connect(port, meta.id);
    const b = connect(port, meta.id);
    await Promise.all([a.synced, b.synced]);
    const bodyA = getLists(a.ydoc).get('s0');
    const bodyB = getLists(b.ydoc).get('s0');
    assert.equal(bodyB.get(0).get('t').toString(), '동시편집 시험 문서');

    a.ydoc.transact(() => ops.insertText(bodyA, 0, 0, '[가] '), ops.LOCAL);
    b.ydoc.transact(() => ops.insertText(bodyB, 1, 0, '[나] '), ops.LOCAL);
    await until(() => bodyA.get(1).get('t').toString().startsWith('[나] ') && bodyB.get(0).get('t').toString().startsWith('[가] '));

    // 편집이 멈추면 자동 저장된다.
    await until(async () => (await (await fetch(`${api}/docs/${meta.id}`)).json()).save?.ok === true);
    const info = await (await fetch(`${api}/docs/${meta.id}`)).json();
    assert.equal(info.save.diffs, 0);
    assert.equal(info.versions.length, 1);
    await until(() => puts.length > 0);
    assert.equal(puts[0].method, 'PUT');
    assert.equal(puts[0].url, `/dav/공동편집/시험 서식 (${meta.id}).hwpx`);
    assert.ok(puts[0].auth.startsWith('Basic '));

    // 내보낸 파일을 다시 열어 확인
    const res = await fetch(`${api}/docs/${meta.id}/export`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition'), /filename\*=UTF-8''/);
    const doc = openDocument(new Uint8Array(await res.arrayBuffer()));
    assert.equal(doc.getTextRange(0, 0, 0, 100), '[가] 동시편집 시험 문서');
    assert.equal(doc.getTextRange(0, 1, 0, 100), '[나] 둘째 문단입니다.');
    doc.free();

    // 없는 문서에는 접속할 수 없다.
    const ghost = connect(port, 'aaaaaaaaaaaa');
    let ghostSynced = false;
    ghost.synced.then(() => (ghostSynced = true));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(ghostSynced, false);
    ghost.provider.destroy();

    a.provider.destroy();
    b.provider.destroy();

    // 모두 나간 뒤 다시 들어와도 내용이 남아 있다.
    await until(() => srv.server.hocuspocus.getDocumentsCount() === 0);
    const c = connect(port, meta.id);
    await c.synced;
    assert.equal(getLists(c.ydoc).get('s0').get(0).get('t').toString(), '[가] 동시편집 시험 문서');
    c.provider.destroy();

    assert.equal((await fetch(`${api}/docs/${meta.id}`, { method: 'DELETE' })).status, 204);
    assert.equal((await fetch(`${api}/docs/${meta.id}`)).status, 404);
  } finally {
    await srv.close();
    await new Promise((r) => dav.close(r));
    await rm(dataDir, { recursive: true, force: true });
  }
});
