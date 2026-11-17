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

import { HwpAdapter, bodyRef, cellRef, overlayToProps, OVERLAY_KEYS } from './hwp-adapter.js';
import { getLists, scanDocument, parseKey, isBodyKey } from './model.js';

const fmtKey = (a) => {
  let k = a.cs === undefined || a.cs === null ? '' : String(a.cs);
  for (const key of OVERLAY_KEYS) {
    const v = a[key];
    k += '|' + (v === undefined || v === null ? '' : String(v));
  }
  return k;
};

/** Y.Text delta → 병합된 서식 구간 [{len, k, attrs}] 과 전체 텍스트 */
export function deltaToRuns(delta) {
  const runs = [];
  let text = '';
  for (const op of delta) {
    if (typeof op.insert !== 'string' || !op.insert.length) continue;
    const attrs = op.attributes || {};
    const k = fmtKey(attrs);
    text += op.insert;
    const last = runs[runs.length - 1];
    if (last && last.k === k) last.len += op.insert.length;
    else runs.push({ len: op.insert.length, k, attrs });
  }
  return { text, runs };
}

function commonRunPrefix(a, b) {
  let n = 0;
  for (let i = 0; i < a.length && i < b.length; i++) {
    if (a[i].k !== b[i].k) break;
    if (a[i].len !== b[i].len) return n + Math.min(a[i].len, b[i].len);
    n += a[i].len;
  }
  return n;
}

function commonRunSuffix(a, b) {
  let n = 0;
  for (let i = a.length - 1, j = b.length - 1; i >= 0 && j >= 0; i--, j--) {
    if (a[i].k !== b[j].k) break;
    if (a[i].len !== b[j].len) return n + Math.min(a[i].len, b[j].len);
    n += a[i].len;
  }
  return n;
}

const isHigh = (c) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c) => c >= 0xdc00 && c <= 0xdfff;

export class Reconciler {
  constructor(hwpDoc, ydoc) {
    this.adapter = new HwpAdapter(hwpDoc);
    this.ydoc = ydoc;
    this.lists = getLists(ydoc);
    /** listKey → { ids: string[], fmt: Map<paraId, runs> } — rHWP 문서의 현재 모습 */
    this.mirror = new Map();
    this.warnings = [];
    for (const l of scanDocument(this.adapter)) {
      const fmt = new Map();
      for (const p of l.paras) {
        fmt.set(p.id, p.runs.filter((r) => r.len > 0).map((r) => ({ len: r.len, k: fmtKey({ cs: r.cs }) })));
      }
      this.mirror.set(l.key, { ids: l.paras.map((p) => p.id), fmt });
    }
  }

  /** listKey → rHWP 위치. 표를 품은 문단이 없어졌으면 null. */
  ref(key) {
    const k = parseKey(key);
    if (k.type === 'body') return bodyRef(k.sec);
    for (const [bk, m] of this.mirror) {
      if (!isBodyKey(bk)) continue;
      const idx = m.ids.indexOf(k.ownerId);
      if (idx >= 0) return cellRef(parseKey(bk).sec, idx, k.ctrl, k.cell);
    }
    return null;
  }

  ids(key) {
    return this.mirror.get(key)?.ids ?? [];
  }

  indexOf(key, id) {
    return this.ids(key).indexOf(id);
  }

  /** 모든 리스트를 Y 상태와 맞춘다 (처음 열 때, 저장 워커). */
  syncAll() {
    const changes = new Map();
    for (const key of this.lists.keys()) changes.set(key, null);
    this.sync(changes);
  }

  /**
   * @param {Map<string, Set<string>|null>} changes  listKey → 바뀐 문단 id (null 이면 전부)
   * @returns {boolean} rHWP 문서가 바뀌었는지
   */
  sync(changes) {
    let touched = false;
    // 셀의 위치는 본문 문단 번호에 달려 있으므로 본문을 먼저 맞춘다.
    const keys = [...changes.keys()].sort((a, b) => Number(isBodyKey(b)) - Number(isBodyKey(a)));
    for (const key of keys) {
      if (this.syncList(key, changes.get(key))) touched = true;
    }
    return touched;
  }

