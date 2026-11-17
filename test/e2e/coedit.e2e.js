// 브라우저 두 개로 같은 문서를 열어 동시편집을 확인하는 자동 시험.
//   npm run build && npm run test:e2e
// SHOTS=<폴더> 를 주면 화면 갈무리를 남긴다.

import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from '../../server/index.js';
import { sampleHwpx } from '../unit/helpers.js';
import { openDocument } from '../../src/shared/rhwp-node.js';

const { chromium } = createRequire(import.meta.url)('playwright');
const shots = process.env.SHOTS;

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hwpx-coedit-e2e-'));
const srv = await createServer({ dataDir, debounce: 100, maxDebounce: 500 });
const port = await srv.listen(0, '127.0.0.1');
const origin = `http://127.0.0.1:${port}`;
const browser = await chromium.launch();
let failed = false;

const bodyTexts = (page) =>
  page.evaluate(() => window.__editor.lists.get('s0').map((p) => p.get('t').toString()));
const hwpTexts = (page) =>
  page.evaluate(() => {
    const ed = window.__editor;
    const ref = ed.rec.ref('s0');
    return Array.from({ length: ed.adapter.paraCount(ref) }, (_, i) => ed.adapter.text(ref, i));
  });
const waitFor = async (fn, what, ms = 8000) => {
  const t0 = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - t0 > ms) throw new Error(`시간 초과: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
};

async function openAs(name, id) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 }, deviceScaleFactor: shots ? 2 : 1 });
  await ctx.addInitScript((n) => localStorage.setItem('hwpx-coedit:name', n), name);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => {
    failed = true;
    console.error(`[${name}] 페이지 오류:`, e.message);
  });
  page.on('console', (m) => {
    if (m.type() === 'error') console.error(`[${name}] console:`, m.text());
  });
  await page.goto(`${origin}/#/d/${id}`);
  await page.waitForSelector('.page canvas');
  await page.waitForFunction(() => window.__editor);
  return page;
}

/** 본문 문단 idx 의 off 번째 글자 앞을 마우스로 누른다. */
async function clickAt(page, key, idx, off) {
  const pt = await page.evaluate(
    ([key, idx, off]) => {
      const ed = window.__editor;
      const hp = ed.hwpPos({ key, idx, off });
      const r = ed.adapter.cursorRect(hp.ref, hp.idx, hp.off);
      const el = document.querySelectorAll('.page')[r.pageIndex].getBoundingClientRect();
      return { x: el.left + r.x + 0.5, y: el.top + r.y + r.height / 2 };
    },
    [key, idx, off],
  );
  await page.mouse.click(pt.x, pt.y);
}

