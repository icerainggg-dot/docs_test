import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { sampleHwpx, seedUpdate, makePeer, connect, hwpState, yTexts, cellList, textAt } from './helpers.ts';
import type { Peer } from './helpers.ts';
import * as ops from '../../src/shared/ops.ts';
import { openDocument } from '../../src/shared/rhwp-node.ts';
import { Reconciler } from '../../src/shared/reconciler.ts';
import { bodyRef } from '../../src/shared/hwp-adapter.ts';
import { keyOfList, paraText } from '../../src/shared/model.ts';
import type { ParaList } from '../../src/shared/model.ts';
import { renderHwpx } from '../../server/saver.ts';

const base = sampleHwpx();
const seed = seedUpdate(base);

const keyOf = (p: Peer, l: ParaList): string => {
  const key = keyOfList(l);
  if (!key) throw new Error('리스트의 열쇠를 찾지 못했습니다.');
  assert.equal(p.lists.get(key), l);
  return key;
};

test('원본을 훑어 본문과 표 셀을 문단 리스트로 만든다', () => {
  const p = makePeer(base, seed);
  assert.deepEqual(
    p.body.map((x) => paraText(x).toString()).filter(Boolean),
    ['동시편집 시험 문서', '둘째 문단입니다.', '끝 문단'],
  );
  assert.equal([...p.lists.keys()].filter((k) => k.startsWith('c|')).length, 4);
  assert.equal(textAt(cellList(p, 1), 0), '홍길동');
  assert.deepEqual(p.rec.verify(), []);
});

test('글자 넣기·지우기가 rHWP 문서에 반영되고 주변 서식을 물려받는다', () => {
  const p = makePeer(base, seed);
  ops.insertText(p.body, 0, 2, '【굵게】'); // 굵은 글자 사이
  ops.insertText(p.body, 0, textAt(p.body, 0).length, ' 끝');
  ops.deleteRange(p.body, 1, 0, 1, 3);
  assert.deepEqual(p.rec.verify(), []);
  const s = hwpState(p).s0!;
  assert.equal(s[0], '동시【굵게】편집 시험 문서 끝〔BBBBBBBB........〕');
  assert.equal(s[1], '문단입니다.〔......〕');
});

test('문단 가르기·합치기에서 글자와 서식이 보존된다', () => {
  const p = makePeer(base, seed);
  const before = hwpState(p).s0;
  const pos = ops.splitPara(p.body, 0, 2);
  assert.deepEqual(hwpState(p).s0!.slice(0, 2), ['동시〔BB〕', '편집 시험 문서〔BB......〕']);
  ops.mergeWithPrev(p.body, pos.idx);
  assert.deepEqual(hwpState(p).s0, before);
  assert.deepEqual(p.rec.verify(), []);
});

test('표 셀 안에서 편집할 수 있고, 표 앞 문단 구조가 바뀌어도 셀 위치를 찾는다', () => {
  const p = makePeer(base, seed);
  const cell = cellList(p, 1);
  ops.insertText(cell, 0, 3, ' 과장');
  ops.splitPara(cell, 0, 3);
  ops.splitPara(p.body, 0, 4); // 표보다 앞에서 문단이 하나 늘어난다
  ops.insertText(cell, 1, 0, '직급:');
  assert.deepEqual(p.rec.verify(), []);
  assert.deepEqual(hwpState(p)[keyOf(p, cell)], ['홍길동〔...〕', '직급: 과장〔......〕']);
});

test('덧입힌 서식(굵게/기울임)과 그 실행 취소', () => {
  const p = makePeer(base, seed);
  const undo = new Y.UndoManager(p.lists, { trackedOrigins: new Set([ops.LOCAL]) });
  p.ydoc.transact(() => ops.formatRange(p.body, 1, 0, 1, 2, { i: true }), ops.LOCAL);
  assert.equal(hwpState(p).s0![1], '둘째 문단입니다.〔II.......〕');
  undo.stopCapturing();
  p.ydoc.transact(() => ops.formatRange(p.body, 0, 0, 0, 4, { b: false }), ops.LOCAL);
  assert.equal(hwpState(p).s0![0], '동시편집 시험 문서〔..........〕');
  undo.undo();
  assert.equal(hwpState(p).s0![0], '동시편집 시험 문서〔BBBB......〕');
  undo.undo();
  assert.equal(hwpState(p).s0![1], '둘째 문단입니다.〔.........〕');
});

test('두 참여자가 동시에 고쳐도 같은 문서로 수렴한다', () => {
  const a = makePeer(base, seed);
  const b = makePeer(base, seed);
  const sync = connect(a, b);
  // 같은 문단의 서로 다른 자리, 그리고 한쪽은 문단을 가른다.
  ops.insertText(a.body, 0, 0, 'A가 씀 ');
  ops.insertText(b.body, 0, 10, ' B가 씀');
  ops.splitPara(a.body, 1, 3);
  ops.insertText(b.body, 1, 9, ' (B 추가)');
  ops.insertText(cellList(a, 0), 0, 2, '(성명)');
  ops.deleteRange(cellList(b, 0), 0, 0, 0, 1);
  sync();
  assert.deepEqual(yTexts(a), yTexts(b));
  assert.deepEqual(hwpState(a), hwpState(b));
  assert.deepEqual(a.rec.verify(), []);
  assert.deepEqual(b.rec.verify(), []);
});

