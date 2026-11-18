// 편집 연산 — 모두 Y 문서에 대한 연산이다. (rHWP 반영은 Reconciler 가 한다.)
//
// 위치는 (list: 문단 리스트, idx: 문단 번호, off: 글자 위치) 로 나타낸다.

import type * as Y from 'yjs';
import { makePara, newParaId, paraText, paraCs, textDelta } from './model.ts';
import type { DeltaInsert, Para, ParaList } from './model.ts';
import type { OverlayKey, TextAttrs } from './hwp-adapter.ts';

/** 내 편집임을 나타내는 트랜잭션 origin (실행 취소 대상) */
export const LOCAL = { local: true } as const;

/** 리스트 안의 위치 */
export interface Pos {
  idx: number;
  off: number;
}

const para = (list: ParaList, idx: number): Para => {
  const p = list.get(idx);
  if (!p) throw new RangeError(`문단 ${idx} 이(가) 없습니다.`);
  return p;
};
const textOf = (list: ParaList, idx: number): Y.Text => paraText(para(list, idx));

/** delta 를 [from, to) 범위로 자른다. */
export function sliceDelta(delta: DeltaInsert[], from: number, to = Infinity): DeltaInsert[] {
  const out: DeltaInsert[] = [];
  let pos = 0;
  for (const op of delta) {
    const s = Math.max(from, pos);
    const e = Math.min(to, pos + op.insert.length);
    if (s < e) {
      const piece: DeltaInsert = { insert: op.insert.slice(s - pos, e - pos) };
      if (op.attributes) piece.attributes = { ...op.attributes };
      out.push(piece);
    }
    pos += op.insert.length;
  }
  return out;
}

/** off 위치에 글자를 넣을 때 물려받을 서식. 앞 글자(없으면 뒤 글자, 빈 문단이면 문단 기본) 기준. */
export function attrsAt(p: Para, off: number): TextAttrs {
  let pos = 0;
  let first: TextAttrs | null = null;
  for (const op of textDelta(paraText(p))) {
    first ??= op.attributes || {};
    if (off > pos && off <= pos + op.insert.length) return { ...(op.attributes || {}) };
    pos += op.insert.length;
  }
  if (first) return { ...first };
  const cs = paraCs(p);
  return cs === undefined ? {} : { cs };
}

export function insertText(list: ParaList, idx: number, off: number, text: string, attrs?: TextAttrs): Pos {
  const p = para(list, idx);
  paraText(p).insert(off, text, { ...(attrs ?? attrsAt(p, off)) });
  return { idx, off: off + text.length };
}

/** 문단을 가른다. 새 문단(idx+1)의 맨 앞이 새 위치. */
export function splitPara(list: ParaList, idx: number, off: number): Pos {
  const p = para(list, idx);
  const t = paraText(p);
  const tail = sliceDelta(textDelta(t), off);
  const cs = attrsAt(p, off).cs ?? paraCs(p);
  if (t.length > off) t.delete(off, t.length - off);
  list.insert(idx + 1, [makePara(newParaId(), cs, tail)]);
  return { idx: idx + 1, off: 0 };
}

function appendDelta(t: Y.Text, delta: DeltaInsert[]): void {
  if (!delta.length) return;
  const ops: object[] = t.length ? [{ retain: t.length }] : [];
  for (const op of delta) ops.push({ insert: op.insert, attributes: op.attributes || {} });
  t.applyDelta(ops);
}

/** 문단 idx 를 앞 문단에 합친다. */
export function mergeWithPrev(list: ParaList, idx: number): Pos {
  const prev = textOf(list, idx - 1);
  const off = prev.length;
  appendDelta(prev, textDelta(textOf(list, idx)));
  list.delete(idx, 1);
  return { idx: idx - 1, off };
}

/**
 * 범위 삭제. canRemove(idx) 가 false 인 문단(표·그림을 품은 문단)이 끼어 있으면
 * 문단은 그대로 두고 글자만 지운다.
 */
export function deleteRange(
  list: ParaList,
  i1: number,
  o1: number,
  i2: number,
  o2: number,
  canRemove: (idx: number) => boolean = () => true,
): Pos {
  if (i1 === i2) {
    if (o2 > o1) textOf(list, i1).delete(o1, o2 - o1);
    return { idx: i1, off: o1 };
  }
  let removable = true;
  for (let i = i1 + 1; i <= i2; i++) if (!canRemove(i)) removable = false;

  const first = textOf(list, i1);
  if (first.length > o1) first.delete(o1, first.length - o1);
  if (removable) {
    appendDelta(first, sliceDelta(textDelta(textOf(list, i2)), o2));
    list.delete(i1 + 1, i2 - i1);
  } else {
    for (let i = i1 + 1; i < i2; i++) {
      const t = textOf(list, i);
      if (t.length) t.delete(0, t.length);
    }
    if (o2 > 0) textOf(list, i2).delete(0, o2);
  }
  return { idx: i1, off: o1 };
}

/** 범위에 덧입힌 서식을 적용한다. attrs 예: { b: true } */
export function formatRange(list: ParaList, i1: number, o1: number, i2: number, o2: number, attrs: TextAttrs): void {
  for (let i = i1; i <= i2; i++) {
    const t = textOf(list, i);
    const s = i === i1 ? o1 : 0;
    const e = i === i2 ? o2 : t.length;
    if (e > s) t.format(s, e - s, { ...attrs });
  }
}

/** 범위 안의 모든 글자가 attr === value 인지 (서식 켬/끔 판단용) */
export function rangeHasAttr(
  list: ParaList,
  i1: number,
  o1: number,
  i2: number,
  o2: number,
  attr: OverlayKey,
  value: boolean | string = true,
): boolean {
  let any = false;
  for (let i = i1; i <= i2; i++) {
    const t = textOf(list, i);
    const s = i === i1 ? o1 : 0;
    const e = i === i2 ? o2 : t.length;
    for (const op of sliceDelta(textDelta(t), s, e)) {
      any = true;
      if ((op.attributes || {})[attr] !== value) return false;
    }
  }
  return any;
}

/** 범위의 글자를 일반 텍스트로 (문단은 \n 으로 구분) */
export function rangeText(list: ParaList, i1: number, o1: number, i2: number, o2: number): string {
  const parts: string[] = [];
  for (let i = i1; i <= i2; i++) {
    const s = textOf(list, i).toString();
    parts.push(s.slice(i === i1 ? o1 : 0, i === i2 ? o2 : s.length));
  }
  return parts.join('\n');
}

/** 여러 줄 텍스트 붙여넣기 */
export function insertLines(list: ParaList, idx: number, off: number, text: string): Pos {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let pos: Pos = { idx, off };
  lines.forEach((line, n) => {
    if (n > 0) pos = splitPara(list, pos.idx, pos.off);
    // 제어 문자는 문단에 넣을 수 없다 (탭은 허용).
    const clean = line.replace(/[\u0000-\u0008\u000b-\u001f]/g, '');
    if (clean) pos = insertText(list, pos.idx, pos.off, clean);
  });
  return pos;
}
