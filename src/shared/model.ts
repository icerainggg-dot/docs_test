// 동시편집 데이터 모델 (Yjs).
//
//   ydoc.getMap('lists') : Y.Map<listKey, Y.Array<Para>>
//   Para                 : Y.Map { id: string, cs?: number, t: Y.Text }
//
// listKey
//   - 본문 구역  : "s<구역번호>"
//   - 표 셀      : "c|<표를 품은 문단 id>|<컨트롤 번호>|<셀 번호>"
//
// Y.Text 의 글자 속성 (TextAttrs)
//   - cs            : 원본 문서의 글자모양(CharShape) 번호. 모든 참여자가 같은 원본을
//                     열기 때문에 이 번호만으로 글꼴·크기·색 등이 정확히 복원된다.
//   - b, i, u, s, col : 동시편집 중에 덧입힌 서식(굵게/기울임/밑줄/취소선/글자색)
//
// 문단 id 는 원본 문단이면 "<listKey>p<번호>" 로 결정적이고, 새 문단은 임의 문자열이다.

import * as Y from 'yjs';
import type { HwpDocument } from '@rhwp/core';
import { HwpAdapter, bodyRef, cellRef } from './hwp-adapter.ts';
import type { ListRef, ShapeRun, TextAttrs } from './hwp-adapter.ts';

export const LISTS = 'lists';

export type Para = Y.Map<string | number | Y.Text>;
export type ParaList = Y.Array<Para>;
export type Lists = Y.Map<ParaList>;

/** Y.Text delta 의 글자 넣기 연산 */
export interface DeltaInsert {
  insert: string;
  attributes?: TextAttrs;
}

export type ListKey =
  | { type: 'body'; sec: number }
  | { type: 'cell'; ownerId: string; ctrl: number; cell: number };

export const bodyKey = (sec: number): string => `s${sec}`;
export const cellKey = (ownerId: string, ctrl: number, cell: number): string => `c|${ownerId}|${ctrl}|${cell}`;

export function parseKey(key: string): ListKey {
  if (key[0] === 's') return { type: 'body', sec: Number(key.slice(1)) };
  const [, ownerId = '', ctrl, cell] = key.split('|');
  return { type: 'cell', ownerId, ctrl: Number(ctrl), cell: Number(cell) };
}

export const isBodyKey = (key: string): boolean => key[0] === 's';

// ── 문단 읽기 ──

export const paraId = (p: Para): string => p.get('id') as string;
export const paraText = (p: Para): Y.Text => p.get('t') as Y.Text;
export const paraCs = (p: Para): number | undefined => p.get('cs') as number | undefined;

/** Y.Text 의 delta 를 글자 넣기 연산 배열로 (글자가 아닌 것은 뺀다) */
export function textDelta(t: Y.Text): DeltaInsert[] {
  return (t.toDelta() as { insert: unknown; attributes?: TextAttrs }[]).filter(
    (op): op is DeltaInsert => typeof op.insert === 'string',
  );
}

export function newParaId(): string {
  const bytes = new Uint8Array(9);
  globalThis.crypto.getRandomValues(bytes);
  let s = 'n';
  for (const b of bytes) s += b.toString(36).padStart(2, '0');
  return s;
}

export function makePara(id: string, cs: number | null | undefined, delta?: DeltaInsert[]): Para {
  const m: Para = new Y.Map();
  m.set('id', id);
  if (cs !== undefined && cs !== null) m.set('cs', cs);
  const t = new Y.Text();
  if (delta && delta.length) t.applyDelta(delta);
  m.set('t', t);
  return m;
}

export const getLists = (ydoc: Y.Doc): Lists => ydoc.getMap<ParaList>(LISTS);

/** Y.Array(문단 리스트)가 속한 listKey */
export const keyOfList = (arr: Y.AbstractType<any>): string | null => arr._item?.parentSub ?? null;

export interface ScannedPara {
  id: string;
  text: string;
  runs: ShapeRun[];
  cs: number | undefined;
}

export interface ScannedList {
  key: string;
  paras: ScannedPara[];
}

/**
 * rHWP 문서를 훑어 편집 가능한 문단 리스트를 모두 찾는다.
 * 서버의 초기 상태 만들기(seed)와 각 참여자의 대응표(mirror) 초기화가 같은 결과를
 * 내야 하므로 순서와 id 가 결정적이다.
 */
export function scanDocument(adapter: HwpAdapter): ScannedList[] {
  const out: ScannedList[] = [];
  const scanParas = (key: string, ref: ListRef): ScannedPara[] => {
    const n = adapter.paraCount(ref);
    const paras: ScannedPara[] = [];
    for (let i = 0; i < n; i++) {
      const len = adapter.paraLen(ref, i);
      let cs: number | undefined;
      try {
        cs = adapter.charProps(ref, i, len).charShapeId;
      } catch {
        cs = undefined;
      }
      paras.push({ id: `${key}p${i}`, text: adapter.text(ref, i), runs: adapter.runs(ref, i), cs });
    }
    return paras;
  };

  const secCount = adapter.sectionCount();
  for (let sec = 0; sec < secCount; sec++) {
    const key = bodyKey(sec);
    const ref = bodyRef(sec);
    const paras = scanParas(key, ref);
    out.push({ key, paras });
    paras.forEach((para, i) => {
      const ctrls = adapter.controlCount(ref, i);
      for (let c = 0; c < ctrls; c++) {
        const cells = adapter.tableCellCount(sec, i, c);
        for (let cell = 0; cell < cells; cell++) {
          const ckey = cellKey(para.id, c, cell);
          try {
            out.push({ key: ckey, paras: scanParas(ckey, cellRef(sec, i, c, cell)) });
          } catch {
            // 읽을 수 없는 셀은 편집 대상에서 뺀다.
          }
        }
      }
    });
  }
  return out;
}

export function runsToDelta(text: string, runs: ShapeRun[]): DeltaInsert[] {
  const delta: DeltaInsert[] = [];
  let pos = 0;
  for (const r of runs) {
    if (r.len <= 0) continue;
    delta.push({ insert: text.slice(pos, pos + r.len), attributes: { cs: r.cs } });
    pos += r.len;
  }
  if (pos < text.length) delta.push({ insert: text.slice(pos) });
  return delta;
}

/** 원본 HWP/HWPX 문서로부터 Y 문서의 초기 상태를 만든다 (문서당 한 번, 서버에서). */
export function seedYDoc(ydoc: Y.Doc, hwpDoc: HwpDocument): ScannedList[] {
  const scan = scanDocument(new HwpAdapter(hwpDoc));
  ydoc.transact(() => {
    const lists = getLists(ydoc);
    for (const l of scan) {
      const arr: ParaList = new Y.Array();
      lists.set(l.key, arr);
      arr.push(l.paras.map((p) => makePara(p.id, p.cs, runsToDelta(p.text, p.runs))));
    }
  }, 'seed');
  return scan;
}

/** 리스트의 문단 텍스트를 문자열 배열로 (검증·시험용) */
export function listTexts(arr: ParaList): string[] {
  return arr.map((p) => paraText(p).toString());
}
