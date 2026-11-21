/// <reference lib="dom" />
// 브라우저로 실제 사용 흐름을 확인하는 자동 시험.
//   npm run build && npm run test:e2e
// SHOTS=<폴더> 를 주면 화면 갈무리를 남긴다.
// Playwright 는 프로젝트 의존성이 아니라 실행 환경에 설치된 것을 쓴다.

import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from '../../server/index.ts';
import type { DocMeta } from '../../server/store.ts';
import { sampleHwpx } from '../unit/helpers.ts';
import { sampleXlsx } from '../unit/xlsx-sample.ts';
import { openDocument } from '../../src/shared/rhwp-node.ts';
import { parseXlsx } from '../../src/shared/xlsx/parse.ts';
// 화면이 자동 시험용으로 window 에 걸어 두는 객체 중 이 시험이 쓰는 부분
interface E2EEditor {
  list(key: string): { map<T>(fn: (p: { get(k: string): unknown }) => T): T[] };
  hwpPos(p: { key: string; idx: number; off: number }): { ref: unknown; idx: number; off: number } | null;
  adapter: { cursorRect(ref: unknown, idx: number, off: number): { pageIndex: number; x: number; y: number; height: number } };
}
interface E2ESheet {
  display(sheet: number, row: number, col: number): { text: string };
}
interface E2EGrid {
  clientRectOf(row: number, col: number): { x: number; y: number; w: number; h: number };
}
declare global {
  interface Window {
    __editor?: E2EEditor;
    __sheet?: E2ESheet;
    __grid?: E2EGrid;
  }
}

// ── Playwright 중 이 시험이 쓰는 부분 ──
interface Locator {
  count(): Promise<number>;
  click(): Promise<void>;
  fill(v: string): Promise<void>;
  first(): Locator;
  textContent(): Promise<string | null>;
  getAttribute(name: string): Promise<string | null>;
  selectOption(value: { label: string }): Promise<unknown>;
  setInputFiles(file: { name: string; mimeType: string; buffer: Buffer }): Promise<void>;
  waitFor(opts?: { state?: string; timeout?: number }): Promise<void>;
}
interface Page {
  goto(url: string): Promise<unknown>;
  reload(): Promise<unknown>;
  url(): string;
  on(event: 'pageerror', fn: (e: Error) => void): void;
  on(event: 'console', fn: (m: { type(): string; text(): string }) => void): void;
  once(event: 'dialog', fn: (d: { accept(text?: string): Promise<void> }) => void): void;
  waitForSelector(sel: string, opts?: { timeout?: number }): Promise<unknown>;
  waitForURL(re: RegExp): Promise<void>;
  waitForFunction(fn: () => unknown): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  evaluate<R>(fn: () => R): Promise<R>;
  evaluate<R, A>(fn: (arg: A) => R, arg: A): Promise<R>;
  locator(sel: string): Locator;
  getByRole(role: string, opts: { name: string | RegExp; exact?: boolean }): Locator;
  getByLabel(text: string, opts?: { exact?: boolean }): Locator;
  screenshot(opts: { path: string }): Promise<unknown>;
  context(): BrowserContext;
  mouse: { click(x: number, y: number, opts?: { clickCount?: number }): Promise<void>; dblclick(x: number, y: number): Promise<void> };
  keyboard: { type(text: string, opts?: { delay?: number }): Promise<void>; press(key: string): Promise<void> };
}
interface BrowserContext {
  newPage(): Promise<Page>;
  newCDPSession(page: Page): Promise<{ send(method: string, params?: object): Promise<unknown> }>;
}
interface Browser {
  newContext(opts?: object): Promise<BrowserContext>;
  close(): Promise<void>;
}
const { chromium } = createRequire(import.meta.url)('playwright') as { chromium: { launch(): Promise<Browser> } };

const shots = process.env.SHOTS;
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'coedit-e2e-'));
const srv = await createServer({ dataDir, debounce: 100, maxDebounce: 500 });
const port = await srv.listen(0, '127.0.0.1');
const origin = `http://127.0.0.1:${port}`;
const browser = await chromium.launch();
let failed = false;

