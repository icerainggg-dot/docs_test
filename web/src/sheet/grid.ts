// XLSX 화면: 보이는 칸만 그리는 격자, 셀 입력(한글 조합 포함), 수식 입력줄, 시트 탭

import { addrOf, colName, parseAddr } from '../../../src/shared/xlsx/addr.ts';
import type { CellPos, RangePos } from '../../../src/shared/xlsx/addr.ts';
import type { BorderSide, CellStyle } from '../../../src/shared/xlsx/types.ts';
import { SheetEditor, rangeOf, parseTsv } from './sheet-editor.ts';
import { h } from '../api.ts';

const HEADER_W = 46;
const HEADER_H = 24;
const OVERSCAN = 2;

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const safeColor = (c: string | null | undefined): string | null => (c && /^#[0-9A-Fa-f]{6}$/.test(c) ? c : null);

function borderCss(side: BorderSide | undefined): string | null {
  if (!side) return null;
  const color = safeColor(side.color) ?? '#000';
  const map: Record<string, string> = {
    thin: '1px solid',
    hair: '1px dotted',
    dotted: '1px dotted',
    dashed: '1px dashed',
    dashDot: '1px dashed',
    dashDotDot: '1px dashed',
    medium: '2px solid',
    mediumDashed: '2px dashed',
    mediumDashDot: '2px dashed',
    mediumDashDotDot: '2px dashed',
    slantDashDot: '2px dashed',
    thick: '3px solid',
    double: '3px double',
  };
  return `${map[side.style] ?? '1px solid'} ${color}`;
}

/** 셀 서식 → CSS 규칙 */
function styleCss(idx: number, st: CellStyle): string {
  const p: string[] = [];
  if (st.bold) p.push('font-weight:700');
  if (st.italic) p.push('font-style:italic');
  const deco = [st.underline ? 'underline' : '', st.strike ? 'line-through' : ''].filter(Boolean).join(' ');
  if (deco) p.push(`text-decoration:${deco}`);
  const color = safeColor(st.color);
  if (color) p.push(`color:${color}`);
  const fill = safeColor(st.fill);
  if (fill) p.push(`background:${fill}`);
  if (st.size && st.size > 0 && st.size < 100) p.push(`font-size:${((st.size * 4) / 3).toFixed(1)}px`);
  if (st.wrap) p.push('white-space:pre-wrap;word-break:break-all');
  if (st.vAlign === 'top') p.push('align-items:flex-start');
  else if (st.vAlign === 'center') p.push('align-items:center');
  const b = st.border;
  if (b) {
    for (const side of ['left', 'right', 'top', 'bottom'] as const) {
      const css = borderCss(b[side]);
      if (css) p.push(`border-${side}:${css}`);
    }
  }
  return p.length ? `.xs .s${idx}{${p.join(';')}}` : '';
}

/** 한 방향(행 또는 열)의 크기와 위치 */
class Axis {
  private offsets: number[] = [0, 0];
  private readonly size: (i: number) => number;
  count = 0;

  constructor(size: (i: number) => number) {
    this.size = size;
  }

  ensure(count: number): void {
    if (count <= this.count) return;
    for (let i = this.count + 1; i <= count; i++) this.offsets[i + 1] = this.offsets[i]! + this.size(i);
    this.count = count;
  }

  /** i 번째의 시작 위치 */
  start(i: number): number {
    this.ensure(i);
    return this.offsets[i]!;
  }

  sizeOf(i: number): number {
    return this.start(i + 1) - this.start(i);
  }

  total(): number {
    return this.offsets[this.count + 1]!;
  }

  /** 위치 → 번호 */
  at(pos: number): number {
    let lo = 1;
    let hi = this.count;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.offsets[mid]! <= pos) lo = mid;
      else hi = mid - 1;
    }
    return Math.max(1, lo);
  }
}

type EditMode = null | 'enter' | 'edit' | 'bar';

export class SheetGrid {
  readonly ed: SheetEditor;
  readonly root: HTMLElement;
  readonly input: HTMLTextAreaElement;
  readonly fx: HTMLInputElement;
  private readonly addrBox: HTMLInputElement;
  private readonly body: HTMLDivElement;
  private readonly canvas: HTMLDivElement;
  private readonly cellsEl: HTMLDivElement;
  private readonly overlay: HTMLDivElement;
  private readonly colInner: HTMLDivElement;
  private readonly rowInner: HTMLDivElement;
  private readonly tabs: HTMLDivElement;
  private readonly styleEl: HTMLStyleElement;
  private rows!: Axis;
  private cols!: Axis;
  private frame = 0;
  private mode: EditMode = null;
  private follow = false;
  private dragging = false;
  private readonly offs: (() => void)[] = [];

