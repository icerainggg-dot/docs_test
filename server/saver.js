// 저장 워커: 원본 파일 + Y 문서 상태 → HWPX.
// 브라우저의 편집기와 같은 Reconciler 를 화면 없이 돌린다.

import { openDocument } from '../src/shared/rhwp-node.js';
import { Reconciler } from '../src/shared/reconciler.js';

/**
 * @returns {{ bytes: Uint8Array, diffs: object[] }}
 *   diffs 는 저장 호환성 검사 결과 — 만든 HWPX 를 다시 열었을 때 Y 상태와 다른 곳.
 */
export function renderHwpx(baseBytes, ydoc) {
  const doc = openDocument(baseBytes);
  let bytes;
  const diffs = [];
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
  const reopened = openDocument(bytes);
  try {
    const check = new Reconciler(reopened, ydoc);
    diffs.push(...check.verify().map((d) => ({ ...d, stage: 'reopen' })));
  } catch (e) {
    diffs.push({ stage: 'reopen', error: String(e) });
  } finally {
    reopened.free();
  }
  return { bytes, diffs };
}
