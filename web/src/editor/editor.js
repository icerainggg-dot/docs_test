// 편집기 핵심: 선택 영역, 편집 명령, 한글 조합, 원격 변경 반영.
// 화면 그리기는 view.js, 키보드·마우스는 input.js 가 맡는다.

import * as Y from 'yjs';
import { Reconciler, collectChanges } from '../../../src/shared/reconciler.js';
import { getLists, keyOfList, bodyKey, cellKey, isBodyKey } from '../../../src/shared/model.js';
import * as ops from '../../../src/shared/ops.js';

const { LOCAL } = ops;
const NONE = 0xffffffff;
const COMPOSE_DEFER_MAX_MS = 2000;

export class Editor {
  constructor({ hwp, ydoc, awareness, user }) {
    this.hwp = hwp;
    this.ydoc = ydoc;
    this.awareness = awareness;
    this.lists = getLists(ydoc);
    this.rec = new Reconciler(hwp, ydoc);
    this.rec.syncAll();
    this.adapter = this.rec.adapter;

    this.undoManager = new Y.UndoManager(this.lists, { trackedOrigins: new Set([LOCAL]), captureTimeout: 600 });
    this.sel = null; // { anchor: RelativePosition, head: RelativePosition }
    this.preferredX = -1;
    this.composition = null; // { start: RelativePosition, len, attrs }
    this.pendingRemote = new Map();
    this.deferTimer = null;
    this.listeners = new Set();
    this.rev = 0; // rHWP 문서가 바뀔 때마다 올라간다

    this.onDeep = (events, tr) => this.handleChanges(events, tr);
    this.lists.observeDeep(this.onDeep);
    this.onAwareness = () => this.emit('awareness');
    awareness.on('change', this.onAwareness);
    awareness.setLocalStateField('user', user);

    this.setCaret(this.firstPos());
  }

