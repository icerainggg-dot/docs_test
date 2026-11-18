// Y 문서(정본) → rHWP 문서 맞추기.
//
// 편집은 전부 Y 문서에 대한 연산으로 이루어지고, Reconciler 가 바뀐 문단만 골라
// rHWP 문서를 Y 상태와 같게 만든다. 연산을 재생하는 대신 "상태를 맞추는" 방식이라
// 실시간 편집, 늦게 들어온 참여자, 실행 취소, 서버의 저장 워커가 모두 같은 코드를 쓴다.
//
// rHWP 쪽에서 쓰는 연산은 네 가지뿐이다.
//   - 문단 안 글자 넣기/지우기
//   - 빈 문단 만들기
//   - 문단 지우기
//   - 글자모양 번호 복원 + 덧입힌 서식 적용
// 그래서 표·그림 같은 개체는 원래 문단에서 움직이지 않는다.

import type * as Y from 'yjs';
import type { HwpDocument } from '@rhwp/core';
import { HwpAdapter, bodyRef, cellRef, overlayToProps, OVERLAY_KEYS } from './hwp-adapter.ts';
import type { ListRef, TextAttrs } from './hwp-adapter.ts';
import { getLists, scanDocument, parseKey, isBodyKey, paraId, paraText, paraCs, textDelta } from './model.ts';
import type { DeltaInsert, Lists, Para } from './model.ts';

/** listKey → 바뀐 문단 id 들 (null 이면 리스트 전체) */
export type Changes = Map<string, Set<string> | null>;

/** 서식이 같은 글자 구간. k 는 서식 비교용 열쇠. */
export interface FmtRun {
  len: number;
  k: string;
}

interface AttrRun extends FmtRun {
  attrs: TextAttrs;
}

/** rHWP 문서의 현재 모습: 문단 id 순서와 문단별 서식 구간 */
interface Mirror {
  ids: string[];
  fmt: Map<string, FmtRun[]>;
}

export type Diff =
  | { key: string; error: string }
  | { key: string; paragraphs: [number, number] }
  | { key: string; para: number; got: string; want: string };

const fmtKey = (a: TextAttrs): string => {
  let k = a.cs === undefined || a.cs === null ? '' : String(a.cs);
  for (const key of OVERLAY_KEYS) {
    const v = a[key];
    k += '|' + (v === undefined || v === null ? '' : String(v));
  }
  return k;
};

/** Y.Text delta → 병합된 서식 구간과 전체 텍스트 */
export function deltaToRuns(delta: DeltaInsert[]): { text: string; runs: AttrRun[] } {
  const runs: AttrRun[] = [];
  let text = '';
  for (const op of delta) {
    if (!op.insert.length) continue;
    const attrs = op.attributes || {};
    const k = fmtKey(attrs);
    text += op.insert;
    const last = runs[runs.length - 1];
    if (last && last.k === k) last.len += op.insert.length;
    else runs.push({ len: op.insert.length, k, attrs });
  }
  return { text, runs };
}

function commonRunPrefix(a: FmtRun[], b: FmtRun[]): number {
  let n = 0;
  for (let i = 0; i < a.length && i < b.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.k !== y.k) break;
    if (x.len !== y.len) return n + Math.min(x.len, y.len);
    n += x.len;
  }
  return n;
}

function commonRunSuffix(a: FmtRun[], b: FmtRun[]): number {
  let n = 0;
  for (let i = a.length - 1, j = b.length - 1; i >= 0 && j >= 0; i--, j--) {
    const x = a[i]!;
    const y = b[j]!;
    if (x.k !== y.k) break;
    if (x.len !== y.len) return n + Math.min(x.len, y.len);
    n += x.len;
  }
  return n;
}

const isHigh = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;

export class Reconciler {
  readonly adapter: HwpAdapter;
  readonly ydoc: Y.Doc;
  readonly lists: Lists;
  /** listKey → rHWP 문서의 현재 모습 */
  readonly mirror = new Map<string, Mirror>();
  readonly warnings: string[] = [];

  constructor(hwpDoc: HwpDocument, ydoc: Y.Doc) {
    this.adapter = new HwpAdapter(hwpDoc);
    this.ydoc = ydoc;
    this.lists = getLists(ydoc);
    for (const l of scanDocument(this.adapter)) {
      const fmt = new Map<string, FmtRun[]>();
      for (const p of l.paras) {
        fmt.set(p.id, p.runs.filter((r) => r.len > 0).map((r) => ({ len: r.len, k: fmtKey({ cs: r.cs }) })));
      }
      this.mirror.set(l.key, { ids: l.paras.map((p) => p.id), fmt });
    }
  }