await srv.users.create('garam', '김가람', 'password1234');
await srv.users.create('narae', '이나래', 'password1234');
await srv.users.create('daon', '박다온', 'password1234');
const ids = Object.fromEntries((await srv.users.list()).map((u) => [u.username, u.id]));

const waitFor = async (fn: () => boolean | Promise<boolean>, what: string, ms = 8000): Promise<void> => {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - t0 > ms) throw new Error(`시간 초과: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

/** 로그인 화면으로 들어온다. */
async function login(username: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: shots ? 2 : 1 });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => {
    failed = true;
    console.error(`[${username}] 페이지 오류:`, e.message);
  });
  page.on('console', (m) => {
    if (m.type() === 'error' && !/401|404|403/.test(m.text())) console.error(`[${username}] console:`, m.text());
  });
  if (process.env.E2E_DEBUG) {
    page.on('response' as 'console', ((r: { url(): string; status(): number }) => {
      if (r.url().includes('/api/')) console.log(`[${username}]`, r.status(), r.url().replace(origin, ''));
    }) as never);
  }
  await page.goto(origin);
  await page.waitForURL(/#\/login$/);
  await page.getByLabel('아이디').fill(username);
  await page.getByLabel('암호 (8자 이상)').fill('password1234');
  await page.getByRole('button', { name: '로그인', exact: true }).click();
  await page.waitForSelector('.doc-list');
  return page;
}

async function upload(page: Page, name: string, bytes: Uint8Array): Promise<string> {
  // 파일 경로로 넘기면 한글 이름에서 변경 이벤트가 나지 않아(시험 도구 문제) 내용으로 넘긴다.
  await page.locator('input[type=file]').setInputFiles({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) });
  await page.waitForURL(/#\/d\/[a-z0-9]{12}$/);
  return page.url().split('/').pop()!;
}

/** 공유 창에서 사람을 찾아 편집 권한을 준다. */
async function share(page: Page, who: string): Promise<void> {
  await page.getByRole('button', { name: '공유', exact: true }).click();
  await page.getByLabel('사람 찾기').fill(who);
  await page.getByRole('button', { name: '편집 권한 주기' }).first().click();
  await page.waitForSelector(`dialog.share .members >> text=${who}`);
  await page.getByRole('button', { name: '닫기' }).click();
}

async function openFromList(page: Page, title: string): Promise<void> {
  await page.goto(`${origin}/#/`);
  await page.reload();
  await page.waitForSelector('.doc-list li');
  await page.getByRole('link', { name: title }).click();
}

const docInfo = async (id: string): Promise<DocMeta> => {
  const res = await fetch(`${origin}/api/docs`, { headers: {} });
  void res;
  return (await srv.store.meta(id))!;
};

// HWPX 도우미 (page.evaluate 안의 함수는 브라우저에서 돈다)
const bodyTexts = (page: Page): Promise<string[]> =>
  page.evaluate(() => window.__editor!.list('s0').map((p) => String(p.get('t'))));
async function clickText(page: Page, idx: number, off: number): Promise<void> {
  const pt = await page.evaluate(([idx, off]: [number, number]) => {
    const ed = window.__editor!;
    const hp = ed.hwpPos({ key: 's0', idx, off })!;
    const r = ed.adapter.cursorRect(hp.ref, hp.idx, hp.off);
    const el = document.querySelectorAll('.page')[r.pageIndex]!.getBoundingClientRect();
    return { x: el.left + r.x + 0.5, y: el.top + r.y + r.height / 2 };
  }, [idx, off] as [number, number]);
  await page.mouse.click(pt.x, pt.y);
}

// XLSX 도우미
async function clickCell(page: Page, row: number, col: number, dbl = false): Promise<void> {
  const r = await page.evaluate(([row, col]: [number, number]) => window.__grid!.clientRectOf(row, col), [row, col] as [number, number]);
  if (dbl) await page.mouse.dblclick(r.x + r.w / 2, r.y + r.h / 2);
  else await page.mouse.click(r.x + r.w / 2, r.y + r.h / 2);
}
const shown = (page: Page, sheet: number, row: number, col: number): Promise<string> =>
  page.evaluate(([s, r, c]: [number, number, number]) => window.__sheet!.display(s, r, c).text, [sheet, row, col] as [number, number, number]);

