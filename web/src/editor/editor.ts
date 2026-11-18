// 편집기 핵심: 선택 영역, 편집 명령, 한글 조합, 원격 변경 반영.
// 화면 그리기는 view.ts, 키보드·마우스는 input.ts 가 맡는다.

import * as Y from 'yjs';
import type { HwpDocument } from '@rhwp/core';
import { Reconciler, collectChanges } from '../../../src/shared/reconciler.ts';
import type { Changes } from '../../../src/shared/reconciler.ts';
import { getLists, keyOfList, bodyKey, cellKey, isBodyKey, paraId, paraText } from '../../../src/shared/model.ts';
import type { Lists, ParaList } from '../../../src/shared/model.ts';
import type { HwpAdapter, HitResult, OverlayKey, TextAttrs, ListRef } from '../../../src/shared/hwp-adapter.ts';
import * as ops from '../../../src/shared/ops.ts';

const { LOCAL } = ops;
const NONE = 0xffffffff;
const COMPOSE_DEFER_MAX_MS = 2000;

/** 편집 위치: 어느 리스트의 몇째 문단, 몇째 글자 */
export interface EdPos {
  key: string;
  idx: number;
  off: number;
  /** 문단 id (알고 있으면) */
  id?: string;
}

export interface Selection {
  anchor: EdPos;
  head: EdPos;
  start: EdPos;
  end: EdPos;
  collapsed: boolean;
}

/** rHWP 쪽 위치 */
export interface HwpPos {
  ref: ListRef;
  idx: number;
  off: number;
}

export interface User {
  name: string;
  color: string;
}

export interface Peer {
  clientId: number;
  me: boolean;
  user: User;
  sel: { head: EdPos; start: EdPos; end: EdPos } | null;
}

/** 다른 참여자에게 알리는 내 상태 */
interface AwarenessState {
  user?: User;
  sel?: { a: unknown; h: unknown };
}

/** y-protocols Awareness 중 편집기가 쓰는 부분 */
export interface AwarenessLike {
  clientID: number;
  getStates(): Map<number, Record<string, unknown>>;
  setLocalStateField(field: string, value: unknown): void;
  on(event: 'change', fn: () => void): void;
  off(event: 'change', fn: () => void): void;
}

export type EditorEvent = 'doc' | 'selection' | 'awareness';

interface Composition {
  start: Y.RelativePosition;
  len: number;
  attrs: TextAttrs;
}

export class Editor {
  readonly hwp: HwpDocument;
  readonly ydoc: Y.Doc;
  readonly awareness: AwarenessLike;
  readonly lists: Lists;
  readonly rec: Reconciler;
  readonly adapter: HwpAdapter;
  readonly undoManager: Y.UndoManager;
  /** rHWP 문서가 바뀔 때마다 올라간다 (쪽 다시 그리기 판단용) */
  rev = 0;

  private sel: { anchor: Y.RelativePosition; head: Y.RelativePosition } | null = null;
  private lastHead: EdPos | null = null;
  private preferredX = -1;
  private composition: Composition | null = null;
  private pendingRemote: Changes = new Map();
  private deferTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<(type: EditorEvent) => void>();
  private readonly onDeep: (events: Y.YEvent<Y.AbstractType<unknown>>[], tr: Y.Transaction) => void;
  private readonly onAwareness: () => void;

  constructor({ hwp, ydoc, awareness, user }: { hwp: HwpDocument; ydoc: Y.Doc; awareness: AwarenessLike; user: User }) {
    this.hwp = hwp;
    this.ydoc = ydoc;
    this.awareness = awareness;
    this.lists = getLists(ydoc);
    this.rec = new Reconciler(hwp, ydoc);
    this.rec.syncAll();
    this.adapter = this.rec.adapter;

    this.undoManager = new Y.UndoManager(this.lists, { trackedOrigins: new Set([LOCAL]), captureTimeout: 600 });

    this.onDeep = (events, tr) => this.handleChanges(events, tr);
    this.lists.observeDeep(this.onDeep);
    this.onAwareness = () => this.emit('awareness');
    awareness.on('change', this.onAwareness);
    awareness.setLocalStateField('user', user);

    this.setCaret(this.firstPos());
  }

  destroy(): void {
    this.lists.unobserveDeep(this.onDeep);
    this.awareness.off('change', this.onAwareness);
    this.undoManager.destroy();
    if (this.deferTimer) clearTimeout(this.deferTimer);
  }

