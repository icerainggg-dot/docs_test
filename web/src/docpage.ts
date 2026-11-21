// 한글(HWPX) 편집 화면: 도구 모음 + 편집기 + 접속/저장 상태

import { api, h, errorMessage } from './api.ts';
import type { DocInfo } from './api.ts';
import { session, colorFor } from './session.ts';
import { initRhwp, HwpDocument } from './rhwp.ts';
import { Editor } from './editor/editor.ts';
import { View } from './editor/view.ts';
import { bindInput } from './editor/input.ts';
import { connectCollab, denyOverlay, flasher, titleField, shareButton, peerAvatars, statusWidgets } from './shell.ts';

declare global {
  interface Window {
    /** 자동 시험·디버깅용 */
    __editor?: Editor;
  }
}

type FormatAttr = 'b' | 'i' | 'u' | 's';
const SUFFIX = '한글 동시편집';

export async function showDoc(root: HTMLElement, meta: DocInfo): Promise<() => void> {
  const id = meta.id;
  const message = h('p', { class: 'loading', role: 'status' }, '문서를 여는 중…');
  root.append(message);
  const cleanups: (() => void)[] = [];
  const cleanup = (): void => cleanups.splice(0).reverse().forEach((fn) => fn());
  const backLink = (): HTMLAnchorElement => h('a', { href: '#/' }, '목록으로');

  let hwp: HwpDocument;
  try {
    const [base] = await Promise.all([api.base(id), initRhwp()]);
    const doc = new HwpDocument(base);
    hwp = doc;
    cleanups.push(() => doc.free());
  } catch (e) {
    message.replaceChildren(`문서를 열 수 없습니다: ${errorMessage(e)} `, backLink());
    return cleanup;
  }
  document.title = `${meta.title} — ${SUFFIX}`;

  const collab = connectCollab(id);
  cleanups.push(() => collab.provider.destroy());
  const ready = await collab.ready;
  const awareness = collab.provider.awareness;
  if (ready !== 'synced' || !awareness) {
    message.replaceChildren(ready === 'denied' ? '이 문서를 편집할 권한이 없습니다. ' : '동기화 서버에 연결하지 못했습니다. ', backLink());
    return cleanup;
  }

  const me = session.user!;
  let editor: Editor;
  try {
    editor = new Editor({ hwp, ydoc: collab.ydoc, awareness, user: { name: me.name, color: colorFor(me.id) } });
  } catch (e) {
    console.error(e);
    message.replaceChildren(`문서를 편집 상태로 만들지 못했습니다: ${errorMessage(e)}`);
    return cleanup;
  }
  const ed = editor;
  cleanups.push(() => ed.destroy());
  window.__editor = ed;

  const { el: flashEl, flash } = flasher();
  const scroller = h('div', { class: 'scroller' });
  const view = new View(ed, scroller);

  // ── 도구 모음 ──
  const keepFocus = (e: Event): void => e.preventDefault();
  const fmtBtn = (attr: FormatAttr, label: string, title: string): HTMLButtonElement =>
    h(
      'button',
      {
        class: `tool fmt-${attr}`,
        title,
        'aria-label': title,
        'aria-pressed': 'false',
        'data-attr': attr,
        onmousedown: keepFocus,
        onclick: () => {
          if (!ed.toggleFormat(attr)) flash('서식을 바꿀 글자를 먼저 선택하세요.');
          view.focus();
        },
      },
      label,
    );
  const tool = (label: string, title: string, fn: () => void): HTMLButtonElement =>
    h('button', { class: 'tool', title, 'aria-label': title, onmousedown: keepFocus, onclick: () => { fn(); view.focus(); } }, label);

  const colorInput = h('input', { type: 'color', class: 'tool color', title: '글자 색', 'aria-label': '글자 색', value: '#d9480f' });
  colorInput.addEventListener('change', () => {
    if (!ed.setColor(colorInput.value)) flash('색을 바꿀 글자를 먼저 선택하세요.');
    view.focus();
  });
  const zoomLabel = h('span', { class: 'zoom' }, '100%');
  const peersEl = h('div', { class: 'peers', 'aria-label': '함께 편집 중인 사람' });
  const status = statusWidgets(id, collab.provider);
  cleanups.push(status.stop);

  const setZoom = (z: number): void => {
    view.setZoom(z);
    zoomLabel.textContent = `${Math.round(view.zoom * 100)}%`;
  };

  const toolbar = h(
    'header',
    { class: 'toolbar' },
    h('a', { href: '#/', class: 'tool back', title: '문서 목록', 'aria-label': '문서 목록' }, '←'),
    titleField(meta, flash, SUFFIX),
    h('span', { class: 'sep' }),
    tool('↶', '실행 취소 (Ctrl+Z)', () => ed.undo()),
    tool('↷', '다시 실행 (Ctrl+Y)', () => ed.redo()),
    h('span', { class: 'sep' }),
    fmtBtn('b', '가', '굵게 (Ctrl+B)'),
    fmtBtn('i', '가', '기울임 (Ctrl+I)'),
    fmtBtn('u', '가', '밑줄 (Ctrl+U)'),
    fmtBtn('s', '가', '취소선'),
    colorInput,
    h('span', { class: 'sep' }),
    tool('−', '축소', () => setZoom(view.zoom - 0.1)),
    zoomLabel,
    tool('＋', '확대', () => setZoom(view.zoom + 0.1)),
    h('span', { class: 'grow' }),
    peersEl,
    status.conn,
    status.save,
    shareButton(meta),
    h('a', { class: 'btn primary small', href: api.exportUrl(id), download: '' }, 'HWPX 받기'),
  );

  message.remove();
  const shell = h('div', { class: 'doc' }, toolbar, scroller, flashEl);
  root.append(shell);
  cleanups.push(() => shell.remove());
  cleanups.push(() => view.destroy());
  bindInput(ed, view);
  view.focus();
  collab.onDenied(() => denyOverlay(shell));

  const refreshUi = (): void => {
    const state = ed.formatState();
    for (const btn of toolbar.querySelectorAll<HTMLButtonElement>('[data-attr]')) {
      btn.setAttribute('aria-pressed', String(Boolean(state[btn.dataset.attr as FormatAttr])));
    }
    peerAvatars(peersEl, ed.peers());
  };
  cleanups.push(ed.on(refreshUi));
  refreshUi();
  return cleanup;
}