try {
  const garam = await login('garam');
  const narae = await login('narae');
  const daon = await login('daon');

  // ── 1) HWPX: 올리기 → 공유 → 동시편집 ──
  const hwpxId = await upload(garam, '시험 서식.hwpx', sampleHwpx());
  await garam.waitForFunction(() => window.__editor);
  assert.deepEqual((await bodyTexts(garam)).filter(Boolean), ['동시편집 시험 문서', '둘째 문단입니다.', '끝 문단']);

  // 공유 전에는 남이 열 수 없다.
  await daon.goto(`${origin}/#/d/${hwpxId}`);
  await daon.waitForURL(/#\/$/);

  await share(garam, '이나래');
  await openFromList(narae, '시험 서식');
  await narae.waitForFunction(() => window.__editor);
  await waitFor(async () => (await garam.locator('.peer').count()) === 2, '참여자 두 명 표시');

  await clickText(garam, 0, 10);
  await clickText(narae, 1, 0);
  await Promise.all([garam.keyboard.type(' — 가람', { delay: 15 }), narae.keyboard.type('나래: ', { delay: 15 })]);
  await waitFor(async () => {
    const [a, b] = [await bodyTexts(garam), await bodyTexts(narae)];
    return a[0] === '동시편집 시험 문서 — 가람' && a[1] === '나래: 둘째 문단입니다.' && JSON.stringify(a) === JSON.stringify(b);
  }, 'HWPX 동시 입력');
  await waitFor(async () => (await garam.locator('.caret.remote span').textContent().catch(() => '')) === '이나래', '상대 커서');

  // 한글 조합 입력
  await clickText(garam, 2, 0);
  const cdp = await garam.context().newCDPSession(garam);
  for (const text of ['ㅎ', '하', '한']) await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
  await waitFor(async () => ((await bodyTexts(narae))[2] ?? '').startsWith('한'), '조합 중 글자가 상대에게 보임');
  await cdp.send('Input.insertText', { text: '한' });
  await garam.keyboard.type('글 ');
  await waitFor(async () => ((await bodyTexts(narae))[2] ?? '').startsWith('한글 '), 'HWPX 한글 입력');
  if (shots) {
    await mkdir(shots, { recursive: true });
    await garam.waitForTimeout(300);
    await garam.screenshot({ path: path.join(shots, '2-hwpx.png') });
  }

  // ── 2) XLSX: 올리기 → 공유 → 셀 동시편집 ──
  await garam.goto(`${origin}/#/`);
  await garam.waitForSelector('.doc-list li');
  const xlsxId = await upload(garam, '부서 예산.xlsx', await sampleXlsx());
  await garam.waitForFunction(() => window.__grid);
  assert.equal(await shown(garam, 0, 6, 4), '8,250,000', '숫자 서식으로 보인다');
  assert.equal(await shown(garam, 0, 7, 4), '48.5%');
  assert.equal(await garam.locator('.tab').count(), 2);

  await share(garam, '이나래');
  await openFromList(narae, '부서 예산');
  await narae.waitForFunction(() => window.__grid);

  // 가람: B5 에 숫자 입력 → 나래 화면의 합계가 다시 계산된다.
  await clickCell(garam, 5, 2);
  await garam.keyboard.type('3100000');
  await garam.keyboard.press('Enter');
  await waitFor(async () => (await shown(narae, 0, 6, 4)) === '9,250,000', '상대 화면에서 수식이 다시 계산됨');
  assert.equal(await shown(narae, 0, 5, 2), '3,100,000');

  // 나래: E3 에 한글 (IME 조합) → 가람 화면에 보인다.
  await clickCell(narae, 3, 5);
  const cdp2 = await narae.context().newCDPSession(narae);
  for (const text of ['ㅂ', '비', '빅', '비고']) await cdp2.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
  await cdp2.send('Input.insertText', { text: '비고' });
  await narae.keyboard.press('Enter');
  await waitFor(async () => (await shown(garam, 0, 3, 5)) === '비고', '한글 셀 입력이 전달됨');

  // 나래: 수식 입력줄로 수식 입력
  await clickCell(narae, 4, 5);
  await narae.locator('.fx').click();
  await narae.keyboard.type('=D4/1000');
  await narae.keyboard.press('Enter');
  await waitFor(async () => (await shown(garam, 0, 4, 5)) === '1750', '수식 입력줄로 넣은 수식');

  // 상대가 고르고 있는 셀이 이름과 함께 보인다.
  await waitFor(async () => (await garam.locator('.peer-cell span').textContent().catch(() => '')) === '이나래', 'XLSX 상대 셀 표시');

  // 지우기와 실행 취소
  await clickCell(garam, 7, 1);
  await garam.keyboard.press('Delete');
  await waitFor(async () => (await shown(narae, 0, 7, 1)) === '', '셀 지우기 전달');
  await garam.keyboard.press('Control+z');
  await waitFor(async () => (await shown(narae, 0, 7, 1)) === '정보과 비율', '실행 취소 전달');

  // 두 번째 시트
  await garam.getByRole('tab', { name: '요약' }).click();
  assert.equal(await shown(garam, 1, 1, 2), '9250000', '다른 시트도 다시 계산된다 (서식 없는 셀)');

  if (shots) {
    await clickCell(narae, 6, 2);
    await garam.getByRole('tab', { name: '예산' }).click();
    await clickCell(garam, 5, 2);
    await garam.waitForTimeout(400);
    await garam.screenshot({ path: path.join(shots, '3-xlsx-garam.png') });
    await narae.screenshot({ path: path.join(shots, '4-xlsx-narae.png') });
  }

  // 저장된 파일 확인
  await waitFor(async () => Boolean((await docInfo(xlsxId)).save?.ok) && !srv.server.hocuspocus.debouncer.isDebounced(xlsxId), 'XLSX 자동 저장');
  await waitFor(async () => {
    const latest = await srv.store.versions(xlsxId);
    return latest.length > 0;
  }, '저장본');
  const ydoc = srv.server.hocuspocus.documents.get(xlsxId)!;
  const { renderXlsx } = await import('../../server/saver.ts');
  const model = parseXlsx((await srv.store.base(xlsxId))!);
  const saved = parseXlsx(renderXlsx((await srv.store.base(xlsxId))!, model, ydoc).bytes);
  assert.equal(saved.sheets[0]!.cells.B5?.v, 3100000);
  assert.equal(saved.sheets[0]!.cells.E3?.v, '비고');
  assert.equal(saved.sheets[0]!.cells.E4?.f, 'D4/1000');
  assert.equal(saved.sheets[0]!.cells.D6?.v, 9250000);

  // ── 3) 권한 거두기: 열어 둔 화면이 막힌다 ──
  await srv.store.updateMeta(xlsxId, { editors: [] });
  const res = await fetch(`${origin}/api/docs/${xlsxId}/editors`, { method: 'PUT' });
  assert.equal(res.status, 401, '로그인하지 않은 요청은 거절');
  // 화면의 공유 창으로 권한을 뺀다.
  await srv.store.updateMeta(xlsxId, { editors: [ids.narae!] });
  await garam.getByRole('button', { name: '공유', exact: true }).click();
  await garam.getByRole('button', { name: '권한 빼기' }).click();
  await garam.waitForSelector('dialog.share >> text=아직 함께 편집하는 사람이 없습니다.');
  await garam.getByRole('button', { name: '닫기' }).click();
  await narae.waitForSelector('.blocker', { timeout: 5000 });

  // HWPX 저장본도 확인
  const hwpxRes = await fetch(`${origin}/api/docs/${hwpxId}/export`, { headers: { cookie: '' } });
  assert.equal(hwpxRes.status, 401);
  const hwpxDoc = srv.server.hocuspocus.documents.get(hwpxId);
  if (hwpxDoc) {
    const { renderHwpx } = await import('../../server/saver.ts');
    const out = renderHwpx((await srv.store.base(hwpxId))!, hwpxDoc);
    assert.deepEqual(out.diffs, []);
    const d = openDocument(out.bytes);
    assert.equal(d.getTextRange(0, 0, 0, 100), '동시편집 시험 문서 — 가람');
    d.free();
  }

  if (shots) await narae.screenshot({ path: path.join(shots, '5-revoked.png') });

  // ── 4) 업무 폴더: 구성원은 문서마다 공유받지 않아도 폴더 안 문서를 연다 ──
  await garam.goto(`${origin}/#/`);
  await garam.waitForSelector('.doc-list li');
  garam.once('dialog', (d) => void d.accept('2027 예산 편성'));
  await garam.getByRole('button', { name: '+ 새 폴더' }).click();
  await garam.waitForURL(/#\/f\/f[a-z0-9]{11}$/);
  const folderId = garam.url().split('/').pop()!;
  await garam.waitForSelector('.folder-head >> text=2027 예산 편성');

  // 구성원 추가
  await garam.getByRole('button', { name: '구성원 관리' }).click();
  await garam.getByLabel('사람 찾기').fill('다온');
  await garam.getByRole('button', { name: '구성원으로 추가' }).click();
  await garam.waitForSelector('dialog.share .members >> text=박다온');
  await garam.getByRole('button', { name: '닫기' }).click();

  // 폴더 안에 새 엑셀 문서 만들기 → 폴더 화면으로 돌아와 기존 한글 문서도 옮기기
  await garam.getByRole('button', { name: '빈 엑셀 문서' }).click();
  await garam.waitForURL(/#\/d\/[a-z0-9]{12}$/);
  await garam.waitForFunction(() => window.__grid);
  const inFolder = garam.url().split('/').pop()!;
  assert.equal((await srv.store.meta(inFolder))!.folderId, folderId, '폴더 안에 만들어진다');
  await garam.locator('.tool.back').click();
  await garam.waitForURL(new RegExp(`#/f/${folderId}$`));
  await garam.goto(`${origin}/#/`);
  await garam.waitForSelector('.doc-list li');
  await garam.getByLabel('"시험 서식" 폴더 옮기기').selectOption({ label: '2027 예산 편성' });
  await waitFor(async () => (await srv.store.meta(hwpxId))!.folderId === folderId, '문서 옮기기');

  // 다온: 폴더가 보이고, 폴더 안 문서 두 개를 연다 (아까는 열 수 없던 한글 문서 포함)
  await daon.goto(`${origin}/#/`);
  await daon.reload();
  await daon.getByRole('link', { name: /2027 예산 편성/ }).click();
  await daon.waitForURL(new RegExp(`#/f/${folderId}$`));
  await waitFor(async () => (await daon.locator('.doc-list li .doc-title').count()) === 2, '폴더 안 문서 두 개');
  await daon.getByRole('link', { name: '시험 서식', exact: true }).click();
  await daon.waitForFunction(() => window.__editor);
  assert.equal(((await bodyTexts(daon))[0] ?? '').startsWith('동시편집 시험 문서'), true, '폴더 구성원으로 한글 문서를 연다');

  if (shots) {
    await garam.goto(`${origin}/#/f/${folderId}`);
    await garam.waitForSelector('.doc-list li .doc-title');
    await garam.screenshot({ path: path.join(shots, '1-folder.png') });
    await garam.goto(`${origin}/#/`);
    await garam.waitForSelector('.doc-list li .doc-title');
    await garam.screenshot({ path: path.join(shots, '1-home.png') });
  }

  // 구성원에서 빼면 열어 둔 화면이 막힌다.
  await srv.folders.update(folderId, { members: [] });
  await garam.goto(`${origin}/#/f/${folderId}`);
  await garam.waitForSelector('.folder-head');
  await garam.getByRole('button', { name: '구성원 관리' }).click();
  await garam.waitForSelector('dialog.share >> text=아직 구성원이 없습니다.');
  await garam.getByLabel('사람 찾기').fill('다온');
  await garam.getByRole('button', { name: '구성원으로 추가' }).click();
  await garam.waitForSelector('dialog.share .members >> text=박다온');
  await garam.getByRole('button', { name: '빼기', exact: true }).click();
  await garam.waitForSelector('dialog.share >> text=아직 구성원이 없습니다.');
  await daon.waitForSelector('.blocker', { timeout: 5000 });

  assert.equal(failed, false, '페이지 오류가 없어야 한다');
  console.log('✓ 동시편집 e2e 시험 통과');
} catch (e) {
  failed = true;
  console.error('✗ e2e 시험 실패:', e);
} finally {
  await browser.close();
  await srv.close();
  await rm(dataDir, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
