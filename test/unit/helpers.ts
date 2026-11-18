import * as Y from 'yjs';
import { initRhwp, openDocument, HwpDocument } from '../../src/shared/rhwp-node.ts';
import { seedYDoc, getLists, bodyKey, paraText } from '../../src/shared/model.ts';
import type { Lists, ParaList } from '../../src/shared/model.ts';
import { Reconciler, collectChanges } from '../../src/shared/reconciler.ts';

await initRhwp();

/** 본문 두 문단 + 2x2 표 + 마지막 문단으로 된 시험용 원본 HWPX */
export function sampleHwpx(): Uint8Array {
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
  if (tp === undefined) throw new Error('시험 문서에 표를 만들지 못했습니다.');
  const path = (cell: number): string => JSON.stringify([{ controlIndex: 0, cellIndex: cell, cellParaIndex: 0 }]);
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
export function seedUpdate(base: Uint8Array): Uint8Array {
  const ydoc = new Y.Doc();
  const hwp = openDocument(base);
  seedYDoc(ydoc, hwp);
  hwp.free();
  return Y.encodeStateAsUpdate(ydoc);
}

/** 참여자 한 명: Y 문서 + rHWP 문서 + Reconciler */
export interface Peer {
  ydoc: Y.Doc;
  hwp: HwpDocument;
  rec: Reconciler;
  lists: Lists;
  body: ParaList;
}

export function makePeer(base: Uint8Array, update: Uint8Array): Peer {
  const ydoc = new Y.Doc();
  Y.applyUpdate(ydoc, update);
  const hwp = openDocument(base);
  const rec = new Reconciler(hwp, ydoc);
  rec.syncAll();
  const lists = getLists(ydoc);
  lists.observeDeep((events) => rec.sync(collectChanges(events)));
  return { ydoc, hwp, rec, lists, body: list(lists, bodyKey(0)) };
}

/** 리스트를 꺼낸다 (없으면 시험 실패) */
export function list(lists: Lists, key: string): ParaList {
  const l = lists.get(key);
  if (!l) throw new Error(`문단 리스트 ${key} 이(가) 없습니다.`);
  return l;
}

/** 표 셀 리스트 (cell 번호로) */
export function cellList(peer: Peer, cell: number): ParaList {
  const key = [...peer.lists.keys()].find((k) => k.startsWith('c|') && k.endsWith(`|${cell}`));
  if (!key) throw new Error(`셀 ${cell} 이(가) 없습니다.`);
  return list(peer.lists, key);
}

/** 문단 idx 의 글자 */
export const textAt = (l: ParaList, idx: number): string => {
  const p = l.get(idx);
  return p ? paraText(p).toString() : '';
};

export function connect(a: Pick<Peer, 'ydoc'>, b: Pick<Peer, 'ydoc'>): () => void {
  const sync = (from: Y.Doc, to: Y.Doc): void => Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)));
  return () => {
    sync(a.ydoc, b.ydoc);
    sync(b.ydoc, a.ydoc);
  };
}

/** rHWP 문서에서 읽은 실제 상태 (글자 + 글자모양 속성 요약) */
export function hwpState(peer: Peer): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const a = peer.rec.adapter;
  for (const key of peer.lists.keys()) {
    const ref = peer.rec.ref(key);
    if (!ref) continue;
    const paras: string[] = [];
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

export function yTexts(peer: Pick<Peer, 'lists'>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [key, arr] of peer.lists) out[key] = arr.map((p) => paraText(p).toString());
  return out;
}
