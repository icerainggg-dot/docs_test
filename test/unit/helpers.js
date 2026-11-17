import * as Y from 'yjs';
import { initRhwp, openDocument, HwpDocument } from '../../src/shared/rhwp-node.js';
import { seedYDoc, getLists, bodyKey } from '../../src/shared/model.js';
import { Reconciler, collectChanges } from '../../src/shared/reconciler.js';

await initRhwp();

/** 본문 두 문단 + 2x2 표 + 마지막 문단으로 된 시험용 원본 HWPX */
export function sampleHwpx() {
  const d = HwpDocument.createEmpty();
  d.createBlankDocument();
  d.insertText(0, 0, 0, '동시편집 시험 문서');
  d.applyCharFormat(0, 0, 0, 4, JSON.stringify({ bold: true }));
  d.splitParagraph(0, 0, 10);
  d.insertText(0, 1, 0, '둘째 문단입니다.');
  d.splitParagraph(0, 1, 9);
  d.createTable(0, 2, 0, 2, 2);
  const tp = [0, 1, 2, 3, 4].find((i) => {
    try {
      d.getTableDimensions(0, i, 0);
      return true;
    } catch {
      return false;
    }
  });
  const path = (cell) => JSON.stringify([{ controlIndex: 0, cellIndex: cell, cellParaIndex: 0 }]);
  d.insertTextInCellByPath(0, tp, path(0), 0, '이름');
  d.insertTextInCellByPath(0, tp, path(1), 0, '홍길동');
  d.insertTextInCellByPath(0, tp, path(2), 0, '부서');
  const last = d.getParagraphCount(0) - 1;
  d.insertText(0, last, 0, '끝 문단');
  const bytes = d.exportHwpx();
  d.free();
  return bytes;
}

/** 서버가 하는 일: 원본에서 Y 초기 상태를 만든다. */
export function seedUpdate(base) {
  const ydoc = new Y.Doc();
  const hwp = openDocument(base);
  seedYDoc(ydoc, hwp);
  hwp.free();
  return Y.encodeStateAsUpdate(ydoc);
}

/** 참여자 한 명: Y 문서 + rHWP 문서 + Reconciler */
export function makePeer(base, update) {
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, update);
  const hwp = openDocument(base);
  const rec = new Reconciler(hwp, ydoc);
  rec.syncAll();
  const lists = getLists(ydoc);
  lists.observeDeep((events) => rec.sync(collectChanges(events)));
  return { ydoc, hwp, rec, lists, body: lists.get(bodyKey(0)) };
}

export function connect(a, b) {
  const sync = (from, to) => Y.applyUpdate(to.ydoc, Y.encodeStateAsUpdate(from.ydoc, Y.encodeStateVector(to.ydoc)));
  return () => {
    sync(a, b);
    sync(b, a);
  };
}

/** rHWP 문서에서 읽은 실제 상태 (글자 + 글자모양 속성 요약) */
export function hwpState(peer) {
  const out = {};
  for (const key of peer.lists.keys()) {
    const ref = peer.rec.ref(key);
    if (!ref) continue;
    const a = peer.rec.adapter;
    const paras = [];
    for (let i = 0; i < a.paraCount(ref); i++) {
      const text = a.text(ref, i);
      let fmt = '';
      for (let o = 0; o < text.length; o++) {
        const p = a.charProps(ref, i, o);
        fmt += p.bold ? 'B' : p.italic ? 'I' : p.underline ? 'U' : '.';
      }
      paras.push(`${text}〔${fmt}〕`);
    }
    out[key] = paras;
  }
  return out;
}

export function yTexts(peer) {
  const out = {};
  for (const [key, arr] of peer.lists) out[key] = arr.map((p) => p.get('t').toString());
  return out;
}
