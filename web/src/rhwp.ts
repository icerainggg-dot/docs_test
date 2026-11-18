// 브라우저에서 rHWP(WASM) 초기화
import init, { HwpDocument } from '@rhwp/core';
import wasmUrl from '@rhwp/core/rhwp_bg.wasm?url';

declare global {
  // rHWP 가 조판할 때 부르는 글자 폭 측정 함수
  var measureTextWidth: ((font: string, text: string) => number) | undefined;
}

let ready: Promise<unknown> | null = null;

function installMeasure(): void {
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) throw new Error('이 브라우저는 canvas 를 쓸 수 없습니다.');
  const cache = new Map<string, number>();
  let lastFont = '';
  globalThis.measureTextWidth = (font, text) => {
    const key = font + '\u0000' + text;
    let w = cache.get(key);
    if (w === undefined) {
      if (font !== lastFont) {
        ctx.font = font;
        lastFont = font;
      }
      w = ctx.measureText(text).width;
      if (cache.size > 50000) cache.clear();
      cache.set(key, w);
    }
    return w;
  };
}

export function initRhwp(): Promise<unknown> {
  if (!ready) {
    installMeasure();
    ready = init({ module_or_path: wasmUrl });
  }
  return ready;
}

export { HwpDocument };