  syncList(key, changedIds) {
    const arr = this.lists.get(key);
    const m = this.mirror.get(key);
    if (!arr || !m) return false;
    const ref = this.ref(key);
    if (!ref) return false;
    const a = this.adapter;
    let touched = false;

    const paras = arr.toArray();
    const target = paras.map((p) => p.get('id'));
    const targetSet = new Set(target);
    const fresh = new Set();

    // 1) 없어진 문단 지우기 (뒤에서부터)
    for (let i = m.ids.length - 1; i >= 0; i--) {
      if (targetSet.has(m.ids[i])) continue;
      if (i === 0) {
        // 리스트의 첫 문단은 편집 규칙상 지워지지 않는다. 방어적으로 비우기만 한다.
        this.warnings.push(`첫 문단 삭제 요청 무시: ${key}`);
        continue;
      }
      a.removePara(ref, i);
      m.fmt.delete(m.ids[i]);
      m.ids.splice(i, 1);
      touched = true;
    }

    // 2) 새 문단 만들기 — 앞 문단의 끝에서 갈라 빈 문단을 얻는다.
    const known = new Set(m.ids);
    for (let j = 0; j < target.length; j++) {
      if (m.ids[j] === target[j]) continue;
      if (known.has(target[j])) {
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
      m.ids.splice(j, 0, target[j]);
      m.fmt.set(target[j], []);
      known.add(target[j]);
      fresh.add(target[j]);
      touched = true;
    }

    // 3) 문단 내용 맞추기
    for (let idx = 0; idx < target.length; idx++) {
      const id = target[idx];
      if (m.ids[idx] !== id) break; // 구조가 어긋났으면 더 진행하지 않는다.
      if (changedIds && !changedIds.has(id) && !fresh.has(id)) continue;
      if (this.syncPara(ref, idx, id, paras[idx], m)) touched = true;
    }
    return touched;
  }

  syncPara(ref, idx, id, para, m) {
    const a = this.adapter;
    const { text: next, runs } = deltaToRuns(para.get('t').toDelta());
    const cur = a.text(ref, idx);
    const baseCs = para.get('cs');
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
  verify() {
    const diffs = [];
    for (const [key, arr] of this.lists) {
      const ref = this.ref(key);
      if (!ref || !this.mirror.has(key)) continue;
      const want = arr.map((p) => p.get('t').toString());
      let n;
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
      for (let i = 0; i < n; i++) {
        const got = this.adapter.text(ref, i);
        if (got !== want[i]) diffs.push({ key, para: i, got, want: want[i] });
      }
    }
    return diffs;
  }
}

/**
 * Y 문서의 변경을 모아 Reconciler 에 넘길 형태로 만든다.
 * observeDeep 이벤트 → Map<listKey, Set<paraId>>
 */
export function collectChanges(events, into = new Map()) {
  const lists = events[0]?.transaction.doc.getMap('lists');
  for (const ev of events) {
    let t = ev.target;
    if (t === lists) {
      // 리스트 자체가 생기거나 없어짐
      for (const key of ev.keysChanged) if (!into.has(key)) into.set(key, null);
      continue;
    }
    // 대상에서 위로 올라가며 문단(Y.Map)과 리스트(Y.Array)를 찾는다.
    let para = null;
    while (t && t.parent !== lists) {
      para = t;
      t = t.parent;
    }
    if (!t) continue;
    const key = t._item?.parentSub;
    if (!key) continue;
    if (into.get(key) === null && into.has(key)) continue;
    let set = into.get(key);
    if (!set) into.set(key, (set = new Set()));
    // para 는 Y.Text 일 수도 있다 → 한 단계 위가 문단 맵
    if (para) {
      const map = para.parent === t ? para : para.parent;
      const id = map?.get?.('id');
      if (id) set.add(id);
    }
  }
  return into;
}