  on(fn: (type: EditorEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(type: EditorEvent): void {
    for (const fn of this.listeners) fn(type);
  }

  // ── Y 변경 → rHWP ──────────────────────────────────────────

  private handleChanges(events: Y.YEvent<Y.AbstractType<unknown>>[], tr: Y.Transaction): void {
    if (tr.local) {
      // 내 편집(실행 취소 포함)은 바로 반영한다. 같은 리스트에 미뤄 둔 원격 변경도 함께.
      const changes = collectChanges(events);
      for (const [key, ids] of changes) {
        if (!this.pendingRemote.has(key)) continue;
        const pend = this.pendingRemote.get(key);
        if (ids === null || !pend) changes.set(key, null);
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

  private flushRemote(): void {
    if (this.deferTimer) clearTimeout(this.deferTimer);
    this.deferTimer = null;
    if (!this.pendingRemote.size) return;
    const changes = this.pendingRemote;
    this.pendingRemote = new Map();
    this.apply(changes);
  }

  private apply(changes: Changes): void {
    try {
      if (this.rec.sync(changes)) this.rev++;
    } catch (e) {
      console.error('문서 반영 실패', e);
    }
    this.emit('doc');
  }

  // ── 위치 ───────────────────────────────────────────────────

  firstPos(): EdPos {
    return { key: bodyKey(0), idx: 0, off: 0 };
  }

  list(key: string): ParaList {
    const l = this.lists.get(key);
    if (!l) throw new Error(`문단 리스트 ${key} 이(가) 없습니다.`);
    return l;
  }

  private text(key: string, idx: number): Y.Text {
    const p = this.list(key).get(idx);
    if (!p) throw new RangeError(`문단 ${key}#${idx} 이(가) 없습니다.`);
    return paraText(p);
  }

  textLen(key: string, idx: number): number {
    return this.text(key, idx).length;
  }

  private toRel(pos: EdPos, assoc = 0): Y.RelativePosition {
    const t = this.text(pos.key, pos.idx);
    return Y.createRelativePositionFromTypeIndex(t, Math.min(pos.off, t.length), assoc);
  }

  fromRel(rel: Y.RelativePosition | null | undefined): EdPos | null {
    if (!rel) return null;
    const abs = Y.createAbsolutePositionFromRelativePosition(rel, this.ydoc);
    if (!abs) return null;
    const text = abs.type;
    const para = text.parent;
    const list = para?.parent;
    if (!para || !list || text._item?.deleted || para._item?.deleted || list._item?.deleted) return null;
    const key = keyOfList(list);
    if (!key || this.lists.get(key) !== list) return null;
    let idx = 0;
    for (const p of this.list(key)) {
      if (p === para) return { key, idx, off: abs.index, id: paraId(p) };
      idx++;
    }
    return null;
  }

  /** 현재 선택 영역. 가리키던 문단이 없어졌으면 가까운 곳으로 옮긴다. */
  selection(): Selection {
    let head = this.fromRel(this.sel?.head);
    let anchor = this.fromRel(this.sel?.anchor);
    if (!head) {
      const last = this.lastHead;
      if (last && this.lists.has(last.key)) {
        const idx = Math.min(last.idx, this.list(last.key).length - 1);
        head = { key: last.key, idx, off: Math.min(last.off, this.textLen(last.key, idx)) };
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

  setSelection(anchor: EdPos, head: EdPos, { keepX = false }: { keepX?: boolean } = {}): void {
    if (anchor.key !== head.key) anchor = head;
    this.sel = { anchor: this.toRel(anchor), head: this.toRel(head) };
    this.lastHead = head;
    if (!keepX) this.preferredX = -1;
    this.publishSelection();
    this.emit('selection');
  }

  setCaret(pos: EdPos, opts?: { keepX?: boolean }): void {
    this.setSelection(pos, pos, opts);
  }

  moveHead(pos: EdPos, extend: boolean, opts?: { keepX?: boolean }): void {
    if (extend) {
      const { anchor } = this.selection();
      if (anchor.key !== pos.key) return; // 선택은 한 리스트(본문 또는 한 셀) 안에서만
      this.setSelection(anchor, pos, opts);
    } else {
      this.setCaret(pos, opts);
    }
  }

  private publishSelection(): void {
    if (!this.sel) return;
    this.awareness.setLocalStateField('sel', {
      a: Y.relativePositionToJSON(this.sel.anchor),
      h: Y.relativePositionToJSON(this.sel.head),
    });
  }

  /** rHWP 쪽 위치(리스트 참조 + 문단 번호). 아직 반영되지 않은 문단이면 null. */
  hwpPos(pos: EdPos): HwpPos | null {
    const ref = this.rec.ref(pos.key);
    if (!ref) return null;
    const p = this.lists.get(pos.key)?.get(pos.idx);
    const id = pos.id ?? (p ? paraId(p) : undefined);
    if (id === undefined) return null;
    const idx = this.rec.indexOf(pos.key, id);
    if (idx < 0) return null;
    return { ref, idx, off: Math.min(pos.off, this.adapter.paraLen(ref, idx)) };
  }

  /** hitTest·moveVertical 결과 → 편집 위치 */
  posFromHit(h: HitResult | null): EdPos | null {
    if (!h || h.sectionIndex === undefined) return null;
    let key: string;
    let idx: number;
    const inCell = h.parentParaIndex !== undefined && h.parentParaIndex !== null && h.parentParaIndex !== NONE;
    if (inCell) {
      if (h.cellPath && h.cellPath.length > 1) return null; // 표 안의 표는 아직 편집하지 않는다
      const ownerId = this.rec.ids(bodyKey(h.sectionIndex))[h.parentParaIndex!];
      if (ownerId === undefined || h.controlIndex === undefined || h.cellIndex === undefined) return null;
      key = cellKey(ownerId, h.controlIndex, h.cellIndex);
      idx = h.cellParaIndex ?? 0;
    } else {
      key = bodyKey(h.sectionIndex);
      idx = h.paragraphIndex;
    }
    const id = this.rec.ids(key)[idx];
    const list = this.lists.get(key);
    if (!list || id === undefined) return null;
    let yIdx = 0;
    for (const p of list) {
      if (paraId(p) === id) {
        return { key, idx: yIdx, off: Math.min(h.charOffset ?? 0, paraText(p).length), id };
      }
      yIdx++;
    }
    return null;
  }

  canRemove(key: string, idx: number): boolean {
    if (!isBodyKey(key)) return true;
    const hp = this.hwpPos({ key, idx, off: 0 });
    if (!hp) return false;
    return this.adapter.controlCount(hp.ref, hp.idx) === 0; // 표·그림을 품은 문단은 지우지 않는다
  }

  // ── 편집 명령 ───────────────────────────────────────────────

  private transact<T>(fn: () => T): T {
    let result!: T;
    this.ydoc.transact(() => {
      result = fn();
    }, LOCAL);
    return result;
  }

  private deleteSelectionIn(s: Selection): ops.Pos {
    const list = this.list(s.start.key);
    return ops.deleteRange(list, s.start.idx, s.start.off, s.end.idx, s.end.off, (i) => this.canRemove(s.start.key, i));
  }

  type(text: string): void {
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

  enter(): void {
    const s = this.selection();
    const key = s.start.key;
    const list = this.list(key);
    const p = this.transact(() => {
      const at = s.collapsed ? s.start : this.deleteSelectionIn(s);
      return ops.splitPara(list, at.idx, at.off);
    });
    this.setCaret({ key, ...p });
  }

  deleteSelection(): boolean {
    const s = this.selection();
    if (s.collapsed) return false;
    const p = this.transact(() => this.deleteSelectionIn(s));
    this.setCaret({ key: s.start.key, ...p });
    return true;
  }

  backspace(): void {
    if (this.deleteSelection()) return;
    const { head } = this.selection();
    const list = this.list(head.key);
    if (head.off > 0) {
      const str = this.text(head.key, head.idx).toString();
      const c = str.charCodeAt(head.off - 1);
      const n = head.off > 1 && c >= 0xdc00 && c <= 0xdfff ? 2 : 1;
      this.transact(() => ops.deleteRange(list, head.idx, head.off - n, head.idx, head.off));
      this.setCaret({ key: head.key, idx: head.idx, off: head.off - n });
    } else if (head.idx > 0 && this.canRemove(head.key, head.idx)) {
      const p = this.transact(() => ops.mergeWithPrev(list, head.idx));
      this.setCaret({ key: head.key, ...p });
    }
  }

  del(): void {
    if (this.deleteSelection()) return;
    const { head } = this.selection();
    const list = this.list(head.key);
    const str = this.text(head.key, head.idx).toString();
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
  toggleFormat(attr: Exclude<OverlayKey, 'col'>): boolean {
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

  setColor(color: string): boolean {
    const s = this.selection();
    if (s.collapsed) return false;
    const list = this.list(s.start.key);
    this.undoManager.stopCapturing();
    this.transact(() => ops.formatRange(list, s.start.idx, s.start.off, s.end.idx, s.end.off, { col: color }));
    this.undoManager.stopCapturing();
    return true;
  }

  /** 선택 영역의 서식 상태 (도구 모음 표시용) */
  formatState(): Record<'b' | 'i' | 'u' | 's', boolean> {
    const s = this.selection();
    const list = this.list(s.start.key);
    const at = (attr: 'b' | 'i' | 'u' | 's'): boolean => {
      if (!s.collapsed) return ops.rangeHasAttr(list, s.start.idx, s.start.off, s.end.idx, s.end.off, attr, true);
      const p = list.get(s.head.idx);
      return p ? ops.attrsAt(p, s.head.off)[attr] === true : false;
    };
    return { b: at('b'), i: at('i'), u: at('u'), s: at('s') };
  }

  undo(): void {
    this.undoManager.undo();
    this.emit('selection');
  }

  redo(): void {
    this.undoManager.redo();
    this.emit('selection');
  }

  selectedText(): string {
    const s = this.selection();
    if (s.collapsed) return '';
    return ops.rangeText(this.list(s.start.key), s.start.idx, s.start.off, s.end.idx, s.end.off);
  }

  selectAll(): void {
    const { head } = this.selection();
    const last = this.list(head.key).length - 1;
    this.setSelection({ key: head.key, idx: 0, off: 0 }, { key: head.key, idx: last, off: this.textLen(head.key, last) });
  }

  selectWord(): void {
    const { head } = this.selection();
    const str = this.text(head.key, head.idx).toString();
    const isWord = (ch: string | undefined): boolean => ch !== undefined && !/\s/.test(ch);
    let a = head.off;
    let b = head.off;
    while (a > 0 && isWord(str[a - 1])) a--;
    while (b < str.length && isWord(str[b])) b++;
    if (a === b) return;
    this.setSelection({ key: head.key, idx: head.idx, off: a }, { key: head.key, idx: head.idx, off: b });
  }

  // ── 한글(IME) 조합 ──────────────────────────────────────────

  beginComposition(): void {
    this.deleteSelection();
    const { head } = this.selection();
    const p = this.list(head.key).get(head.idx);
    this.composition = {
      start: this.toRel(head, -1),
      len: 0,
      attrs: p ? ops.attrsAt(p, head.off) : {},
    };
  }

  updateComposition(text: string): void {
    const c = this.composition;
    if (!c) return;
    const p = this.fromRel(c.start);
    if (!p) return;
    const clean = text.replace(/[\u0000-\u001f]/g, '');
    this.transact(() => {
      const t = this.text(p.key, p.idx);
      const del = Math.min(c.len, t.length - p.off);
      if (del > 0) t.delete(p.off, del);
      if (clean) t.insert(p.off, clean, { ...c.attrs });
    });
    c.len = clean.length;
    this.setCaret({ key: p.key, idx: p.idx, off: p.off + clean.length });
  }

  endComposition(text?: string): void {
    if (!this.composition) return;
    this.updateComposition(text ?? '');
    this.composition = null;
    this.undoManager.stopCapturing();
    this.flushRemote();
    this.emit('selection');
  }

  /** 조합 중인 글자의 범위 (밑줄 표시용) */
  compositionRange(): { key: string; idx: number; id?: string; from: number; to: number } | null {
    const c = this.composition;
    if (!c || !c.len) return null;
    const p = this.fromRel(c.start);
    return p ? { key: p.key, idx: p.idx, id: p.id, from: p.off, to: p.off + c.len } : null;
  }

  // ── 커서 이동 ───────────────────────────────────────────────

  moveChar(dir: -1 | 1, extend: boolean): void {
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

  moveLine(delta: -1 | 1, extend: boolean): void {
    const { head } = this.selection();
    const hp = this.hwpPos(head);
    if (!hp) return;
    let r: HitResult;
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

  moveLineEdge(toEnd: boolean, extend: boolean): void {
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

  moveDocEdge(toEnd: boolean, extend: boolean): void {
    const { head } = this.selection();
    const key = extend ? head.key : bodyKey(toEnd ? this.adapter.sectionCount() - 1 : 0);
    const idx = toEnd ? this.list(key).length - 1 : 0;
    this.moveHead({ key, idx, off: toEnd ? this.textLen(key, idx) : 0 }, extend);
  }

  // ── 다른 참여자 ─────────────────────────────────────────────

  peers(): Peer[] {
    const out: Peer[] = [];
    for (const [clientId, raw] of this.awareness.getStates()) {
      const state = raw as AwarenessState;
      if (!state?.user) continue;
      const me = clientId === this.awareness.clientID;
      let sel: Peer['sel'] = null;
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
