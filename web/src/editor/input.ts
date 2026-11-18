// 키보드·한글 입력기·마우스 입력을 편집 명령으로 바꾼다.

import type { Editor } from './editor.ts';
import type { View } from './view.ts';

export function bindInput(editor: Editor, view: View): void {
  const ta = view.input;
  const pagesEl = view.pagesEl;
  let composing = false;

  const mod = (e: KeyboardEvent): boolean => e.ctrlKey || e.metaKey;

  /** Ctrl/⌘ 와 함께 누른 글쇠. 처리했으면 true. */
  const shortcut = (e: KeyboardEvent): boolean => {
    switch (e.key.toLowerCase()) {
      case 'b':
        editor.toggleFormat('b');
        return true;
      case 'i':
        editor.toggleFormat('i');
        return true;
      case 'u':
        editor.toggleFormat('u');
        return true;
      case 'z':
        if (e.shiftKey) editor.redo();
        else editor.undo();
        return true;
      case 'y':
        editor.redo();
        return true;
      case 'a':
        editor.selectAll();
        return true;
      default:
        return false; // 복사·붙여넣기 등은 브라우저 기본 동작 → 아래 이벤트로 처리
    }
  };

  ta.addEventListener('keydown', (e) => {
    if (composing || e.isComposing || e.keyCode === 229) return;
    const shift = e.shiftKey;
    let handled = true;
    switch (e.key) {
      case 'ArrowLeft':
        editor.moveChar(-1, shift);
        break;
      case 'ArrowRight':
        editor.moveChar(1, shift);
        break;
      case 'ArrowUp':
        editor.moveLine(-1, shift);
        break;
      case 'ArrowDown':
        editor.moveLine(1, shift);
        break;
      case 'Home':
        if (mod(e)) editor.moveDocEdge(false, shift);
        else editor.moveLineEdge(false, shift);
        break;
      case 'End':
        if (mod(e)) editor.moveDocEdge(true, shift);
        else editor.moveLineEdge(true, shift);
        break;
      case 'Backspace':
        editor.backspace();
        break;
      case 'Delete':
        editor.del();
        break;
      case 'Enter':
        editor.enter();
        break;
      case 'Tab':
        editor.type('\t');
        break;
      default:
        handled = mod(e) && !e.altKey && shortcut(e);
    }
    if (handled) e.preventDefault();
  });

  ta.addEventListener('compositionstart', () => {
    composing = true;
    editor.beginComposition();
  });
  ta.addEventListener('compositionupdate', (e) => {
    editor.updateComposition(e.data || '');
  });
  ta.addEventListener('compositionend', (e) => {
    composing = false;
    editor.endComposition(e.data || '');
    ta.value = '';
  });
  ta.addEventListener('input', (e) => {
    if (composing || (e as InputEvent).isComposing) return;
    const text = ta.value;
    ta.value = '';
    if (text) editor.type(text);
  });

  ta.addEventListener('copy', (e) => {
    const text = editor.selectedText();
    if (!text || !e.clipboardData) return;
    e.clipboardData.setData('text/plain', text);
    e.preventDefault();
  });
  ta.addEventListener('cut', (e) => {
    const text = editor.selectedText();
    if (!text || !e.clipboardData) return;
    e.clipboardData.setData('text/plain', text);
    e.preventDefault();
    editor.deleteSelection();
  });
  ta.addEventListener('paste', (e) => {
    const text = e.clipboardData?.getData('text/plain') ?? '';
    e.preventDefault();
    if (text) editor.type(text);
  });

  ta.addEventListener('focus', () => view.scroller.classList.add('focused'));
  ta.addEventListener('blur', () => view.scroller.classList.remove('focused'));

  // 마우스: 누르면 커서, 끌면 선택, 두 번 누르면 낱말 선택
  let dragging = false;
  pagesEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    view.focus();
    const pos = view.posFromPoint(e.clientX, e.clientY);
    if (!pos) return;
    editor.moveHead(pos, e.shiftKey);
    if (e.detail === 2) {
      editor.selectWord();
      return;
    }
    dragging = true;
    pagesEl.setPointerCapture(e.pointerId);
  });
  pagesEl.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const pos = view.posFromPoint(e.clientX, e.clientY);
    if (pos) editor.moveHead(pos, true);
  });
  const stop = (e: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    if (pagesEl.hasPointerCapture(e.pointerId)) pagesEl.releasePointerCapture(e.pointerId);
  };
  pagesEl.addEventListener('pointerup', stop);
  pagesEl.addEventListener('pointercancel', stop);
}
