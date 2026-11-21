// Y 문서 ↔ 고친 셀 목록

import type * as Y from 'yjs';
import { parseAddr } from './addr.ts';
import type { Edits } from './write.ts';
import { CELLS, splitCellKey } from './types.ts';
import type { CellInput } from './types.ts';

export const getCells = (ydoc: Y.Doc): Y.Map<CellInput> => ydoc.getMap<CellInput>(CELLS);

const VALID = new Set(['n', 's', 'b', 'f', 'z']);

/** 들어온 값이 올바른 셀 입력인지 (다른 사람이 보낸 값이므로 확인한다) */
export function isCellInput(v: unknown): v is CellInput {
  if (!v || typeof v !== 'object') return false;
  const c = v as Record<string, unknown>;
  if (typeof c.t !== 'string' || !VALID.has(c.t)) return false;
  switch (c.t) {
    case 'n':
      return typeof c.v === 'number' && Number.isFinite(c.v);
    case 's':
      return typeof c.v === 'string' && c.v.length <= 32767;
    case 'b':
      return typeof c.v === 'boolean';
    case 'f':
      return typeof c.f === 'string' && c.f.length <= 8192;
    default:
      return true;
  }
}

/** Y 문서의 고친 셀을 시트별로 모은다. 잘못된 열쇠·값은 버린다. */
export function editsFromYDoc(ydoc: Y.Doc, sheetCount: number): Edits {
  const edits: Edits = new Map();
  for (const [key, value] of getCells(ydoc)) {
    const k = splitCellKey(key);
    if (!k || !Number.isInteger(k.sheet) || k.sheet < 0 || k.sheet >= sheetCount) continue;
    const pos = parseAddr(k.addr);
    if (!pos || pos.row > 1048576 || pos.col > 16384 || !isCellInput(value)) continue;
    let m = edits.get(k.sheet);
    if (!m) edits.set(k.sheet, (m = new Map()));
    m.set(k.addr, value);
  }
  return edits;
}