try {
  // 1) 첫 화면에서 HWPX 올리기
  const home = await browser.newPage();
  await home.goto(origin);
  await home.locator('input[type=file]').setInputFiles({
    name: '시험 서식.hwpx',
    mimeType: 'application/hwp+zip',
    buffer: Buffer.from(sampleHwpx()),
  });
  await home.waitForURL(/#\/d\/[a-z0-9]{12}$/);
  const id = home.url().split('/').pop();
  await home.close();

  // 2) 두 사람이 같은 문서를 연다
  const a = await openAs('김가람', id);
  const b = await openAs('이나래', id);
  assert.deepEqual((await bodyTexts(a)).filter(Boolean), ['동시편집 시험 문서', '둘째 문단입니다.', '끝 문단']);
  await waitFor(async () => (await a.locator('.peer').count()) === 2, '참여자 두 명 표시');

  // 3) 서로 다른 문단에 동시에 입력
  await clickAt(a, 's0', 0, 10);
  await clickAt(b, 's0', 1, 0);
  await Promise.all([a.keyboard.type(' — 가람이 씀', { delay: 15 }), b.keyboard.type('나래가 씀: ', { delay: 15 })]);
  await waitFor(async () => {
    const [ta, tb] = [await bodyTexts(a), await bodyTexts(b)];
    return ta[0] === '동시편집 시험 문서 — 가람이 씀' && ta[1] === '나래가 씀: 둘째 문단입니다.' && JSON.stringify(ta) === JSON.stringify(tb);
  }, '두 화면의 내용이 같아짐');
  assert.deepEqual(await hwpTexts(a), await bodyTexts(a), 'A 의 rHWP 문서 = Y 상태');
  assert.deepEqual(await hwpTexts(b), await bodyTexts(b), 'B 의 rHWP 문서 = Y 상태');
  await waitFor(async () => (await a.locator('.caret.remote span').textContent().catch(() => '')) === '이나래', '상대 커서 표시');

  // 4) 같은 문단 안에서 동시에 입력 + 문단 나누기
  await clickAt(a, 's0', 0, 0);
  await clickAt(b, 's0', 0, 4);
  await Promise.all([a.keyboard.type('[A]', { delay: 20 }), b.keyboard.type('[B]', { delay: 20 })]);
  await b.keyboard.press('Enter');
  await waitFor(async () => {
    const ta = await bodyTexts(a);
    return ta[0] === '[A]동시편집[B]' && ta[1] === ' 시험 문서 — 가람이 씀';
  }, '같은 문단 동시 입력과 문단 나누기');

  // 5) 한글 조합(IME) — 조합 중인 글자가 상대에게 보이고, 끝나면 확정된다
  await clickAt(a, 's0', 2, 0);
  const cdp = await a.context().newCDPSession(a);
  for (const text of ['ㅎ', '하', '한']) {
    await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
  }
  await waitFor(async () => (await bodyTexts(b))[2].startsWith('한'), '조합 중 글자가 상대에게 보임');
  // 조합 중에 상대가 다른 문단을 고친다 → A 화면에는 조합이 끝난 뒤 반영된다
  await clickAt(b, 's0', 3, 0);
  await b.keyboard.type('#');
  await waitFor(async () => (await bodyTexts(a))[3].startsWith('#'), 'A 의 Y 문서에 도착');
  assert.notEqual((await hwpTexts(a))[3][0], '#', '조합 중에는 원격 변경을 화면에 미룬다');
  await cdp.send('Input.insertText', { text: '한' });
  await a.keyboard.type('글 ');
  await waitFor(async () => (await hwpTexts(a))[3].startsWith('#') && (await bodyTexts(b))[2].startsWith('한글 '), '조합 종료 후 반영');

  // 6) 서식, 실행 취소
  await clickAt(a, 's0', 2, 0);
  await a.keyboard.press('Shift+ArrowRight');
  await a.keyboard.press('Shift+ArrowRight');
  await a.keyboard.press('Control+b');
  const boldAt = (page) =>
    page.evaluate(() => {
      const ed = window.__editor;
      return ed.adapter.charProps(ed.rec.ref('s0'), 2, 0).bold;
    });
  await waitFor(async () => (await boldAt(a)) && (await boldAt(b)), '굵게가 양쪽에 적용');
  assert.equal(await a.locator('.fmt-b').getAttribute('aria-pressed'), 'true');
  await a.keyboard.press('Control+z');
  await waitFor(async () => !(await boldAt(a)) && !(await boldAt(b)), '실행 취소가 양쪽에 반영');
  assert.ok((await bodyTexts(a))[2].startsWith('한글 '), '서식 실행 취소가 앞선 입력까지 되돌리지 않는다');

  // 7) 표 셀 편집
  const cellKey = await a.evaluate(() => [...window.__editor.lists.keys()].find((k) => k.startsWith('c|') && k.endsWith('|3')));
  await clickAt(a, cellKey, 0, 0);
  await a.keyboard.type('총무과');
  await waitFor(async () => (await b.evaluate((k) => window.__editor.lists.get(k).get(0).get('t').toString(), cellKey)) === '총무과', '표 셀 편집이 전달됨');

  if (shots) {
    await mkdir(shots, { recursive: true });
    await clickAt(b, 's0', 1, 3);
    await b.keyboard.down('Shift');
    for (let i = 0; i < 5; i++) await b.keyboard.press('ArrowRight');
    await b.keyboard.up('Shift');
    await a.waitForTimeout(400);
    await a.screenshot({ path: path.join(shots, 'editor-a.png') });
    await b.screenshot({ path: path.join(shots, 'editor-b.png') });
  }

  // 8) 자동 저장 → HWPX 내려받아 다시 열기
  await waitFor(async () => (await (await fetch(`${origin}/api/docs/${id}`)).json()).save?.ok, '자동 저장');
  const res = await fetch(`${origin}/api/docs/${id}/export`);
  const doc = openDocument(new Uint8Array(await res.arrayBuffer()));
  const saved = Array.from({ length: doc.getParagraphCount(0) }, (_, i) => doc.getTextRange(0, i, 0, 1000));
  doc.free();
  assert.deepEqual(saved, await bodyTexts(a), '저장된 HWPX 의 본문 = 화면의 본문');
  const info = await (await fetch(`${origin}/api/docs/${id}`)).json();
  assert.equal(info.save.diffs, 0, '저장 호환성 검사 통과');

  // 9) 늦게 들어온 세 번째 사람도 같은 문서를 본다
  const c = await openAs('박다온', id);
  assert.deepEqual(await hwpTexts(c), await hwpTexts(a));
  if (shots) {
    const first = await browser.newPage({ viewport: { width: 900, height: 600 }, deviceScaleFactor: 2 });
    await first.goto(origin);
    await first.waitForSelector('.doc-list li');
    await first.screenshot({ path: path.join(shots, 'home.png') });
  }

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
