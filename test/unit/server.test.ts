import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebDav } from '../../server/webdav.ts';
import type { DocMeta } from '../../server/store.ts';
import { sampleHwpx, list, textAt } from './helpers.ts';
import { sampleXlsx, readWithExcelJS } from './xlsx-sample.ts';
import { startServer, Agent, until, timeout } from './server-helpers.ts';
import { openDocument } from '../../src/shared/rhwp-node.ts';
import { getLists } from '../../src/shared/model.ts';
import { getCells } from '../../src/shared/xlsx/sheetdoc.ts';
import { parseXlsx } from '../../src/shared/xlsx/parse.ts';
import { cellKey } from '../../src/shared/xlsx/types.ts';
import type { WorkbookModel } from '../../src/shared/xlsx/types.ts';
import * as ops from '../../src/shared/ops.ts';

type DocInfo = DocMeta & { versions: string[]; role: string; editorUsers: { id: string; name: string }[] };

const upload = async (a: Agent, name: string, bytes: Uint8Array): Promise<Response> =>
  a.fetch(`/api/docs?filename=${encodeURIComponent(name)}`, { method: 'POST', body: Buffer.from(bytes) });

test('로그인: 가입·로그인·로그아웃, 잘못된 요청 막기', async () => {
  const t = await startServer();
  try {
    const anon = new Agent(t.origin);
    assert.equal((await anon.fetch('/api/docs')).status, 401, '로그인하지 않으면 문서를 볼 수 없다');
    const me = await anon.fetch('/api/auth/me');
    assert.equal(me.status, 401);
    assert.equal(((await me.json()) as { signup: boolean }).signup, true);

    const bad = await anon.json('/api/auth/signup', 'POST', { username: 'A B', name: '가', password: 'password1234' });
    assert.equal(bad.status, 400);
    const short = await anon.json('/api/auth/signup', 'POST', { username: 'kim', name: '김', password: 'short' });
    assert.equal(short.status, 400);

    const kim = await new Agent(t.origin).signup('kim', '김가람');
    assert.ok(kim.cookie.startsWith('hwpx_sid='));
    assert.equal((await new Agent(t.origin).json('/api/auth/signup', 'POST', { username: 'kim', name: '또', password: 'password1234' })).status, 409);

    const again = new Agent(t.origin);
    assert.equal((await again.json('/api/auth/login', 'POST', { username: 'kim', password: 'wrong-password' })).status, 401);
    assert.equal((await again.json('/api/auth/login', 'POST', { username: 'KIM', password: 'password1234' })).status, 200);
    const who = (await (await again.fetch('/api/auth/me')).json()) as { user: { name: string } };
    assert.equal(who.user.name, '김가람');

    // 다른 사이트에서 보낸 요청은 거절
    const cross = await fetch(`${t.origin}/api/docs?kind=xlsx`, { method: 'POST', headers: { cookie: again.cookie, origin: 'https://evil.example' } });
    assert.equal(cross.status, 403);

    assert.equal((await again.fetch('/api/auth/logout', { method: 'POST' })).status, 204);
    again.cookie = again.cookie.replace(/=.*/, '=');
    assert.equal((await again.fetch('/api/docs')).status, 401);

    // 같은 아이디로 계속 틀리면 잠시 막는다.
    const brute = new Agent(t.origin);
    for (let i = 0; i < 10; i++) await brute.json('/api/auth/login', 'POST', { username: 'kim', password: `x${i}xxxxxxx` });
    assert.equal((await brute.json('/api/auth/login', 'POST', { username: 'kim', password: 'password1234' })).status, 429);
  } finally {
    await t.close();
  }

  const closed = await startServer({ signup: false });
  try {
    const r = await new Agent(closed.origin).json('/api/auth/signup', 'POST', { username: 'lee', name: '이', password: 'password1234' });
    assert.equal(r.status, 403);
    await closed.srv.users.create('lee', '이나래', 'password1234');
    assert.equal((await new Agent(closed.origin).json('/api/auth/login', 'POST', { username: 'lee', password: 'password1234' })).status, 200);
  } finally {
    await closed.close();
  }
});