  constructor(ed: SheetEditor, root: HTMLElement) {
    this.ed = ed;
    this.root = root;
    this.styleEl = h('style');
    this.styleEl.textContent = ed.model.styles.map((s, i) => styleCss(i, s)).join('\n');

    this.addrBox = h('input', { class: 'addr', readonly: true, 'aria-label': '셀 주소', tabindex: '-1' });
    this.fx = h('input', { class: 'fx', 'aria-label': '셀 내용 (수식 입력줄)', autocomplete: 'off', spellcheck: 'false' });
    this.input = h('textarea', {
      class: 'cell-editor',
      'aria-label': '셀 편집',
      autocapitalize: 'off',
      autocomplete: 'off',
      spellcheck: 'false',
      rows: '1',
    });
    this.cellsEl = h('div', { class: 'cells xs' });
    this.overlay = h('div', { class: 'sel-layer' });
    this.canvas = h('div', { class: 'canvas' }, this.cellsEl, this.overlay, this.input);
    this.body = h('div', { class: 'gbody' }, this.canvas);
    this.colInner = h('div', { class: 'inner' });
    this.rowInner = h('div', { class: 'inner' });
    this.tabs = h('div', { class: 'tabs', role: 'tablist', 'aria-label': '시트' });

    root.append(
      this.styleEl,
      h('div', { class: 'fbar' }, this.addrBox, h('span', { class: 'fx-label', 'aria-hidden': 'true' }, 'fx'), this.fx),
      h('div', { class: 'grid' }, h('div', { class: 'corner' }), h('div', { class: 'colhead' }, this.colInner), h('div', { class: 'rowhead' }, this.rowInner), this.body),
      this.tabs,
    );

    this.resetAxes();
    this.renderTabs();
    this.bind();
    this.offs.push(
      ed.on((type) => {
        if (type === 'sheet') {
          this.resetAxes();
          this.renderTabs();
          this.body.scrollTo(0, 0);
          this.follow = true;
        }
        if (type === 'selection') this.follow = true;
        if (type === 'cells') this.syncExtent();
        if (type !== 'awareness' && !this.mode) this.fx.value = this.activeRaw();
        this.schedule();
      }),
    );
    this.fx.value = this.activeRaw();
    this.schedule();
  }

  destroy(): void {
    cancelAnimationFrame(this.frame);
    for (const off of this.offs) off();
    this.root.replaceChildren();
  }

  focus(): void {
    this.input.focus({ preventScroll: true });
  }

  /** 셀의 화면 좌표 (자동 시험용). 보이도록 먼저 스크롤한다. */
  clientRectOf(row: number, col: number): { x: number; y: number; w: number; h: number } {
    const r = this.rectOf({ from: { row, col }, to: { row, col } });
    this.scrollIntoView({ from: { row, col }, to: { row, col } });
    const c = this.canvas.getBoundingClientRect();
    return { x: c.left + r.x, y: c.top + r.y, w: r.w, h: r.h };
  }

  // ── 크기 ───────────────────────────────────────────────────

  private resetAxes(): void {
    const sheet = this.ed.model.sheets[this.ed.sheet]!;
    // 높이를 정하지 않은 행은 엑셀처럼 가장 큰 글자에 맞춰 높인다.
    const auto = new Map<number, number>();
    for (const [addr, c] of Object.entries(sheet.cells)) {
      const size = this.ed.style(c.s ?? 0).size;
      if (!size || size <= 11) continue;
      const pos = parseAddr(addr);
      if (!pos) continue;
      auto.set(pos.row, Math.max(auto.get(pos.row) ?? 0, Math.ceil(((size * 4) / 3) * 1.35) + 2));
    }
    this.rows = new Axis((i) => sheet.rowHeights[i] ?? Math.max(sheet.defaultRowHeight, auto.get(i) ?? 0));
    this.cols = new Axis((i) => sheet.colWidths[i] ?? sheet.defaultColWidth);
    this.syncExtent();
  }

