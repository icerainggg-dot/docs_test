// 저장 워커: 원본 파일 + Y 문서 상태 → HWPX.
// 브라우저의 편집기와 같은 Reconciler 를 화면 없이 돌린다.

import type * as Y from 'yjs';
import { openDocument } from '../src/shared/rhwp-node.ts';
import { Reconciler } from '../src/shared/reconciler.ts';
import type { Diff } from '../src/shared/reconciler.ts';
import { patchXlsx, verifyXlsx } from '../src/shared/xlsx/write.ts';
import type { XlsxDiff } from '../src/shared/xlsx/write.ts';
import { editsFromYDoc } from '../src/shared/xlsx/sheetdoc.ts';
import type { WorkbookModel } from '../src/shared/xlsx/types.ts';

export type SaveIssue = Diff | { warning: string } | (Diff & { stage: 'reopen' }) | { stage: 'reopen'; error: string };

export interface RenderResult {
  bytes: Uint8Array;
  /** 저장 호환성 검사 결과 — 만든 HWPX 를 다시 열었을 때 Y 상태와 다른 곳 */
  diffs: SaveIssue[];
}

export function renderHwpx(baseBytes: Uint8Array, ydoc: Y.Doc): RenderResult {
  const doc = openDocument(baseBytes);
  let bytes: Uint8Array;
  const diffs: SaveIssue[] = [];
  try {
    const rec = new Reconciler(doc, ydoc);
    rec.syncAll();
    for (const w of rec.warnings) diffs.push({ warning: w });
    diffs.push(...rec.verify());
    bytes = doc.exportHwpx();
  } finally {
    doc.free();
  }

  // 회귀 검사: 방금 만든 파일을 다시 열어 글자가 그대로인지 확인한다.
  try {
    const reopened = openDocument(bytes);
    try {
      const check = new Reconciler(reopened, ydoc);
      diffs.push(...check.verify().map((d) => ({ ...d, stage: 'reopen' as const })));
    } finally {
      reopened.free();
    }
  } catch (e) {
    diffs.push({ stage: 'reopen', error: String(e) });
  }
  return { bytes, diffs };
}

/** XLSX 저장: 원본 + 고친 셀 → XLSX, 그리고 다시 읽어 고친 셀이 들어 있는지 검사 */
export function renderXlsx(baseBytes: Uint8Array, model: WorkbookModel, ydoc: Y.Doc): { bytes: Uint8Array; diffs: (XlsxDiff | { stage: 'reopen'; error: string })[] } {
  const edits = editsFromYDoc(ydoc, model.sheets.length);
  const bytes = patchXlsx(baseBytes, model, edits);
  try {
    return { bytes, diffs: verifyXlsx(bytes, edits) };
  } catch (e) {
    return { bytes, diffs: [{ stage: 'reopen', error: String(e) }] };
  }
}
