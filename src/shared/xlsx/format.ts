// 숫자 서식 (SheetJS SSF) 과 셀 값 → 화면 글자

import SSF from 'fast-formula-parser/ssf/ssf.js';
import type { BaseCell, CellInput } from './types.ts';

// 한국어 엑셀의 기본 날짜 서식에 맞춘다.
const KO_OVERRIDES: Record<number, string> = {
  14: 'yyyy-mm-dd',
  15: 'd-mmm-yy',
  16: 'd-mmm',
  17: 'mmm-yy',
  22: 'yyyy-mm-dd h:mm',
};

let table: Record<number, string> | null = null;

export function builtinFormat(id: number): string {
  table ??= SSF.get_table();
  return KO_OVERRIDES[id] ?? table[id] ?? 'General';
}

/** 계산된 셀 값 */
export type CellValue = number | string | boolean | null | { error: string };

export const isError = (v: CellValue): v is { error: string } => typeof v === 'object' && v !== null;

export function formatValue(value: CellValue, numFmt = 'General'): string {
  if (value === null || value === '') return '';
  if (isError(value)) return value.error;
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'string') {
    // 글자 서식(@)이나 "…"@ 형태만 글자에 적용한다.
    if (numFmt.includes('@') && numFmt !== '@') {
      try {
        return SSF.format(numFmt, value);
      } catch {
        return value;
      }
    }
    return value;
  }
  if (!Number.isFinite(value)) return '#NUM!';
  try {
    return SSF.format(numFmt || 'General', value);
  } catch {
    return SSF.format('General', value);
  }
}

/** 편집할 때 보여 줄 원래 입력 */
export function inputText(input: CellInput | BaseCell | undefined): string {
  if (!input) return '';
  if ('f' in input && input.f !== undefined) return `=${input.f}`;
  switch (input.t) {
    case 'z':
      return '';
    case 'n':
      return typeof input.v === 'number' ? String(input.v) : String(input.v ?? '');
    case 'b':
      return input.v ? 'TRUE' : 'FALSE';
    case 'f':
      return '';
    default:
      return String(input.v ?? '');
  }
}

/** 사람이 친 글자 → 셀 입력 */
export function parseInput(text: string): CellInput {
  if (text === '') return { t: 'z' };
  if (text.length > 1 && text[0] === '=') return { t: 'f', f: text.slice(1) };
  if (text[0] === "'") return { t: 's', v: text.slice(1) };
  const trimmed = text.trim();
  const upper = trimmed.toUpperCase();
  if (upper === 'TRUE' || upper === 'FALSE') return { t: 'b', v: upper === 'TRUE' };
  const num = /^[+-]?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?([eE][+-]?\d+)?%?$/;
  if (trimmed && /\d/.test(trimmed) && num.test(trimmed)) {
    const pct = trimmed.endsWith('%');
    const n = Number(trimmed.replace(/,/g, '').replace('%', ''));
    if (Number.isFinite(n)) return { t: 'n', v: pct ? n / 100 : n };
  }
  return { t: 's', v: text };
}
