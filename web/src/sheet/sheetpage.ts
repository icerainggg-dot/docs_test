// 엑셀(XLSX) 편집 화면

import { api, h, errorMessage } from '../api.ts';
import type { DocInfo } from '../api.ts';
import { session, colorFor } from '../session.ts';
import type { WorkbookModel } from '../../../src/shared/xlsx/types.ts';
import { SheetEditor } from './sheet-editor.ts';
import { SheetGrid } from './grid.ts';
import { connectCollab, denyOverlay, flasher, titleField, shareButton, peerAvatars, statusWidgets, readOnlyBadge } from '../shell.ts';

declare global {
  interface Window {
    /** 자동 시험·디버깅용 */
    __sheet?: SheetEditor;
    __grid?: SheetGrid;
  }
}

const SUFFIX = '엑셀 동시편집';

export async function showSheet(root: HTMLElement, meta: DocInfo): Promise<() => void> {
  const id = meta.id;
  const message = h('p', { class: 'loading', role: 'status' }, '문서를 여는 중…');
  root.append(message);
  const cleanups: (() => void)[] = [];
  const cleanup = (): void => cleanups.splice(0).reverse().forEach((fn) => fn());
  const backLink = (): HTMLAnchorElement => h('a', { href: '#/' }, '목록으로');

  let model: WorkbookModel;
  try {
    model = await api.model<WorkbookModel>(id);
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
  const ed = new SheetEditor({ model, ydoc: collab.ydoc, awareness, user: { name: me.name, color: colorFor(me.id) } });
  ed.readOnly = meta.role === 'view';
  cleanups.push(() => ed.destroy());
  window.__sheet = ed;

  const { el: flashEl, flash } = flasher();
  const peersEl = h('div', { class: 'peers', 'aria-label': '함께 편집 중인 사람' });
  const status = statusWidgets(id, collab.provider);
  cleanups.push(status.stop);
  const area = h('div', { class: 'sheet' });

  let grid: SheetGrid | null = null;
  const tool = (label: string, title: string, fn: () => void): HTMLButtonElement =>
    h('button', { class: 'tool', title, 'aria-label': title, onmousedown: (e: Event) => e.preventDefault(), onclick: () => { fn(); grid?.focus(); } }, label);

  const toolbar = h(
    'header',
    { class: 'toolbar' },
    h('a', { href: meta.folderId ? `#/f/${meta.folderId}` : '#/', class: 'tool back', title: meta.folder ? `${meta.folder.name} 폴더로` : '문서 목록', 'aria-label': '문서 목록' }, '←'),
    titleField(meta, flash, SUFFIX),
    readOnlyBadge(meta),
    h('span', { class: 'sep' }),
    ...(ed.readOnly ? [] : [tool('↶', '실행 취소 (Ctrl+Z)', () => ed.undo()), tool('↷', '다시 실행 (Ctrl+Y)', () => ed.redo())]),
    h('span', { class: 'grow' }),
    peersEl,
    status.conn,
    status.save,
    shareButton(meta),
    h('a', { class: 'btn primary small', href: api.exportUrl(id), download: '' }, 'XLSX 받기'),
  );

  message.remove();
  const shell = h('div', { class: 'doc' }, toolbar, area, flashEl);
  root.append(shell);
  cleanups.push(() => shell.remove());
  grid = new SheetGrid(ed, area);
  window.__grid = grid;
  cleanups.push(() => grid?.destroy());
  grid.focus();
  collab.onDenied(() => denyOverlay(shell));

  const refreshPeers = (): void => peerAvatars(peersEl, ed.peers());
  cleanups.push(ed.on((t) => t === 'awareness' && refreshPeers()));
  refreshPeers();
  return cleanup;
}
