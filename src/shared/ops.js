// 편집 연산 — 모두 Y 문서에 대한 연산이다. (rHWP 반영은 Reconciler 가 한다.)
//
// 위치는 (list: Y.Array, idx: 문단 번호, off: 글자 위치) 로 나타낸다.

import { makePara, newParaId } from './model.js';

export const LOCAL = { local: true }; // 내 편집임을 나타내는 트랜잭션 origin

const textOf = (list, idx) => list.get(idx).get('t');

/** delta 를 [from, to) 범위로 자른다. */
export function sliceDelta(delta, from, to = Infinity) {
  const out = [];
  let pos = 0;
  for (const op of delta) {
    if (typeof op.insert !== 'string') continue;
    const s = Math.max(from, pos);
    const e = Math.min(to, pos + op.insert.length);
    if (s < e) {
      const piece = { insert: op.insert.slice(s - pos, e - pos) };
      if (op.attributes) piece.attributes = { ...op.attributes };
      out.push(piece);
    }
    pos += op.insert.length;
  }
  return out;
}

/** off 위치에 글자를 넣을 때 물려받을 서식. 앞 글자(없으면 뒤 글자, 빈 문단이면 문단 기본) 기준. */
export function attrsAt(para, off) {
  const delta = para.get('t').toDelta();
  let pos = 0;
  let first = null;
  for (const op of delta) {
    if (typeof op.insert !== 'string') continue;
    first ??= op.attributes || {};
    if (off > pos && off <= pos + op.insert.length) return { ...(op.attributes || {}) };
    pos += op.insert.length;
  }
  if (first) return { ...first };
  const cs = para.get('cs');
  return cs === undefined ? {} : { cs };
}

export function insertText(list, idx, off, text, attrs) {
  const para = list.get(idx);
  para.get('t').insert(off, text, attrs ?? attrsAt(para, off));
  return { idx, off: off + text.length };
}

/** 문단을 가른다. 새 문단(idx+1)의 맨 앞이 새 위치. */
export function splitPara(list, idx, off) {
  const para = list.get(idx);
  const t = para.get('t');
  const tail = sliceDelta(t.toDelta(), off);
  const cs = attrsAt(para, off).cs ?? para.get('cs');
  if (t.length > off) t.delete(off, t.length - off);
  list.insert(idx + 1, [makePara(newParaId(), cs, tail)]);
  return { idx: idx + 1, off: 0 };
}

function appendDelta(t, delta) {
  if (!delta.length) return;
  const ops = t.length ? [{ retain: t.length }] : [];
  for (const op of delta) ops.push({ insert: op.insert, attributes: op.attributes || {} });
  t.applyDelta(ops);
}

/** 문단 idx 를 앞 문단에 합친다. */
export function mergeWithPrev(list, idx) {
  const prev = textOf(list, idx - 1);
  const off = prev.length;
  appendDelta(prev, sliceDelta(textOf(list, idx).toDelta(), 0));
  list.delete(idx, 1);
  return { idx: idx - 1, off };
}

/**
 * 범위 삭제. canRemove(idx) 가 false 인 문단(표·그림을 품은 문단)이 끼어 있으면
 * 문단은 그대로 두고 글자만 지운다.
 */
export function deleteRange(list, i1, o1, i2, o2, canRemove = () => true) {
  if (i1 === i2) {
    if (o2 > o1) textOf(list, i1).delete(o1, o2 - o1);
    return { idx: i1, off: o1 };
  }
  let removable = true;
  for (let i = i1 + 1; i <= i2; i++) if (!canRemove(i)) removable = false;

  const first = textOf(list, i1);
  if (first.length > o1) first.delete(o1, first.length - o1);
  if (removable) {
    appendDelta(first, sliceDelta(textOf(list, i2).toDelta(), o2));
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
export function formatRange(list, i1, o1, i2, o2, attrs) {
  for (let i = i1; i <= i2; i++) {
    const t = textOf(list, i);
    const s = i === i1 ? o1 : 0;
    const e = i === i2 ? o2 : t.length;
    if (e > s) t.format(s, e - s, attrs);
  }
}

/** 범위 안의 모든 글자가 attr === value 인지 (서식 켬/끔 판단용) */
export function rangeHasAttr(list, i1, o1, i2, o2, attr, value = true) {
  let any = false;
  for (let i = i1; i <= i2; i++) {
    const t = textOf(list, i);
    const s = i === i1 ? o1 : 0;
    const e = i === i2 ? o2 : t.length;
    for (const op of sliceDelta(t.toDelta(), s, e)) {
      any = true;
      if ((op.attributes || {})[attr] !== value) return false;
    }
  }
  return any;
}

/** 범위의 글자를 일반 텍스트로 (문단은 \n 으로 구분) */
export function rangeText(list, i1, o1, i2, o2) {
  const parts = [];
  for (let i = i1; i <= i2; i++) {
    const s = textOf(list, i).toString();
    parts.push(s.slice(i === i1 ? o1 : 0, i === i2 ? o2 : s.length));
  }
  return parts.join('\n');
}

/** 여러 줄 텍스트 붙여넣기 */
export function insertLines(list, idx, off, text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let pos = { idx, off };
  lines.forEach((line, n) => {
    if (n > 0) pos = splitPara(list, pos.idx, pos.off);
    // 제어 문자는 문단에 넣을 수 없다 (탭은 허용).
    const clean = line.replace(/[\u0000-\u0008\u000b-\u001f]/g, '');
    if (clean) pos = insertText(list, pos.idx, pos.off, clean);
  });
  return pos;
}