test('편집 권한: 올린 사람이 지정한 사람만 열고 고칠 수 있다', async () => {
  const t = await startServer();
  try {
    const owner = await new Agent(t.origin).signup('owner', '박소유');
    const bob = await new Agent(t.origin).signup('bob', '최편집');
    const carol = await new Agent(t.origin).signup('carol', '정제삼');

    const created = await upload(owner, '예산.xlsx', await sampleXlsx());
    assert.equal(created.status, 201);
    const doc = (await created.json()) as DocInfo;
    assert.equal(doc.kind, 'xlsx');
    assert.equal(doc.role, 'owner');

    // 권한이 없는 사람에게는 문서가 없는 것처럼 보인다.
    assert.equal((await bob.fetch(`/api/docs/${doc.id}`)).status, 404);
    assert.equal((await bob.fetch(`/api/docs/${doc.id}/export`)).status, 404);
    assert.deepEqual(await (await bob.fetch('/api/docs')).json(), []);
    const early = bob.connect(t.port, doc.id);
    assert.equal(await timeout(early.result, 3000, 'timeout' as const), 'denied', '실시간 접속도 막힌다');
    early.destroy();

    // 사람 찾기 → 편집 권한 주기
    const found = (await (await owner.fetch('/api/users?q=편집')).json()) as { id: string; username: string }[];
    assert.deepEqual(found.map((u) => u.username), ['bob']);
    const share = await owner.json(`/api/docs/${doc.id}/editors`, 'PUT', { userIds: [bob.id, 'u-없는사람', owner.id] });
    assert.equal(share.status, 200);
    assert.deepEqual(((await share.json()) as DocInfo).editorUsers.map((u) => u.name), ['최편집']);

    const seen = (await (await bob.fetch('/api/docs')).json()) as DocInfo[];
    assert.deepEqual(seen.map((d) => [d.id, d.role]), [[doc.id, 'editor']]);
    assert.equal((await carol.fetch(`/api/docs/${doc.id}`)).status, 404);

    // 편집자는 고칠 수 있지만 권한을 주거나 지우거나 이름을 바꿀 수는 없다.
    assert.equal((await bob.json(`/api/docs/${doc.id}/editors`, 'PUT', { userIds: [carol.id] })).status, 403);
    assert.equal((await bob.fetch(`/api/docs/${doc.id}`, { method: 'DELETE' })).status, 403);
    assert.equal((await bob.json(`/api/docs/${doc.id}`, 'PATCH', { title: '바꿈' })).status, 403);

    const a = owner.connect(t.port, doc.id);
    const b = bob.connect(t.port, doc.id);
    assert.deepEqual(await Promise.all([a.result, b.result]), ['synced', 'synced']);
    getCells(b.ydoc).set(cellKey(0, 'B3'), { t: 'n', v: 1500000 });
    await until(() => (getCells(a.ydoc).get(cellKey(0, 'B3')) as { v?: number } | undefined)?.v === 1500000);

    // 권한을 거두면 바로 끊기고 다시 들어올 수 없다.
    await owner.json(`/api/docs/${doc.id}/editors`, 'PUT', { userIds: [] });
    await until(() => b.denied, 3000);
    const retry = bob.connect(t.port, doc.id);
    assert.equal(await timeout(retry.result, 3000, 'timeout' as const), 'denied');
    // 끊긴 뒤 보낸 편집은 다른 사람에게 가지 않는다.
    getCells(b.ydoc).set(cellKey(0, 'B4'), { t: 'n', v: 1 });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(getCells(a.ydoc).get(cellKey(0, 'B4')), undefined);
    retry.destroy();
    b.destroy();
    assert.equal((await bob.fetch(`/api/docs/${doc.id}`)).status, 404);
    a.destroy();
  } finally {
    await t.close();
  }
});

test('HWPX: 올리기 → 두 사람이 동시편집 → 저장·내보내기·WebDAV', async () => {
  const puts: { method?: string; url: string; auth?: string }[] = [];
  const dav = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      puts.push({ method: req.method, url: decodeURIComponent(req.url ?? ''), auth: req.headers.authorization });
      res.writeHead(201).end();
    });
  });
  await new Promise<void>((r) => dav.listen(0, '127.0.0.1', r));
  const webdav = new WebDav(`http://127.0.0.1:${(dav.address() as AddressInfo).port}/dav/공동편집/`, 'bot', 'pw');
  const t = await startServer({ webdav });
  try {
    const kim = await new Agent(t.origin).signup('kim', '김가람');
    const lee = await new Agent(t.origin).signup('lee', '이나래');
    assert.equal((await upload(kim, 'x.hwpx', new Uint8Array([1, 2, 3, 4]))).status, 400);
    assert.equal((await upload(kim, '옛날.xls', new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]))).status, 400);

    const meta = (await (await upload(kim, '시험 서식.hwpx', sampleHwpx())).json()) as DocInfo;
    assert.equal(meta.title, '시험 서식');
    assert.equal(meta.kind, 'hwpx');
    await kim.json(`/api/docs/${meta.id}/editors`, 'PUT', { userIds: [lee.id] });

    const a = kim.connect(t.port, meta.id);
    const b = lee.connect(t.port, meta.id);
    assert.deepEqual(await Promise.all([a.result, b.result]), ['synced', 'synced']);
    const bodyA = list(getLists(a.ydoc), 's0');
    const bodyB = list(getLists(b.ydoc), 's0');
    assert.equal(textAt(bodyB, 0), '동시편집 시험 문서');
    a.ydoc.transact(() => ops.insertText(bodyA, 0, 0, '[가] '), ops.LOCAL);
    b.ydoc.transact(() => ops.insertText(bodyB, 1, 0, '[나] '), ops.LOCAL);
    await until(() => textAt(bodyA, 1).startsWith('[나] ') && textAt(bodyB, 0).startsWith('[가] '));

    const info = async (): Promise<DocInfo> => (await (await kim.fetch(`/api/docs/${meta.id}`)).json()) as DocInfo;
    await until(async () => (await info()).save?.ok === true);
    assert.equal((await info()).save?.diffs, 0);
    assert.equal((await info()).versions.length, 1);
    await until(() => puts.length > 0);
    assert.equal(puts[0]!.url, `/dav/공동편집/시험 서식 (${meta.id}).hwpx`);
    assert.ok(puts[0]!.auth?.startsWith('Basic '));

    const res = await lee.fetch(`/api/docs/${meta.id}/export`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition') ?? '', /\.hwpx$/);
    const doc = openDocument(new Uint8Array(await res.arrayBuffer()));
    assert.equal(doc.getTextRange(0, 0, 0, 100), '[가] 동시편집 시험 문서');
    assert.equal(doc.getTextRange(0, 1, 0, 100), '[나] 둘째 문단입니다.');
    doc.free();

    a.destroy();
    b.destroy();
    await until(() => t.srv.server.hocuspocus.getDocumentsCount() === 0);
    const c = kim.connect(t.port, meta.id);
    assert.equal(await c.result, 'synced');
    assert.equal(textAt(list(getLists(c.ydoc), 's0'), 0), '[가] 동시편집 시험 문서', '모두 나갔다 들어와도 남아 있다');
    c.destroy();

    assert.equal((await kim.fetch(`/api/docs/${meta.id}`, { method: 'DELETE' })).status, 204);
    assert.equal((await kim.fetch(`/api/docs/${meta.id}`)).status, 404);
  } finally {
    await t.close();
    await new Promise((r) => dav.close(r));
  }
});

