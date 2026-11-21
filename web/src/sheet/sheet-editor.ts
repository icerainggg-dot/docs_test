// XLSX 편집기 핵심: 셀 값(원본 + 고친 셀), 수식 계산, 선택, 실행 취소, 다른 참여자.
// 화면은 grid.ts 가 맡는다.

import * as Y from 'yjs';
import { Calculator } from '../../../src/shared/xlsx/calc.ts';
import { formatValue, inputText, parseInput, isError } from '../../../src/shared/xlsx/format.ts';
import type { CellValue } from '../../../src/shared/xlsx/format.ts';
import { addrOf, parseAddr, parseRange } from '../../../src/shared/xlsx/addr.ts';
import type { CellPos, RangePos } from '../../../src/shared/xlsx/addr.ts';
import { getCells, isCellInput } from '../../../src/shared/xlsx/sheetdoc.ts';
import { cellKey, splitCellKey } from '../../../src/shared/xlsx/types.ts';
import type { BaseCell, CellInput, CellStyle, WorkbookModel } from '../../../src/shared/xlsx/types.ts';
import type { AwarenessLike, User } from '../editor/editor.ts';

export const LOCAL = { local: true } as const;

export interface SheetSelection {
  anchor: CellPos;
  head: CellPos;
}

export interface Display {
  text: string;
  /** 서식 번호 (styles 배열) */
  style: number;
  align: 'left' | 'right' | 'center';
}

export interface SheetPeer {
  clientId: number;
  me: boolean;
  user: User;
  sheet: number;
  sel: RangePos | null;
  head: CellPos | null;
  editing: boolean;
}

interface Merge {
  range: RangePos;
}

export type SheetEvent = 'cells' | 'selection' | 'awareness' | 'sheet';

const MAX_ROWS = 1048576;
const MAX_COLS = 16384;

export const rangeOf = (s: SheetSelection): RangePos => ({
  from: { row: Math.min(s.anchor.row, s.head.row), col: Math.min(s.anchor.col, s.head.col) },
  to: { row: Math.max(s.anchor.row, s.head.row), col: Math.max(s.anchor.col, s.head.col) },
});

export class SheetEditor {
  readonly model: WorkbookModel;
  readonly ydoc: Y.Doc;
  readonly cells: Y.Map<CellInput>;
  readonly calc: Calculator;
  readonly undoManager: Y.UndoManager;
  readonly awareness: AwarenessLike;
  sheet: number;
  /** 보기 권한: 고칠 수 없다 (서버도 편집을 받지 않는다) */
  readOnly = false;
  /** 시트마다 화면에 보이는 칸 수 (아래·오른쪽으로 넓어진다) */
  readonly extent: { rows: number; cols: number }[];
  private readonly selections: SheetSelection[];
  private readonly merges: Merge[][];
  private editing = false;
  private readonly listeners = new Set<(type: SheetEvent) => void>();
  private readonly onCells: (ev: Y.YMapEvent<CellInput>, tr: Y.Transaction) => void;
  private readonly onAwareness: () => void;

  constructor({ model, ydoc, awareness, user }: { model: WorkbookModel; ydoc: Y.Doc; awareness: AwarenessLike; user: User }) {
    this.model = model;
    this.ydoc = ydoc;
    this.awareness = awareness;
    this.cells = getCells(ydoc);
    this.calc = new Calculator(model, (si, addr) => this.input(si, addr));
    this.undoManager = new Y.UndoManager(this.cells, { trackedOrigins: new Set([LOCAL]), captureTimeout: 0 });
    this.sheet = Math.max(0, model.sheets.findIndex((s) => !s.hidden));
    this.extent = model.sheets.map((s) => ({ rows: Math.max(s.maxRow + 50, 100), cols: Math.max(s.maxCol + 10, 26) }));
    this.selections = model.sheets.map(() => ({ anchor: { row: 1, col: 1 }, head: { row: 1, col: 1 } }));
    this.merges = model.sheets.map((s) => s.merges.map((m) => parseRange(m)).filter((r): r is RangePos => r !== null).map((range) => ({ range })));
    // 고친 셀 때문에 범위가 넓어졌으면 반영한다.
    for (const key of this.cells.keys()) this.growFor(key);

    this.onCells = (ev) => {
      this.calc.invalidate();
      for (const key of ev.keysChanged) this.growFor(key);
      this.emit('cells');
    };
    this.cells.observe(this.onCells);
    this.onAwareness = () => this.emit('awareness');
    awareness.on('change', this.onAwareness);
    awareness.setLocalStateField('user', user);
    this.publish();
  }

  destroy(): void {
    this.cells.unobserve(this.onCells);
    this.awareness.off('change', this.onAwareness);
    this.undoManager.destroy();
  }