test('늦게 들어온 참여자와 저장 워커가 실시간 참여자와 같은 결과를 얻는다', () => {
  const a = makePeer(base, seed);
  ops.insertText(a.body, 0, 4, ' 실시간');
  ops.splitPara(a.body, 0, 6);
  ops.formatRange(a.body, 1, 0, 1, 2, { u: true });
  ops.insertLines(a.body, 2, 2, ' 여러\n줄 붙여넣기\n');
  ops.insertText(cellList(a, 3), 0, 0, '총무과');

  const late = makePeer(base, Y.encodeStateAsUpdate(a.ydoc));
  assert.deepEqual(hwpState(late), hwpState(a));

  // 저장: 원본 + Y 상태 → HWPX → 다시 열어 비교
  const { bytes, diffs } = renderHwpx(base, a.ydoc);
  assert.deepEqual(diffs, []);
  const reopened = openDocument(bytes);
  const rec = new Reconciler(reopened, new Y.Doc());
  const ref = bodyRef(0);
  const texts = Array.from({ length: rec.adapter.paraCount(ref) }, (_, i) => rec.adapter.text(ref, i));
  assert.deepEqual(texts, yTexts(a).s0);
  reopened.free();
});

test('무작위 동시편집 — 세 참여자가 항상 수렴하고 rHWP 문서가 Y 상태와 일치한다', () => {
  let seedNum = 20261117;
  const rnd = (n: number): number => {
    seedNum = (seedNum * 1103515245 + 12345) & 0x7fffffff;
    return seedNum % n;
  };
  const pick = <T>(arr: readonly T[]): T => arr[rnd(arr.length)]!;
  const peers = [makePeer(base, seed), makePeer(base, seed), makePeer(base, seed)];
  const syncAll = (): void => {
    for (let r = 0; r < 2; r++) {
      for (const x of peers) for (const y of peers) if (x !== y) connect(x, y)();
    }
  };
  const words = ['가', '나다', '한글 ', 'abc', ' ', '서식', '표'];
  const marks = ['b', 'i', 'u'] as const;

  for (let round = 0; round < 40; round++) {
    for (const p of peers) {
      const steps = 1 + rnd(3);
      for (let s = 0; s < steps; s++) {
        const key = pick([...p.lists.keys()].filter((k) => p.rec.ref(k)));
        const list = p.lists.get(key)!;
        const ref = p.rec.ref(key)!;
        const idx = rnd(list.length);
        const len = textAt(list, idx).length;
        const off = rnd(len + 1);
        const canRemove = (i: number): boolean => p.rec.adapter.controlCount(ref, i) === 0;
        p.ydoc.transact(() => {
          switch (rnd(7)) {
            case 0:
            case 1:
              ops.insertText(list, idx, off, pick(words));
              break;
            case 2:
              if (len) ops.deleteRange(list, idx, Math.min(off, len - 1), idx, Math.min(len, off + 1 + rnd(3)));
              break;
            case 3:
              if (list.length < 8) ops.splitPara(list, idx, off);
              break;
            case 4:
              if (idx > 0 && canRemove(idx)) ops.mergeWithPrev(list, idx);
              break;
            case 5:
              if (len) ops.formatRange(list, idx, 0, idx, off, { [pick(marks)]: rnd(2) === 0 });
              break;
            case 6: {
              const j = Math.min(list.length - 1, idx + rnd(3));
              ops.deleteRange(list, idx, off, j, j === idx ? len : rnd(textAt(list, j).length + 1), canRemove);
              break;
            }
          }
        }, ops.LOCAL);
      }
    }
    if (round % 3 === 2) syncAll();
  }
  syncAll();

  for (const p of peers) {
    assert.deepEqual(p.rec.verify(), [], 'rHWP 문서의 글자가 Y 상태와 같아야 한다');
    assert.deepEqual(p.rec.warnings, []);
  }
  const [p0, p1, p2] = peers as [Peer, Peer, Peer];
  assert.deepEqual(yTexts(p0), yTexts(p1));
  assert.deepEqual(yTexts(p1), yTexts(p2));
  assert.deepEqual(hwpState(p0), hwpState(p1));
  assert.deepEqual(hwpState(p1), hwpState(p2));

  // 처음부터 다시 만든 문서(늦게 들어온 참여자)도 같아야 한다.
  const late = makePeer(base, Y.encodeStateAsUpdate(p0.ydoc));
  assert.deepEqual(hwpState(late), hwpState(p0));
});