  /** listKey → rHWP 위치. 표를 품은 문단이 없어졌으면 null. */
  ref(key: string): ListRef | null {
    const k = parseKey(key);
    if (k.type === 'body') return bodyRef(k.sec);
    for (const [bk, m] of this.mirror) {
      const b = parseKey(bk);
      if (b.type !== 'body') continue;
      const idx = m.ids.indexOf(k.ownerId);
      if (idx >= 0) return cellRef(b.sec, idx, k.ctrl, k.cell);
    }
    return null;
  }

  ids(key: string): string[] {
    return this.mirror.get(key)?.ids ?? [];
  }

  indexOf(key: string, id: string): number {
    return this.ids(key).indexOf(id);
  }

  /** 모든 리스트를 Y 상태와 맞춘다 (처음 열 때, 저장 워커). */
  syncAll(): void {
    const changes: Changes = new Map();
    for (const key of this.lists.keys()) changes.set(key, null);
    this.sync(changes);
  }

  /** @returns rHWP 문서가 바뀌었는지 */
  sync(changes: Changes): boolean {
    let touched = false;
    // 셀의 위치는 본문 문단 번호에 달려 있으므로 본문을 먼저 맞춘다.
    const keys = [...changes.keys()].sort((a, b) => Number(isBodyKey(b)) - Number(isBodyKey(a)));
    for (const key of keys) {
      if (this.syncList(key, changes.get(key) ?? null)) touched = true;
    }
    return touched;
  }

  private syncList(key: string, changedIds: Set<string> | null): boolean {
    const arr = this.lists.get(key);
    const m = this.mirror.get(key);
    if (!arr || !m) return false;
    const ref = this.ref(key);
    if (!ref) return false;
    const a = this.adapter;
    let touched = false;

    const paras = arr.toArray();
    const target = paras.map(paraId);
    const targetSet = new Set(target);
    const fresh = new Set<string>();

    // 1) 없어진 문단 지우기 (뒤에서부터)
    for (let i = m.ids.length - 1; i >= 0; i--) {
      const id = m.ids[i]!;
      if (targetSet.has(id)) continue;
      if (i === 0) {
        // 리스트의 첫 문단은 편집 규칙상 지워지지 않는다. 방어적으로 비우기만 한다.
        this.warnings.push(`첫 문단 삭제 요청 무시: ${key}`);
        continue;
      }
      a.removePara(ref, i);
      m.fmt.delete(id);
      m.ids.splice(i, 1);
      touched = true;
    }

    // 2) 새 문단 만들기
    const known = new Set(m.ids);
    for (let j = 0; j < target.length; j++) {
      const id = target[j]!;
      if (m.ids[j] === id) continue;
      if (known.has(id)) {
        // 순서 바뀜은 모델에 없는 연산이다.
        this.warnings.push(`문단 순서 불일치: ${key}`);
        break;
      }
      if (j === 0) {
        // 편집 규칙상 생기지 않는 경우(새 문단은 늘 기존 문단 뒤에 생긴다).
        this.warnings.push(`리스트 맨 앞 문단 삽입 무시: ${key}`);
        break;
      }
      a.insertParaAfter(ref, j - 1);
      m.ids.splice(j, 0, id);
      m.fmt.set(id, []);
      known.add(id);
      fresh.add(id);
      touched = true;
    }

    // 3) 문단 내용 맞추기
    for (let idx = 0; idx < target.length; idx++) {
      const id = target[idx]!;
      if (m.ids[idx] !== id) break; // 구조가 어긋났으면 더 진행하지 않는다.
      if (changedIds && !changedIds.has(id) && !fresh.has(id)) continue;
      if (this.syncPara(ref, idx, id, paras[idx]!, m)) touched = true;
    }
    return touched;
  }

