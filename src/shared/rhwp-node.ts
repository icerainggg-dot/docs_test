// Node 에서 rHWP(WASM) 를 쓰기 위한 초기화. 서버와 시험 코드가 함께 쓴다.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import init, { HwpDocument } from '@rhwp/core';

declare global {
  // rHWP 가 조판할 때 부르는 글자 폭 측정 함수
  var measureTextWidth: ((font: string, text: string) => number) | undefined;
}

let ready: Promise<unknown> | null = null;

// 서버에는 화면이 없으므로 글자 폭을 어림한다. (쪽 나눔 계산에만 쓰이고 저장 내용에는
// 영향을 주지 않는다. 화면 조판은 각 브라우저가 실제 글꼴로 다시 한다.)
function approxTextWidth(font: string, text: string): number {
  const m = /(\d+(?:\.\d+)?)px/.exec(font);
  const size = m ? Number(m[1]) : 13.3;
  let w = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    w += c >= 0x1100 ? size : c === 0x20 ? size * 0.3 : size * 0.55;
  }
  return w;
}

export function initRhwp(): Promise<unknown> {
  if (!ready) {
    globalThis.measureTextWidth ??= approxTextWidth;
    const require = createRequire(import.meta.url);
    const wasm = readFileSync(require.resolve('@rhwp/core/rhwp_bg.wasm'));
    ready = init({ module_or_path: wasm });
  }
  return ready;
}

export function openDocument(bytes: Uint8Array | ArrayBuffer): HwpDocument {
  return new HwpDocument(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
}

/** 빈 문서의 HWPX 바이트 */
export function blankHwpx(): Uint8Array {
  const doc = HwpDocument.createEmpty();
  try {
    doc.createBlankDocument();
    return doc.exportHwpx();
  } finally {
    doc.free();
  }
}

export { HwpDocument };