  destroy() {
    this.lists.unobserveDeep(this.onDeep);
    this.awareness.off('change', this.onAwareness);
    this.undoManager.destroy();
    clearTimeout(this.deferTimer);
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(type) {
    for (const fn of this.listeners) fn(type);
  }

  // ── Y 변경 → rHWP ──────────────────────────────────────────

  handleChanges(events, tr) {
    if (tr.local) {
      // 내 편집(실행 취소 포함)은 바로 반영한다. 같은 리스트에 미뤄 둔 원격 변경도 함께.
      const changes = collectChanges(events);
      for (const [key, ids] of changes) {
        if (!this.pendingRemote.has(key)) continue;
        const pend = this.pendingRemote.get(key);
        if (ids === null || pend === null) changes.set(key, null);
        else for (const id of pend) ids.add(id);
        this.pendingRemote.delete(key);
      }
      this.apply(changes);
      return;
    }
    collectChanges(events, this.pendingRemote);
    if (this.composition) {
      // 한글 조합 중에는 다른 사람의 변경을 잠시 미뤘다가 조합이 끝나면 반영한다.
      this.deferTimer ??= setTimeout(() => this.flushRemote(), COMPOSE_DEFER_MAX_MS);
      return;
    }
    this.flushRemote();
  }

  flushRemote() {
    clearTimeout(this.deferTimer);
    this.deferTimer = null;
    if (!this.pendingRemote.size) return;
    const changes = this.pendingRemote;
    this.pendingRemote = new Map();
    this.apply(changes);
  }

  apply(changes) {
    try {
      if (this.rec.sync(changes)) this.rev++;
    } catch (e) {
      console.error('문서 반영 실패', e);
    }
    this.emit('doc');
  }

  // ── 위치 ───────────────────────────────────────────────────

  firstPos() {
    return { key: bodyKey(0), idx: 0, off: 0 };
  }

  list(key) {
    return this.lists.get(key);
  }

  textLen(key, idx) {
    return this.list(key).get(idx).get('t').length;
  }

  toRel(pos, assoc = 0) {
    const t = this.list(pos.key).get(pos.idx).get('t');
    return Y.createRelativePositionFromTypeIndex(t, Math.min(pos.off, t.length), assoc);
  }

  fromRel(rel) {
    if (!rel) return null;
    const abs = Y.createAbsolutePositionFromRelativePosition(rel, this.ydoc);
    if (!abs) return null;
    const text = abs.type;
    const para = text.parent;
    const list = para?.parent;
    if (!list || text._item?.deleted || para._item?.deleted || list._item?.deleted) return null;
    const key = keyOfList(list);
    if (!key || this.lists.get(key) !== list) return null;
    let idx = 0;
    for (const p of list) {
      if (p === para) return { key, idx, off: abs.index, id: para.get('id') };
      idx++;
    }
    return null;
  }

  /** 현재 선택 영역. 가리키던 문단이 없어졌으면 가까운 곳으로 옮긴다. */
  selection() {
    let head = this.fromRel(this.sel?.head);
    let anchor = this.fromRel(this.sel?.anchor);
    if (!head) {
      const last = this.lastHead;
      if (last && this.lists.has(last.key)) {
        const list = this.list(last.key);
        const idx = Math.min(last.idx, list.length - 1);
        head = { key: last.key, idx, off: Math.min(last.off, list.get(idx).get('t').length) };
      } else {
        head = this.firstPos();
      }
      anchor = head;
      this.sel = { anchor: this.toRel(head), head: this.toRel(head) };
    }
    if (!anchor || anchor.key !== head.key) anchor = head;
    this.lastHead = head;
    const forward = anchor.idx < head.idx || (anchor.idx === head.idx && anchor.off <= head.off);
    const [start, end] = forward ? [anchor, head] : [head, anchor];
    return { anchor, head, start, end, collapsed: anchor.idx === head.idx && anchor.off === head.off };
  }

  setSelection(anchor, head, { keepX = false } = {}) {
    if (anchor.key !== head.key) anchor = head;
    this.sel = { anchor: this.toRel(anchor), head: this.toRel(head) };
    this.lastHead = head;
    if (!keepX) this.preferredX = -1;
    this.publishSelection();
    this.emit('selection');
  }

  setCaret(pos, opts) {
    this.setSelection(pos, pos, opts);
  }

  moveHead(pos, extend, opts) {
    if (extend) {
      const { anchor } = this.selection();
      if (anchor.key !== pos.key) return; // 선택은 한 리스트(본문 또는 한 셀) 안에서만
      this.setSelection(anchor, pos, opts);
    } else {
      this.setCaret(pos, opts);
    }
  }

  publishSelection() {
    this.awareness.setLocalStateField('sel', {
      a: Y.relativePositionToJSON(this.sel.anchor),
      h: Y.relativePositionToJSON(this.sel.head),
    });
  }

  /** rHWP 쪽 위치(리스트 참조 + 문단 번호). 아직 반영되지 않은 문단이면 null. */
  hwpPos(pos) {
    const ref = this.rec.ref(pos.key);
    if (!ref) return null;
    const id = pos.id ?? this.list(pos.key).get(pos.idx)?.get('id');
    const idx = this.rec.indexOf(pos.key, id);
    if (idx < 0) return null;
    return { ref, idx, off: Math.min(pos.off, this.adapter.paraLen(ref, idx)) };
  }

  /** hitTest·moveVertical 결과 → 편집 위치 */
  posFromHit(h) {
    if (!h || h.sectionIndex === undefined) return null;
    let key;
    let idx;
    const inCell = h.parentParaIndex !== undefined && h.parentParaIndex !== null && h.parentParaIndex !== NONE;
    if (inCell) {
      if (h.cellPath && h.cellPath.length > 1) return null; // 표 안의 표는 아직 편집하지 않는다
      const ownerId = this.rec.ids(bodyKey(h.sectionIndex))[h.parentParaIndex];
      key = cellKey(ownerId, h.controlIndex, h.cellIndex);
      idx = h.cellParaIndex;
    } else {
      key = bodyKey(h.sectionIndex);
      idx = h.paragraphIndex;
    }
    const id = this.rec.ids(key)[idx];
    const list = this.lists.get(key);
    if (!list || id === undefined) return null;
    let yIdx = 0;
    for (const p of list) {
      if (p.get('id') === id) {
        return { key, idx: yIdx, off: Math.min(h.charOffset ?? 0, p.get('t').length), id };
      }
      yIdx++;
    }
    return null;
  }

  canRemove(key, idx) {
    if (!isBodyKey(key)) return true;
    const hp = this.hwpPos({ key, idx, off: 0 });
    if (!hp) return false;
    return this.adapter.controlCount(hp.ref, hp.idx) === 0; // 표·그림을 품은 문단은 지우지 않는다
  }

  // ── 편집 명령 ───────────────────────────────────────────────

  transact(fn) {
    let result;
    this.ydoc.transact(() => {
      result = fn();
    }, LOCAL);
    return result;
  }

  deleteSelectionIn(s) {
    const list = this.list(s.start.key);
    return ops.deleteRange(list, s.start.idx, s.start.off, s.end.idx, s.end.off, (i) => this.canRemove(s.start.key, i));
  }

  type(text) {
    if (!text) return;
    const s = this.selection();
    const key = s.start.key;
    const list = this.list(key);
    const p = this.transact(() => {
      const at = s.collapsed ? s.start : this.deleteSelectionIn(s);
      return ops.insertLines(list, at.idx, at.off, text);
    });
    this.setCaret({ key, ...p });
  }

  enter() {
    const s = this.selection();
    const key = s.start.key;
    const list = this.list(key);
    const p = this.transact(() => {
      const at = s.collapsed ? s.start : this.deleteSelectionIn(s);
      return ops.splitPara(list, at.idx, at.off);
    });
    this.setCaret({ key, ...p });
  }

  deleteSelection() {
    const s = this.selection();
    if (s.collapsed) return false;
    const p = this.transact(() => this.deleteSelectionIn(s));
    this.setCaret({ key: s.start.key, ...p });
    return true;
  }

  backspace() {
    if (this.deleteSelection()) return;
    const { head } = this.selection();
    const list = this.list(head.key);
    if (head.off > 0) {
      const str = list.get(head.idx).get('t').toString();
      const c = str.charCodeAt(head.off - 1);
      const n = head.off > 1 && c >= 0xdc00 && c <= 0xdfff ? 2 : 1;
      this.transact(() => ops.deleteRange(list, head.idx, head.off - n, head.idx, head.off));
      this.setCaret({ key: head.key, idx: head.idx, off: head.off - n });
    } else if (head.idx > 0 && this.canRemove(head.key, head.idx)) {
      const p = this.transact(() => ops.mergeWithPrev(list, head.idx));
      this.setCaret({ key: head.key, ...p });
    }
  }

  del() {
    if (this.deleteSelection()) return;
    const { head } = this.selection();
    const list = this.list(head.key);
    const str = list.get(head.idx).get('t').toString();
    if (head.off < str.length) {
      const c = str.charCodeAt(head.off);
      const n = c >= 0xd800 && c <= 0xdbff && head.off + 1 < str.length ? 2 : 1;
      this.transact(() => ops.deleteRange(list, head.idx, head.off, head.idx, head.off + n));
      this.setCaret(head);
    } else if (head.idx < list.length - 1 && this.canRemove(head.key, head.idx + 1)) {
      this.transact(() => ops.mergeWithPrev(list, head.idx + 1));
      this.setCaret(head);
    }
  }

  /** 덧입힌 서식 켬/끔. 예: toggleFormat('b') */
  toggleFormat(attr) {
    const s = this.selection();
    if (s.collapsed) return false;
    const list = this.list(s.start.key);
    const on = !ops.rangeHasAttr(list, s.start.idx, s.start.off, s.end.idx, s.end.off, attr, true);
    this.undoManager.stopCapturing(); // 서식 변경은 앞선 입력과 따로 실행 취소되게 한다
    this.transact(() => ops.formatRange(list, s.start.idx, s.start.off, s.end.idx, s.end.off, { [attr]: on }));
    this.undoManager.stopCapturing();
    this.emit('selection');
    return true;
  }

  setColor(color) {
    const s = this.selection();
    if (s.collapsed) return false;
    const list = this.list(s.start.key);
    this.undoManager.stopCapturing();
    this.transact(() => ops.formatRange(list, s.start.idx, s.start.off, s.end.idx, s.end.off, { col: color }));
    this.undoManager.stopCapturing();
    return true;
  }

  /** 선택 영역의 서식 상태 (도구 모음 표시용) */
  formatState() {
    const s = this.selection();
    const list = this.list(s.start.key);
    const out = {};
    for (const attr of ['b', 'i', 'u', 's']) {
      out[attr] = s.collapsed
        ? ops.attrsAt(list.get(s.head.idx), s.head.off)[attr] === true
        : ops.rangeHasAttr(list, s.start.idx, s.start.off, s.end.idx, s.end.off, attr, true);
    }
    return out;
  }

  undo() {
    this.undoManager.undo();
    this.emit('selection');
  }

  redo() {
    this.undoManager.redo();
    this.emit('selection');
  }

  selectedText() {
    const s = this.selection();
    if (s.collapsed) return '';
    return ops.rangeText(this.list(s.start.key), s.start.idx, s.start.off, s.end.idx, s.end.off);
  }

  selectAll() {
    const { head } = this.selection();
    const list = this.list(head.key);
    const last = list.length - 1;
    this.setSelection({ key: head.key, idx: 0, off: 0 }, { key: head.key, idx: last, off: this.textLen(head.key, last) });
  }

  selectWord() {
    const { head } = this.selection();
    const str = this.list(head.key).get(head.idx).get('t').toString();
    const isWord = (ch) => ch !== undefined && !/\s/.test(ch);
    let a = head.off;
    let b = head.off;
    while (a > 0 && isWord(str[a - 1])) a--;
    while (b < str.length && isWord(str[b])) b++;
    if (a === b) return;
    this.setSelection({ key: head.key, idx: head.idx, off: a }, { key: head.key, idx: head.idx, off: b });
  }

  // ── 한글(IME) 조합 ──────────────────────────────────────────

  beginComposition() {
    this.deleteSelection();
    const { head } = this.selection();
    this.composition = {
      start: this.toRel(head, -1),
      len: 0,
      attrs: ops.attrsAt(this.list(head.key).get(head.idx), head.off),
    };
  }

  updateComposition(text) {
    const c = this.composition;
    if (!c) return;
    const p = this.fromRel(c.start);
    if (!p) return;
    const list = this.list(p.key);
    text = text.replace(/[\u0000-\u001f]/g, '');
    this.transact(() => {
      const t = list.get(p.idx).get('t');
      const del = Math.min(c.len, t.length - p.off);
      if (del > 0) t.delete(p.off, del);
      if (text) t.insert(p.off, text, { ...c.attrs });
    });
    c.len = text.length;
    this.setCaret({ key: p.key, idx: p.idx, off: p.off + text.length });
  }

  endComposition(text) {
    if (!this.composition) return;
    this.updateComposition(text ?? '');
    this.composition = null;
    this.undoManager.stopCapturing();
    this.flushRemote();
    this.emit('selection');
  }

  /** 조합 중인 글자의 범위 (밑줄 표시용) */
  compositionRange() {
    const c = this.composition;
    if (!c || !c.len) return null;
    const p = this.fromRel(c.start);
    return p ? { key: p.key, idx: p.idx, id: p.id, from: p.off, to: p.off + c.len } : null;
  }

  // ── 커서 이동 ───────────────────────────────────────────────

  moveChar(dir, extend) {
    const s = this.selection();
    if (!extend && !s.collapsed) return this.setCaret(dir < 0 ? s.start : s.end);
    const { head } = s;
    const list = this.list(head.key);
    let { idx, off } = head;
    const len = this.textLen(head.key, idx);
    if (dir < 0) {
      if (off > 0) off--;
      else if (idx > 0) off = this.textLen(head.key, --idx);
    } else if (off < len) off++;
    else if (idx < list.length - 1) {
      idx++;
      off = 0;
    }
    this.moveHead({ key: head.key, idx, off }, extend);
  }

  moveLine(delta, extend) {
    const { head } = this.selection();
    const hp = this.hwpPos(head);
    if (!hp) return;
    let r;
    try {
      r = this.adapter.moveVertical(hp.ref, hp.idx, hp.off, delta, this.preferredX);
    } catch {
      return;
    }
    const pos = this.posFromHit(r);
    if (!pos) return;
    const x = r.preferredX ?? -1;
    this.moveHead(pos, extend, { keepX: true });
    this.preferredX = x;
  }

  moveLineEdge(toEnd, extend) {
    const { head } = this.selection();
    const hp = this.hwpPos(head);
    if (!hp) return;
    let off = toEnd ? this.textLen(head.key, head.idx) : 0;
    try {
      const li = this.adapter.lineInfo(hp.ref, hp.idx, hp.off);
      off = toEnd ? li.charEnd : li.charStart;
      // 줄 끝이 다음 줄의 시작과 같은 자리(자동 줄바꿈)면 한 글자 앞에 둔다.
      if (toEnd && li.lineIndex < li.lineCount - 1 && off > li.charStart) off--;
    } catch {
      /* 문단 처음/끝으로 */
    }
    this.moveHead({ key: head.key, idx: head.idx, off }, extend);
  }

  moveDocEdge(toEnd, extend) {
    const { head } = this.selection();
    const key = extend ? head.key : bodyKey(toEnd ? this.adapter.sectionCount() - 1 : 0);
    const list = this.list(key);
    const idx = toEnd ? list.length - 1 : 0;
    this.moveHead({ key, idx, off: toEnd ? this.textLen(key, idx) : 0 }, extend);
  }

  // ── 다른 참여자 ─────────────────────────────────────────────

  peers() {
    const out = [];
    for (const [clientId, state] of this.awareness.getStates()) {
      if (!state?.user) continue;
      const me = clientId === this.awareness.clientID;
      let sel = null;
      if (!me && state.sel) {
        try {
          const head = this.fromRel(Y.createRelativePositionFromJSON(state.sel.h));
          let anchor = this.fromRel(Y.createRelativePositionFromJSON(state.sel.a));
          if (head) {
            if (!anchor || anchor.key !== head.key) anchor = head;
            const fwd = anchor.idx < head.idx || (anchor.idx === head.idx && anchor.off <= head.off);
            sel = { head, start: fwd ? anchor : head, end: fwd ? head : anchor };
          }
        } catch {
          sel = null;
        }
      }
      out.push({ clientId, me, user: state.user, sel });
    }
    return out;
  }
}