  private syncExtent(): void {
    const ext = this.ed.extent[this.ed.sheet]!;
    this.rows.ensure(ext.rows);
    this.cols.ensure(ext.cols);
    this.canvas.style.width = `${this.cols.total()}px`;
    this.canvas.style.height = `${this.rows.total()}px`;
  }

  /** 셀(또는 병합 범위)의 화면 사각형 */
  private rectOf(r: RangePos): { x: number; y: number; w: number; h: number } {
    const x = this.cols.start(r.from.col);
    const y = this.rows.start(r.from.row);
    return { x, y, w: this.cols.start(r.to.col + 1) - x, h: this.rows.start(r.to.row + 1) - y };
  }

  /** 병합을 넓혀 선택 범위를 덮는다. */
  private expand(r: RangePos): RangePos {
    const out = { from: { ...r.from }, to: { ...r.to } };
    for (const m of this.ed.mergesOf(this.ed.sheet)) {
      const g = m.range;
      if (g.to.row < out.from.row || g.from.row > out.to.row || g.to.col < out.from.col || g.from.col > out.to.col) continue;
      out.from.row = Math.min(out.from.row, g.from.row);
      out.from.col = Math.min(out.from.col, g.from.col);
      out.to.row = Math.max(out.to.row, g.to.row);
      out.to.col = Math.max(out.to.col, g.to.col);
    }
    return out;
  }

  private activeRange(): RangePos {
    const head = this.ed.selection.head;
    return this.ed.mergeAt(this.ed.sheet, head) ?? { from: head, to: head };
  }

  private activeAddr(): string {
    const r = this.activeRange();
    return addrOf(r.from.row, r.from.col);
  }

  private activeRaw(): string {
    return this.ed.raw(this.ed.sheet, this.activeAddr());
  }

  // ── 그리기 ─────────────────────────────────────────────────

  schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  private render(): void {
    if (this.follow) {
      this.follow = false;
      this.scrollIntoView(this.activeRange());
    }
    const ed = this.ed;
    const si = ed.sheet;
    const top = this.body.scrollTop;
    const left = this.body.scrollLeft;
    const vh = this.body.clientHeight;
    const vw = this.body.clientWidth;

    // 끝 가까이 내려가면 칸을 늘린다.
    const ext = ed.extent[si]!;
    if (top + vh > this.rows.total() - 200) ext.rows += 50;
    if (left + vw > this.cols.total() - 200) ext.cols += 10;
    this.syncExtent();

    const r0 = Math.max(1, this.rows.at(top) - OVERSCAN);
    const r1 = Math.min(this.rows.count, this.rows.at(top + vh) + OVERSCAN);
    const c0 = Math.max(1, this.cols.at(left) - OVERSCAN);
    const c1 = Math.min(this.cols.count, this.cols.at(left + vw) + OVERSCAN);

    // 화면에 걸친 병합
    const covered = new Set<string>();
    const html: string[] = [];
    const cell = (r: RangePos, row: number, col: number, merged: boolean): void => {
      const rect = this.rectOf(r);
      if (rect.w <= 0 || rect.h <= 0) return;
      const d = ed.display(si, row, col);
      html.push(
        `<div class="c s${d.style} a-${d.align}${merged ? ' m' : ''}" style="left:${rect.x}px;top:${rect.y}px;width:${rect.w}px;height:${rect.h}px">${d.text ? `<span>${esc(d.text)}</span>` : ''}</div>`,
      );
    };
    for (const m of ed.mergesOf(si)) {
      const g = m.range;
      if (g.to.row < r0 || g.from.row > r1 || g.to.col < c0 || g.from.col > c1) continue;
      for (let r = Math.max(g.from.row, r0); r <= Math.min(g.to.row, r1); r++) {
        for (let c = Math.max(g.from.col, c0); c <= Math.min(g.to.col, c1); c++) covered.add(`${r},${c}`);
      }
      cell(g, g.from.row, g.from.col, true);
    }
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        if (covered.has(`${r},${c}`)) continue;
        cell({ from: { row: r, col: c }, to: { row: r, col: c } }, r, c, false);
      }
    }
    this.cellsEl.innerHTML = html.join('');

    // 머리글
    const sel = this.expand(rangeOf(ed.selection));
    const colHtml: string[] = [];
    for (let c = c0; c <= c1; c++) {
      const w = this.cols.sizeOf(c);
      if (w <= 0) continue;
      const on = c >= sel.from.col && c <= sel.to.col ? ' on' : '';
      colHtml.push(`<div class="hc${on}" style="left:${this.cols.start(c)}px;width:${w}px">${colName(c)}</div>`);
    }
    this.colInner.innerHTML = colHtml.join('');
    this.colInner.style.transform = `translateX(${-left}px)`;
    const rowHtml: string[] = [];
    for (let r = r0; r <= r1; r++) {
      const hgt = this.rows.sizeOf(r);
      if (hgt <= 0) continue;
      const on = r >= sel.from.row && r <= sel.to.row ? ' on' : '';
      rowHtml.push(`<div class="hr${on}" style="top:${this.rows.start(r)}px;height:${hgt}px">${r}</div>`);
    }
    this.rowInner.innerHTML = rowHtml.join('');
    this.rowInner.style.transform = `translateY(${-top}px)`;

    this.drawSelection(sel);
    this.addrBox.value = rangeOf(ed.selection).from.row === rangeOf(ed.selection).to.row && rangeOf(ed.selection).from.col === rangeOf(ed.selection).to.col
      ? this.activeAddr()
      : `${addrOf(sel.from.row, sel.from.col)}:${addrOf(sel.to.row, sel.to.col)}`;
  }

  private box(cls: string, r: RangePos, color?: string): HTMLDivElement {
    const rect = this.rectOf(r);
    const el = h('div', { class: cls });
    el.style.cssText = `left:${rect.x}px;top:${rect.y}px;width:${rect.w}px;height:${rect.h}px`;
    if (color) el.style.setProperty('--c', color);
    this.overlay.append(el);
    return el;
  }

  private drawSelection(sel: RangePos): void {
    this.overlay.replaceChildren();
    for (const p of this.ed.peers()) {
      if (p.me || p.sheet !== this.ed.sheet || !p.sel || !p.head) continue;
      this.box('peer-range', this.expand(p.sel), p.user.color);
      const head = this.ed.mergeAt(this.ed.sheet, p.head) ?? { from: p.head, to: p.head };
      const el = this.box(`peer-cell${p.editing ? ' editing' : ''}`, head, p.user.color);
      el.append(h('span', {}, p.editing ? `${p.user.name} 입력 중` : p.user.name));
    }
    const multi = sel.from.row !== sel.to.row || sel.from.col !== sel.to.col;
    if (multi) this.box('my-range', sel);
    const active = this.activeRange();
    this.box(`my-cell${this.mode ? ' editing' : ''}`, active);

    // 입력란을 활성 셀 위에 둔다.
    const rect = this.rectOf(active);
    const st = this.ed.style(this.ed.styleIndex(this.ed.sheet, this.activeAddr()));
    this.input.style.left = `${rect.x}px`;
    this.input.style.top = `${rect.y}px`;
    this.input.style.minWidth = `${Math.max(rect.w, 20)}px`;
    this.input.style.minHeight = `${Math.max(rect.h, 18)}px`;
    this.input.style.fontSize = st.size ? `${((st.size * 4) / 3).toFixed(1)}px` : '';
    this.input.style.fontWeight = st.bold ? '700' : '';
  }

  private scrollIntoView(r: RangePos): void {
    const rect = this.rectOf(r);
    const b = this.body;
    if (rect.y < b.scrollTop) b.scrollTop = rect.y;
    else if (rect.y + rect.h > b.scrollTop + b.clientHeight) b.scrollTop = rect.y + rect.h - b.clientHeight;
    if (rect.x < b.scrollLeft) b.scrollLeft = rect.x;
    else if (rect.x + rect.w > b.scrollLeft + b.clientWidth) b.scrollLeft = rect.x + rect.w - b.clientWidth;
  }

  private renderTabs(): void {
    this.tabs.replaceChildren(
      ...this.ed.model.sheets.flatMap((s, i) =>
        s.hidden
          ? []
          : h(
              'button',
              {
                class: 'tab',
                type: 'button',
                role: 'tab',
                'aria-selected': String(i === this.ed.sheet),
                onclick: () => {
                  this.commit();
                  this.ed.setSheet(i);
                  this.focus();
                },
              },
              s.name,
            ),
      ),
    );
  }

  // ── 편집 ───────────────────────────────────────────────────

  private startEdit(mode: Exclude<EditMode, null>, initial?: string): void {
    this.mode = mode;
    if (initial !== undefined) {
      this.input.value = initial;
      this.fx.value = initial;
    }
    this.input.classList.add('editing');
    this.ed.setEditing(true);
    if (mode !== 'bar') {
      const end = this.input.value.length;
      this.input.setSelectionRange(end, end);
    }
    this.autosize();
    this.schedule();
  }

  private endEdit(): void {
    this.mode = null;
    this.input.value = '';
    this.input.classList.remove('editing');
    this.input.style.width = '';
    this.ed.setEditing(false);
    this.fx.value = this.activeRaw();
    this.schedule();
  }

  /** 입력 중인 내용을 셀에 넣는다. */
  commit(move?: [number, number]): void {
    if (!this.mode) {
      if (move) this.ed.move(move[0], move[1]);
      return;
    }
    const text = this.mode === 'bar' ? this.fx.value : this.input.value;
    const addr = this.activeAddr();
    this.ed.commit(this.ed.sheet, addr, text);
    this.endEdit();
    if (move) this.ed.move(move[0], move[1]);
    this.focus();
  }

  private cancel(): void {
    this.endEdit();
    this.focus();
  }

  private autosize(): void {
    if (!this.mode) return;
    this.input.style.width = '';
    this.input.style.width = `${Math.min(this.input.scrollWidth + 6, 900)}px`;
  }

  private cellAt(clientX: number, clientY: number): CellPos {
    const rect = this.canvas.getBoundingClientRect();
    return { col: this.cols.at(clientX - rect.left), row: this.rows.at(clientY - rect.top) };
  }

  private jump(dRow: number, dCol: number, extend: boolean): void {
    const sheet = this.ed.model.sheets[this.ed.sheet]!;
    const s = this.ed.selection;
    const target = {
      row: dRow < 0 ? 1 : dRow > 0 ? Math.max(sheet.maxRow, 1) : s.head.row,
      col: dCol < 0 ? 1 : dCol > 0 ? Math.max(sheet.maxCol, 1) : s.head.col,
    };
    this.ed.select(extend ? s.anchor : target, target);
  }

  private bind(): void {
    const ed = this.ed;
    const ta = this.input;

    this.body.addEventListener('scroll', () => this.schedule(), { passive: true });
    const ro = new ResizeObserver(() => this.schedule());
    ro.observe(this.body);
    this.offs.push(() => ro.disconnect());

    ta.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      const mod = e.ctrlKey || e.metaKey;
      if (this.mode) {
        let handled = true;
        if (e.key === 'Enter' && e.altKey) {
          ta.setRangeText('\n', ta.selectionStart, ta.selectionEnd, 'end');
          this.fx.value = ta.value;
          this.autosize();
        } else if (e.key === 'Enter') this.commit([e.shiftKey ? -1 : 1, 0]);
        else if (e.key === 'Tab') this.commit([0, e.shiftKey ? -1 : 1]);
        else if (e.key === 'Escape') this.cancel();
        else if (this.mode === 'enter' && e.key.startsWith('Arrow')) {
          const d: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
          this.commit(d[e.key]);
        } else handled = false;
        if (handled) e.preventDefault();
        return;
      }
      const page = Math.max(1, Math.floor(this.body.clientHeight / 22) - 1);
      let handled = true;
      switch (e.key) {
        case 'ArrowUp':
          if (mod) this.jump(-1, 0, e.shiftKey);
          else ed.move(-1, 0, e.shiftKey);
          break;
        case 'ArrowDown':
          if (mod) this.jump(1, 0, e.shiftKey);
          else ed.move(1, 0, e.shiftKey);
          break;
        case 'ArrowLeft':
          if (mod) this.jump(0, -1, e.shiftKey);
          else ed.move(0, -1, e.shiftKey);
          break;
        case 'ArrowRight':
          if (mod) this.jump(0, 1, e.shiftKey);
          else ed.move(0, 1, e.shiftKey);
          break;
        case 'PageDown':
          ed.move(page, 0, e.shiftKey);
          break;
        case 'PageUp':
          ed.move(-page, 0, e.shiftKey);
          break;
        case 'Home':
          if (mod) ed.select({ row: 1, col: 1 });
          else ed.select({ row: ed.selection.head.row, col: 1 });
          break;
        case 'Enter':
          ed.move(e.shiftKey ? -1 : 1, 0);
          break;
        case 'Tab':
          ed.move(0, e.shiftKey ? -1 : 1);
          break;
        case 'F2':
          this.startEdit('edit', this.activeRaw());
          break;
        case 'Delete':
        case 'Backspace':
          ed.clearRange(ed.sheet, this.expand(rangeOf(ed.selection)));
          break;
        default:
          handled = false;
          if (mod && !e.altKey) {
            handled = true;
            switch (e.key.toLowerCase()) {
              case 'z':
                if (e.shiftKey) ed.redo();
                else ed.undo();
                break;
              case 'y':
                ed.redo();
                break;
              case 'a':
                ed.select({ row: 1, col: 1 }, { row: Math.max(1, ed.model.sheets[ed.sheet]!.maxRow), col: Math.max(1, ed.model.sheets[ed.sheet]!.maxCol) });
                break;
              default:
                handled = false; // 복사·붙여넣기는 아래 이벤트로
            }
          }
      }
      if (handled) e.preventDefault();
    });

    // 글자를 치기 시작하면 (한글 조합 포함) 그 셀을 새로 입력한다.
    ta.addEventListener('compositionstart', () => {
      if (!this.mode) this.startEdit('enter');
    });
    ta.addEventListener('input', () => {
      if (!this.mode) this.startEdit('enter');
      this.fx.value = ta.value;
      this.autosize();
    });

    ta.addEventListener('copy', (e) => {
      if (this.mode || !e.clipboardData) return;
      e.clipboardData.setData('text/plain', ed.copyText(ed.sheet, this.expand(rangeOf(ed.selection))));
      e.preventDefault();
    });
    ta.addEventListener('cut', (e) => {
      if (this.mode || !e.clipboardData) return;
      const r = this.expand(rangeOf(ed.selection));
      e.clipboardData.setData('text/plain', ed.copyText(ed.sheet, r));
      e.preventDefault();
      ed.clearRange(ed.sheet, r);
    });
    ta.addEventListener('paste', (e) => {
      if (this.mode) return;
      const text = e.clipboardData?.getData('text/plain') ?? '';
      e.preventDefault();
      if (!text) return;
      const r = ed.paste(ed.sheet, rangeOf(ed.selection).from, parseTsv(text));
      ed.select(r.from, r.to);
    });
    ta.addEventListener('focus', () => this.root.classList.add('focused'));
    ta.addEventListener('blur', () => this.root.classList.remove('focused'));

    // 수식 입력줄
    this.fx.addEventListener('focus', () => {
      if (this.mode === 'enter' || this.mode === 'edit') {
        this.mode = 'bar';
        return;
      }
      if (!this.mode) this.startEdit('bar', this.activeRaw());
    });
    this.fx.addEventListener('input', () => {
      if (!this.mode) this.startEdit('bar');
      ta.value = this.fx.value;
      this.autosize();
    });
    this.fx.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        this.commit([1, 0]);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        this.commit([0, e.shiftKey ? -1 : 1]);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.cancel();
      }
    });

    // 마우스: 누르면 선택, 끌면 범위, 두 번 누르면 편집
    this.body.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target === ta) return;
      e.preventDefault();
      if (this.mode) this.commit();
      const pos = this.cellAt(e.clientX, e.clientY);
      const m = ed.mergeAt(ed.sheet, pos);
      const target = m ? m.from : pos;
      if (e.shiftKey) ed.select(ed.selection.anchor, target);
      else ed.select(target);
      this.focus();
      this.dragging = true;
      this.body.setPointerCapture(e.pointerId);
    });
    this.body.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      const pos = this.cellAt(e.clientX, e.clientY);
      const s = ed.selection;
      if (pos.row !== s.head.row || pos.col !== s.head.col) ed.select(s.anchor, pos);
    });
    const stop = (e: PointerEvent): void => {
      this.dragging = false;
      if (this.body.hasPointerCapture(e.pointerId)) this.body.releasePointerCapture(e.pointerId);
    };
    this.body.addEventListener('pointerup', stop);
    this.body.addEventListener('pointercancel', stop);
    this.body.addEventListener('dblclick', (e) => {
      if (e.target === ta) return;
      this.startEdit('edit', this.activeRaw());
      this.focus();
    });
  }
}
