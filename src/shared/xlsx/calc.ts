// 수식 계산. 브라우저(화면)와 서버(저장할 때 캐시 값)가 같은 코드를 쓴다.

import FormulaParser from 'fast-formula-parser';
import type { CellRef, RangeRef } from 'fast-formula-parser';
import { addrOf, parseAddr, parseRange } from './addr.ts';
import type { CellValue } from './format.ts';
import type { BaseCell, CellInput, WorkbookModel } from './types.ts';

/** (시트 번호, 주소) → 지금 셀에 들어 있는 입력. 고친 적 없으면 원본 셀. */
export type InputSource = (sheet: number, addr: string) => CellInput | BaseCell | undefined;

const { FormulaError } = FormulaParser;
const CYCLE: CellValue = { error: '#CYCLE!' };

function toCellValue(v: unknown): CellValue {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) return toCellValue(Array.isArray(v[0]) ? v[0][0] : v[0]);
  const e = v as { _error?: string; error?: string };
  if (typeof e._error === 'string') return { error: e._error };
  if (typeof e.error === 'string') return { error: e.error };
  return { error: '#VALUE!' };
}

/** 수식이 쓰는 값 (빈 셀은 null) */
function plain(v: CellValue): unknown {
  if (v !== null && typeof v === 'object') return new FormulaError(v.error === '#CYCLE!' ? '#REF!' : v.error);
  return v;
}

export class Calculator {
  readonly model: WorkbookModel;
  private readonly source: InputSource;
  private readonly memo = new Map<string, CellValue>();
  private readonly busy = new Set<string>();
  private readonly sheetIndex = new Map<string, number>();
  /** 계산기는 재진입할 수 없으므로 수식 안의 수식은 한 단계 깊은 계산기로 푼다. */
  private readonly parsers: FormulaParser[] = [];
  private depth = 0;
  /** 계산 중 순환 참조를 만났는지 */
  private cycled = false;

  constructor(model: WorkbookModel, source: InputSource) {
    this.model = model;
    this.source = source;
    model.sheets.forEach((s, i) => this.sheetIndex.set(s.name.toUpperCase(), i));
  }

  private parse(formula: string, sheet: number, addr: string): unknown {
    const pos = parseAddr(addr)!;
    const parser = (this.parsers[this.depth] ??= new FormulaParser({
      onCell: (ref: CellRef) => plain(this.valueByName(ref.sheet, ref.row, ref.col)),
      onRange: (ref: RangeRef) => this.range(ref),
      onVariable: (name: string) => this.variable(name),
    }));
    this.depth++;
    try {
      return parser.parse(formula, { sheet: this.model.sheets[sheet]!.name, row: pos.row, col: pos.col }, false);
    } finally {
      this.depth--;
    }
  }

  /** 입력이 바뀌면 부른다. */
  invalidate(): void {
    this.memo.clear();
  }

  private sheetNo(name: string): number {
    return this.sheetIndex.get(name.toUpperCase()) ?? -1;
  }

  private valueByName(sheet: string, row: number, col: number): CellValue {
    const si = this.sheetNo(sheet);
    if (si < 0) return { error: '#REF!' };
    return this.value(si, addrOf(row, col));
  }

  private range(ref: RangeRef): unknown[][] {
    const si = this.sheetNo(ref.sheet);
    const sheet = this.model.sheets[si];
    if (!sheet) return [[{ _error: '#REF!' }]];
    // 열 전체(A:A)·행 전체(1:1) 참조는 쓰인 범위까지만 본다.
    const lastRow = Math.min(ref.to.row, Math.max(sheet.maxRow, 1) + 1000);
    const lastCol = Math.min(ref.to.col, Math.max(sheet.maxCol, 1) + 100);
    const out: unknown[][] = [];
    for (let r = ref.from.row; r <= lastRow; r++) {
      const row: unknown[] = [];
      for (let c = ref.from.col; c <= lastCol; c++) row.push(plain(this.value(si, addrOf(r, c))));
      out.push(row);
    }
    return out;
  }

  private variable(name: string): CellRef | RangeRef | null {
    const ref = this.model.names[name.toUpperCase()];
    if (!ref) return null;
    const bang = ref.lastIndexOf('!');
    const sheet = bang > 0 ? ref.slice(0, bang).replace(/^'|'$/g, '').replace(/''/g, "'") : this.model.sheets[0]!.name;
    const rg = parseRange(bang > 0 ? ref.slice(bang + 1) : ref);
    if (!rg) return null;
    if (rg.from.row === rg.to.row && rg.from.col === rg.to.col) return { sheet, row: rg.from.row, col: rg.from.col };
    return { sheet, from: rg.from, to: rg.to };
  }

  /** 셀의 현재 값 (수식이면 계산) */
  value(sheet: number, addr: string): CellValue {
    const input = this.source(sheet, addr);
    if (!input) return null;
    if (input.t === 'z') return null;
    const formula = input.t === 'f' ? input.f : 'f' in input && !(input as BaseCell).arr ? input.f : undefined;
    if (formula === undefined) {
      if (input.t === 'f') return null;
      const v = (input as { v: number | string | boolean }).v;
      if (input.t === 'e') return { error: String(v) };
      return v === '' ? null : v;
    }
    const key = `${sheet}:${addr}`;
    const hit = this.memo.get(key);
    if (hit !== undefined) return hit;
    if (this.busy.has(key)) {
      this.cycled = true;
      return CYCLE;
    }
    const outer = this.busy.size === 0;
    if (outer) this.cycled = false;
    this.busy.add(key);
    let result: CellValue;
    try {
      result = this.evaluate(sheet, addr, formula, input);
    } finally {
      this.busy.delete(key);
    }
    // 순환에 걸린 계산은 모두 #CYCLE! 로 표시한다.
    if (this.cycled) result = CYCLE;
    if (outer) this.cycled = false;
    this.memo.set(key, result);
    return result;
  }

  /** 수식을 계산한다. 지원하지 않는 함수면 원본에 저장된 값을 쓴다. */
  private evaluate(sheet: number, addr: string, formula: string, input: CellInput | BaseCell): CellValue {
    try {
      return toCellValue(this.parse(formula, sheet, addr));
    } catch (e) {
      const base = this.model.sheets[sheet]!.cells[addr];
      if (base && base.f === formula && input === base) return base.t === 'e' ? { error: String(base.v) } : base.v;
      const msg = (e as { error?: string; message?: string }).error ?? (e as Error).message ?? '';
      return { error: /not implemented/i.test((e as Error).message ?? '') ? '#NAME?' : msg.startsWith('#') ? msg.split(' ')[0]! : '#VALUE!' };
    }
  }

  /** 이 수식을 우리 계산기가 계산할 수 있는지 (지원하지 않는 함수가 있으면 false) */
  canEvaluate(sheet: number, addr: string): boolean {
    const input = this.source(sheet, addr);
    const formula = input && (input.t === 'f' ? input.f : 'f' in input ? input.f : undefined);
    if (!formula) return true;
    try {
      this.parse(formula, sheet, addr);
      return true;
    } catch (e) {
      return !/not implemented|#ERROR!/i.test(String((e as Error).message ?? e));
    }
  }
}

export { parseRange };