test('XLSX: 올리기 → 두 사람이 셀을 고침 → 저장된 파일에 반영', async () => {
  const t = await startServer();
  try {
    const kim = await new Agent(t.origin).signup('kim', '김가람');
    const lee = await new Agent(t.origin).signup('lee', '이나래');
    const meta = (await (await upload(kim, '예산.xlsx', await sampleXlsx())).json()) as DocInfo;
    await kim.json(`/api/docs/${meta.id}/editors`, 'PUT', { userIds: [lee.id] });

    const model = (await (await lee.fetch(`/api/docs/${meta.id}/model`)).json()) as WorkbookModel;
    assert.deepEqual(model.sheets.map((s) => s.name), ['예산', '요약']);

    const a = kim.connect(t.port, meta.id);
    const b = lee.connect(t.port, meta.id);
    await Promise.all([a.result, b.result]);
    getCells(a.ydoc).set(cellKey(0, 'B5'), { t: 'n', v: 3100000 });
    getCells(b.ydoc).set(cellKey(0, 'A6'), { t: 's', v: '총 합계' });
    getCells(b.ydoc).set(cellKey(1, 'A3'), { t: 'f', f: "'예산'!D5*2" });
    getCells(b.ydoc).set('엉뚱한열쇠', { t: 'n', v: 1 } as never);
    getCells(b.ydoc).set(cellKey(0, 'C9'), { t: 'n', v: 'NaN' } as never);
    await until(() => getCells(a.ydoc).size === 5 && getCells(b.ydoc).size === 5);

    const info = async (): Promise<DocInfo> => (await (await kim.fetch(`/api/docs/${meta.id}`)).json()) as DocInfo;
    await until(async () => (await info()).save?.ok === true);

    const res = await kim.fetch(`/api/docs/${meta.id}/export`);
    assert.match(res.headers.get('content-type') ?? '', /spreadsheetml/);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const saved = parseXlsx(bytes);
    assert.equal(saved.sheets[0]!.cells.B5?.v, 3100000);
    assert.equal(saved.sheets[0]!.cells.A6?.v, '총 합계');
    assert.equal(saved.sheets[0]!.cells.D6?.v, 9250000, '수식 결과도 새 값으로');
    assert.equal(saved.sheets[1]!.cells.A3?.f, "'예산'!D5*2");
    assert.equal(saved.sheets[1]!.cells.A3?.v, 10000000);
    assert.equal(saved.sheets[0]!.cells.C9, undefined, '잘못된 값은 저장하지 않는다');
    const wb = await readWithExcelJS(bytes);
    assert.equal(wb.getWorksheet('예산')!.getCell('A6').value, '총 합계');

    // 빈 통합 문서로 시작
    const blank = await kim.fetch('/api/docs?kind=xlsx', { method: 'POST' });
    const blankMeta = (await blank.json()) as DocInfo;
    assert.equal(blankMeta.kind, 'xlsx');
    assert.equal(blankMeta.title, '새 통합 문서');
    a.destroy();
    b.destroy();
  } finally {
    await t.close();
  }
});