  on(fn: (type: SheetEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(type: SheetEvent): void {
    for (const fn of this.listeners) fn(type);
  }

  private growFor(key: string): void {
    const k = splitCellKey(key);
    const pos = k && parseAddr(k.addr);
    const ext = k && this.extent[k.sheet];
    if (!pos || !ext) return;
    ext.rows = Math.max(ext.rows, pos.row + 20);
    ext.cols = Math.max(ext.cols, pos.col + 5);
  }

  // ── 값 ─────────────────────────────────────────────────────

  /** 지금 셀에 들어 있는 입력: 고친 값이 있으면 그것, 없으면 원본 */
  input(si: number, addr: string): CellInput | BaseCell | undefined {
    const edited = this.cells.get(cellKey(si, addr));
    if (edited !== undefined && isCellInput(edited)) return edited;
    return this.model.sheets[si]?.cells[addr];
  }

  styleIndex(si: number, addr: string): number {
    return this.model.sheets[si]?.cells[addr]?.s ?? 0;
  }

  style(idx: number): CellStyle {
    return this.model.styles[idx] ?? this.model.styles[0] ?? { numFmt: 'General' };
  }

  value(si: number, addr: string): CellValue {
    return this.calc.value(si, addr);
  }

  display(si: number, row: number, col: number): Display {
    const addr = addrOf(row, col);
    const style = this.styleIndex(si, addr);
    const st = this.style(style);
    const v = this.value(si, addr);
    const text = formatValue(v, st.numFmt);
    let align: Display['align'] = typeof v === 'number' ? 'right' : typeof v === 'boolean' || isError(v) ? 'center' : 'left';
    if (st.hAlign === 'center' || st.hAlign === 'centerContinuous') align = 'center';
    else if (st.hAlign === 'right') align = 'right';
    else if (st.hAlign === 'left' || st.hAlign === 'fill' || st.hAlign === 'justify') align = 'left';
    return { text, style, align };
  }

  /** 편집할 때 보여 줄 원래 입력 (수식은 =…) */
  raw(si: number, addr: string): string {
    return inputText(this.input(si, addr));
  }

  // ── 고치기 ─────────────────────────────────────────────────

  /** 여러 셀을 한 번에 (실행 취소도 한 번에) */
  setMany(si: number, entries: [string, CellInput][]): void {
    if (!entries.length || this.readOnly) return;
    this.undoManager.stopCapturing();
    this.ydoc.transact(() => {
      for (const [addr, input] of entries) {
        const base = this.model.sheets[si]?.cells[addr];
        const key = cellKey(si, addr);
        // 원본과 같아지면 고친 기록을 지운다 (빈 셀을 비우는 것 포함).
        const same =
          (input.t === 'z' && (!base || (base.v === '' && base.f === undefined))) ||
          (base !== undefined && inputText(base) === inputText(input) && input.t !== 'z');
        if (same) {
          if (this.cells.has(key)) this.cells.delete(key);
        } else {
          this.cells.set(key, input);
        }
      }
    }, LOCAL);
    this.undoManager.stopCapturing();
  }

  /** 사람이 친 글자로 셀을 고친다. 바뀌지 않았으면 false. */
  commit(si: number, addr: string, text: string): boolean {
    if (text === this.raw(si, addr)) return false;
    this.setMany(si, [[addr, parseInput(text)]]);
    return true;
  }

  clearRange(si: number, r: RangePos): void {
    const entries: [string, CellInput][] = [];
    for (let row = r.from.row; row <= r.to.row; row++) {
      for (let col = r.from.col; col <= r.to.col; col++) {
        const addr = addrOf(row, col);
        if (this.raw(si, addr) !== '') entries.push([addr, { t: 'z' }]);
      }
    }
    this.setMany(si, entries);
  }

  /** 탭·줄바꿈으로 나뉜 글자를 붙여 넣는다. */
  paste(si: number, at: CellPos, rows: string[][]): RangePos {
    const entries: [string, CellInput][] = [];
    rows.forEach((cols, r) =>
      cols.forEach((text, c) => {
        const row = at.row + r;
        const col = at.col + c;
        if (row <= MAX_ROWS && col <= MAX_COLS) entries.push([addrOf(row, col), parseInput(text)]);
      }),
    );
    this.setMany(si, entries);
    for (const [addr] of entries) this.growFor(cellKey(si, addr));
    const width = Math.max(1, ...rows.map((r) => r.length));
    return { from: at, to: { row: at.row + rows.length - 1, col: at.col + width - 1 } };
  }

  /** 범위를 탭·줄바꿈 글자로 (복사용, 화면에 보이는 값) */
  copyText(si: number, r: RangePos): string {
    const lines: string[] = [];
    for (let row = r.from.row; row <= r.to.row; row++) {
      const cols: string[] = [];
      for (let col = r.from.col; col <= r.to.col; col++) {
        const t = this.display(si, row, col).text;
        cols.push(/[\t\n"]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t);
      }
      lines.push(cols.join('\t'));
    }
    return lines.join('\n');
  }

  undo(): void {
    if (this.readOnly) return;
    this.undoManager.undo();
  }

  redo(): void {
    if (this.readOnly) return;
    this.undoManager.redo();
  }

  // ── 병합 ───────────────────────────────────────────────────

  mergesOf(si: number): Merge[] {
    return this.merges[si] ?? [];
  }

  /** 셀이 병합 범위 안이면 그 범위 */
  mergeAt(si: number, pos: CellPos): RangePos | null {
    for (const m of this.mergesOf(si)) {
      const r = m.range;
      if (pos.row >= r.from.row && pos.row <= r.to.row && pos.col >= r.from.col && pos.col <= r.to.col) return r;
    }
    return null;
  }

  // ── 선택 ───────────────────────────────────────────────────

  get selection(): SheetSelection {
    return this.selections[this.sheet]!;
  }

  setSheet(si: number): void {
    if (si === this.sheet || !this.model.sheets[si]) return;
    this.sheet = si;
    this.publish();
    this.emit('sheet');
  }

  select(anchor: CellPos, head: CellPos = anchor): void {
    const ext = this.extent[this.sheet]!;
    const clamp = (p: CellPos): CellPos => ({ row: Math.min(Math.max(p.row, 1), MAX_ROWS), col: Math.min(Math.max(p.col, 1), MAX_COLS) });
    const a = clamp(anchor);
    const h = clamp(head);
    ext.rows = Math.max(ext.rows, h.row + 20);
    ext.cols = Math.max(ext.cols, h.col + 5);
    this.selections[this.sheet] = { anchor: a, head: h };
    this.publish();
    this.emit('selection');
  }

  /** 활성 셀을 옮긴다. 병합된 셀은 한 칸처럼 건너뛴다. */
  move(dRow: number, dCol: number, extend = false): void {
    const s = this.selection;
    let { row, col } = s.head;
    const m = this.mergeAt(this.sheet, s.head);
    if (m && !extend) {
      if (dRow > 0) row = m.to.row;
      if (dCol > 0) col = m.to.col;
      if (dRow < 0) row = m.from.row;
      if (dCol < 0) col = m.from.col;
    }
    const next = { row: Math.max(1, row + dRow), col: Math.max(1, col + dCol) };
    const nm = !extend ? this.mergeAt(this.sheet, next) : null;
    const target = nm ? nm.from : next;
    this.select(extend ? s.anchor : target, target);
  }

  setEditing(on: boolean): void {
    if (this.editing === on) return;
    this.editing = on;
    this.publish();
  }

  private publish(): void {
    const s = this.selection;
    this.awareness.setLocalStateField('sheet', {
      si: this.sheet,
      a: addrOf(s.anchor.row, s.anchor.col),
      h: addrOf(s.head.row, s.head.col),
      editing: this.editing,
    });
  }

  peers(): SheetPeer[] {
    const out: SheetPeer[] = [];
    for (const [clientId, raw] of this.awareness.getStates()) {
      const state = raw as { user?: User; sheet?: { si?: unknown; a?: unknown; h?: unknown; editing?: unknown } };
      if (!state?.user || typeof state.user.name !== 'string') continue;
      const me = clientId === this.awareness.clientID;
      const sh = state.sheet;
      const a = typeof sh?.a === 'string' ? parseAddr(sh.a) : null;
      const h = typeof sh?.h === 'string' ? parseAddr(sh.h) : null;
      const sheet = typeof sh?.si === 'number' ? sh.si : -1;
      out.push({
        clientId,
        me,
        user: { name: String(state.user.name).slice(0, 40), color: /^#[0-9a-f]{6}$/i.test(state.user.color) ? state.user.color : '#888888' },
        sheet,
        head: h,
        sel: a && h ? rangeOf({ anchor: a, head: h }) : null,
        editing: sh?.editing === true,
      });
    }
    return out;
  }
}

/** 탭·줄바꿈 글자(엑셀 복사 형식)를 칸으로 나눈다. 따옴표 안의 줄바꿈도 다룬다. */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let i = 0;
  let quoted = false;
  const src = text.replace(/\r\n?/g, '\n').replace(/\n$/, '');
  while (i < src.length) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i += 2;
        continue;
      }
      if (ch === '"') {
        quoted = false;
        i++;
        continue;
      }
      cell += ch;
      i++;
      continue;
    }
    if (ch === '"' && cell === '') {
      quoted = true;
      i++;
      continue;
    }
    if (ch === '\t') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
    i++;
  }
  row.push(cell);
  rows.push(row);
  return rows;
}