  private syncPara(ref: ListRef, idx: number, id: string, para: Para, m: Mirror): boolean {
    const a = this.adapter;
    const { text: next, runs } = deltaToRuns(textDelta(paraText(para)));
    const cur = a.text(ref, idx);
    const baseCs = paraCs(para);
    let touched = false;

    // 글자: 공통 머리/꼬리를 뺀 가운데만 바꾼다.
    let tp = next.length;
    let ts = next.length;
    if (cur !== next) {
      const max = Math.min(cur.length, next.length);
      let p = 0;
      while (p < max && cur.charCodeAt(p) === next.charCodeAt(p)) p++;
      if (p > 0 && isHigh(cur.charCodeAt(p - 1))) p--;
      let s = 0;
      while (s < max - p && cur.charCodeAt(cur.length - 1 - s) === next.charCodeAt(next.length - 1 - s)) s++;
      if (s > 0 && isLow(next.charCodeAt(next.length - s))) s--;
      const del = cur.length - p - s;
      if (del > 0) a.deleteText(ref, idx, p, del);
      const ins = next.slice(p, next.length - s);
      if (ins) a.insertText(ref, idx, p, ins);
      tp = p;
      ts = s;
      touched = true;
    }

    // 서식: 글자나 서식이 달라진 범위에만 글자모양을 다시 입힌다.
    const prev = m.fmt.get(id) || [];
    const start = Math.min(tp, commonRunPrefix(prev, runs));
    const end = next.length - Math.min(ts, commonRunSuffix(prev, runs));
    if (start < end) {
      let pos = 0;
      for (const r of runs) {
        const rs = Math.max(pos, start);
        const re = Math.min(pos + r.len, end);
        pos += r.len;
        if (rs >= re) continue;
        // 글자모양 번호가 빠진 글자는 문단의 기본 글자모양을 쓴다 (결과가 Y 상태만으로 정해지도록).
        const cs = r.attrs.cs ?? baseCs;
        if (cs !== undefined && cs !== null) a.setShape(ref, idx, rs, re, cs);
        const props = overlayToProps(r.attrs);
        if (props) a.applyFormat(ref, idx, rs, re, props);
        touched = true;
      }
    }
    m.fmt.set(id, runs.map((r) => ({ len: r.len, k: r.k })));
    return touched;
  }

  /** rHWP 문서의 글자가 Y 상태와 같은지 확인한다. 다른 곳의 목록을 돌려준다. */
  verify(): Diff[] {
    const diffs: Diff[] = [];
    for (const [key, arr] of this.lists) {
      const ref = this.ref(key);
      if (!ref || !this.mirror.has(key)) continue;
      const want = arr.map((p) => paraText(p).toString());
      let n: number;
      try {
        n = this.adapter.paraCount(ref);
      } catch (e) {
        diffs.push({ key, error: String(e) });
        continue;
      }
      if (n !== want.length) {
        diffs.push({ key, paragraphs: [n, want.length] });
        continue;
      }
      want.forEach((w, i) => {
        const got = this.adapter.text(ref, i);
        if (got !== w) diffs.push({ key, para: i, got, want: w });
      });
    }
    return diffs;
  }
}

/**
 * Y 문서의 변경을 모아 Reconciler 에 넘길 형태로 만든다.
 * observeDeep 이벤트 → Map<listKey, Set<paraId>>
 */
export function collectChanges(events: Y.YEvent<Y.AbstractType<unknown>>[], into: Changes = new Map()): Changes {
  const first = events[0];
  if (!first) return into;
  const lists = getLists(first.transaction.doc);
  for (const ev of events) {
    let t: Y.AbstractType<unknown> | null = ev.target;
    if (t === lists) {
      // 리스트 자체가 생기거나 없어짐
      for (const key of ev.keys.keys()) into.set(key, null);
      continue;
    }
    // 대상에서 위로 올라가며 문단 리스트(lists 의 바로 아래)를 찾는다.
    let below: Y.AbstractType<unknown> | null = null;
    while (t && t.parent !== lists) {
      below = t;
      t = t.parent as Y.AbstractType<unknown> | null;
    }
    if (!t) continue;
    const key = t._item?.parentSub;
    if (!key) continue;
    if (into.has(key) && into.get(key) === null) continue;
    let set = into.get(key);
    if (!set) into.set(key, (set = new Set()));
    // below 는 문단(Y.Map)이거나 그 안의 Y.Text 다.
    if (below) {
      const para = (below.parent === t ? below : below.parent) as Para | null;
      const id = para?.get('id');
      if (typeof id === 'string') set.add(id);
    }
  }
  return into;
}
