// 문서 편집 화면: 도구 모음 + 편집기 + 접속/저장 상태

import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { api, getUser, h } from './api.ts';
import type { DocMeta } from './api.ts';
import { initRhwp, HwpDocument } from './rhwp.ts';
import { Editor } from './editor/editor.ts';
import { View } from './editor/view.ts';
import { bindInput } from './editor/input.ts';

declare global {
  interface Window {
    /** 자동 시험·디버깅용 */
    __editor?: Editor;
  }
}

const fmtClock = (iso: string): string =>
  new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

type FormatAttr = 'b' | 'i' | 'u' | 's';

export async function showDoc(root: HTMLElement, id: string): Promise<() => void> {
  const message = h('p', { class: 'loading', role: 'status' }, '문서를 여는 중…');
  root.append(message);
  const cleanups: (() => void)[] = [];
  const cleanup = (): void => cleanups.splice(0).reverse().forEach((fn) => fn());
  const backLink = (): HTMLAnchorElement => h('a', { href: '#/' }, '목록으로');

  let meta: DocMeta;
  let hwp: HwpDocument;
  try {
    const [m, base] = await Promise.all([api.get(id), api.base(id), initRhwp()]);
    meta = m;
    const doc = new HwpDocument(base);
    hwp = doc;
    cleanups.push(() => doc.free());
  } catch (e) {
    message.replaceChildren(`문서를 열 수 없습니다: ${errorMessage(e)} `, backLink());
    return cleanup;
  }
  document.title = `${meta.title} — HWPX 동시편집`;

  const ydoc = new Y.Doc();
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const provider = new HocuspocusProvider({ url: `${proto}://${location.host}/collab`, name: id, document: ydoc });
  cleanups.push(() => provider.destroy());

  const synced = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 15000);
    provider.on('synced', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
  const awareness = provider.awareness;
  if (!synced || !awareness) {
    message.replaceChildren('동기화 서버에 연결하지 못했습니다. ', backLink());
    return cleanup;
  }

  const user = getUser();
  let editor: Editor;
  try {
    editor = new Editor({ hwp, ydoc, awareness, user: { name: user.name, color: user.color } });
  } catch (e) {
    console.error(e);
    message.replaceChildren(`문서를 편집 상태로 만들지 못했습니다: ${errorMessage(e)}`);
    return cleanup;
  }
  const ed = editor;
  cleanups.push(() => ed.destroy());
  window.__editor = ed;

  const flashEl = h('div', { class: 'flash', role: 'status' });
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  const flash = (text: string): void => {
    flashEl.textContent = text;
    flashEl.classList.add('show');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => flashEl.classList.remove('show'), 2500);
  };

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
    h(
      'button',
      {
        class: 'tool',
        title,
        'aria-label': title,
        onmousedown: keepFocus,
        onclick: () => {
          fn();
          view.focus();
        },
      },
      label,
    );

  const titleInput = h('input', { class: 'title', value: meta.title, 'aria-label': '문서 제목' });
  titleInput.addEventListener('change', async () => {
    try {
      meta = await api.rename(id, titleInput.value);
      document.title = `${meta.title} — HWPX 동시편집`;
    } catch (e) {
      flash(errorMessage(e));
      titleInput.value = meta.title;
    }
  });
  const colorInput = h('input', { type: 'color', class: 'tool color', title: '글자 색', 'aria-label': '글자 색', value: '#d9480f' });
  colorInput.addEventListener('change', () => {
    if (!ed.setColor(colorInput.value)) flash('색을 바꿀 글자를 먼저 선택하세요.');
    view.focus();
  });
  const zoomLabel = h('span', { class: 'zoom' }, '100%');
  const peersEl = h('div', { class: 'peers', 'aria-label': '함께 편집 중인 사람' });
  const connEl = h('span', { class: 'conn' }, '연결됨');
  const saveEl = h('span', { class: 'save' }, '');

  const setZoom = (z: number): void => {
    view.setZoom(z);
    zoomLabel.textContent = `${Math.round(view.zoom * 100)}%`;
  };

  const toolbar = h(
    'header',
    { class: 'toolbar' },
    h('a', { href: '#/', class: 'tool back', title: '문서 목록', 'aria-label': '문서 목록' }, '←'),
    titleInput,
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
    connEl,
    saveEl,
    h('a', { class: 'btn primary small', href: api.exportUrl(id), download: '' }, 'HWPX 받기'),
  );

  message.remove();
  const shell = h('div', { class: 'doc' }, toolbar, scroller, flashEl);
  root.append(shell);
  cleanups.push(() => shell.remove());
  cleanups.push(() => view.destroy());
  bindInput(ed, view);
  view.focus();

  // ── 상태 표시 ──
  const refreshUi = (): void => {
    const state = ed.formatState();
    for (const btn of toolbar.querySelectorAll<HTMLButtonElement>('[data-attr]')) {
      btn.setAttribute('aria-pressed', String(Boolean(state[btn.dataset.attr as FormatAttr])));
    }
    peersEl.replaceChildren(
      ...ed.peers().map((p) =>
        h(
          'span',
          { class: 'peer', style: `--c:${p.user.color}`, title: p.me ? `${p.user.name} (나)` : p.user.name },
          (p.user.name || '익명').slice(0, 2),
        ),
      ),
    );
  };
  cleanups.push(ed.on(refreshUi));
  refreshUi();

  provider.on('status', ({ status }: { status: string }) => {
    const ok = status === 'connected';
    connEl.textContent = ok ? '연결됨' : '연결 끊김 — 다시 연결하는 중';
    connEl.classList.toggle('bad', !ok);
  });

  const pollSave = async (): Promise<void> => {
    try {
      const m = await api.get(id);
      if (!m.save) saveEl.textContent = '';
      else if (m.save.ok) saveEl.textContent = `저장됨 ${fmtClock(m.save.at)}`;
      else saveEl.textContent = m.save.error ? '저장 실패' : `저장됨 (검사 불일치 ${m.save.diffs}건)`;
      saveEl.classList.toggle('bad', Boolean(m.save && !m.save.ok));
    } catch {
      /* 다음에 다시 */
    }
  };
  const saveTimer = setInterval(() => void pollSave(), 4000);
  void pollSave();
  cleanups.push(() => clearInterval(saveTimer));

  return cleanup;
}
