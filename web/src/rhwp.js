// 브라우저에서 rHWP(WASM) 초기화
import init, { HwpDocument } from '@rhwp/core';
import wasmUrl from '@rhwp/core/rhwp_bg.wasm?url';

let ready = null;

function installMeasure() {
  const ctx = document.createElement('canvas').getContext('2d');
  const cache = new Map();
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

export function initRhwp() {
  if (!ready) {
    installMeasure();
    ready = init({ module_or_path: wasmUrl });
  }
  return ready;
}

export { HwpDocument };
