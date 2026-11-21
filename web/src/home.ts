// 첫 화면: 업무 폴더 목록 + 문서 목록, 문서 올리기/새로 만들기

import { api, h, errorMessage } from './api.ts';
import type { DocKind, DocMeta, FolderInfo } from './api.ts';
import { session } from './session.ts';
import { openShareDialog, openFolderMembers } from './share.ts';

const fmtTime = (iso: string): string => new Date(iso).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });
const KIND_LABEL: Record<DocKind, string> = { hwpx: '한글', xlsx: '엑셀' };

/** view: undefined = 모든 문서, 'none' = 폴더 밖 문서, 그 밖 = 폴더 id */
export async function showHome(root: HTMLElement, view?: string): Promise<() => void> {
  const user = session.user!;
  const status = h('p', { class: 'status', role: 'status' });
  const listEl = h('ul', { class: 'doc-list', 'aria-label': '문서 목록' });
  const nav = h('nav', { class: 'folders', 'aria-label': '업무 폴더' });
  const heading = h('div', { class: 'folder-head' });
  let folders: FolderInfo[] = [];
  const current = (): FolderInfo | undefined => (view && view !== 'none' ? folders.find((f) => f.id === view) : undefined);

  const open = (meta: DocMeta): void => {
    location.hash = `#/d/${meta.id}`;
  };

  async function create(file: File | null, kind: DocKind): Promise<void> {
    status.textContent = file ? `"${file.name}" 올리는 중…` : '새 문서 만드는 중…';
    try {
      open(await api.create(file, kind, current()?.id ?? null));
    } catch (e) {
      status.textContent = errorMessage(e);
    }
  }

  async function remove(d: DocMeta): Promise<void> {
    if (!confirm(`"${d.title}" 문서를 지울까요? 함께 편집하던 사람들도 더는 열 수 없습니다.`)) return;
    try {
      await api.remove(d.id);
    } catch (e) {
      status.textContent = errorMessage(e);
    }
    await refresh();
  }

  async function move(d: DocMeta, folderId: string | null): Promise<void> {
    try {
      await api.moveToFolder(d.id, folderId);
      const name = folders.find((f) => f.id === folderId)?.name;
      status.textContent = name ? `"${d.title}"을(를) "${name}" 폴더로 옮겼습니다.` : `"${d.title}"을(를) 폴더 밖으로 꺼냈습니다.`;
    } catch (e) {
      status.textContent = errorMessage(e);
    }
    await refresh();
  }

  function moveSelect(d: DocMeta): HTMLSelectElement {
    const sel = h(
      'select',
      { class: 'move', 'aria-label': `"${d.title}" 폴더 옮기기` },
      h('option', { value: '' }, '폴더 없음'),
      ...folders.map((f) => h('option', { value: f.id }, f.name)),
    );
    sel.value = d.folderId && folders.some((f) => f.id === d.folderId) ? d.folderId : '';
    sel.addEventListener('change', () => void move(d, sel.value || null));
    return sel;
  }

  function row(d: DocMeta): HTMLLIElement {
    const mine = d.role === 'owner';
    const who = mine
      ? d.editorUsers.length
        ? `${d.editorUsers.map((p) => p.name).join(', ')}와 함께 편집`
        : '내가 올림'
      : `${d.ownerUser?.name ?? '알 수 없음'} 님이 ${d.role === 'folder' ? '폴더에 올림' : '공유'}`;
    const where = !view && d.folder ? h('span', { class: 'in-folder' }, d.folder.name) : null;
    return h(
      'li',
      {},
      h('span', { class: `kind kind-${d.kind}` }, KIND_LABEL[d.kind]),
      h('span', { class: 'doc-main' }, h('a', { href: `#/d/${d.id}`, class: 'doc-title' }, d.title), h('span', { class: 'doc-sub' }, where, `${who} · ${fmtTime(d.updatedAt)}`)),
      h(
        'span',
        { class: 'doc-actions' },
        mine && folders.length ? moveSelect(d) : null,
        h('button', { class: 'btn small', type: 'button', onclick: () => openShareDialog(d, () => void refresh()) }, mine ? '공유' : '참여자'),
        h('a', { href: api.exportUrl(d.id), class: 'btn small', download: '' }, '받기'),
        mine ? h('button', { class: 'btn small danger', type: 'button', onclick: () => void remove(d) }, '지우기') : null,
      ),
    );
  }

  function renderNav(): void {
    const link = (href: string, label: string, on: boolean, count?: number, note?: string): HTMLAnchorElement =>
      h(
        'a',
        { href, class: on ? 'on' : '', 'aria-current': on ? 'page' : null },
        h('span', { class: 'fname' }, label),
        note ? h('span', { class: 'fnote' }, note) : null,
        count !== undefined ? h('span', { class: 'count' }, String(count)) : null,
      );
    nav.replaceChildren(
      link('#/', '모든 문서', !view),
      link('#/f/none', '폴더 밖 문서', view === 'none'),
      h('p', { class: 'nav-title' }, '업무 폴더'),
      ...folders.map((f) => link(`#/f/${f.id}`, f.name, view === f.id, f.docCount, f.role === 'owner' ? undefined : '참여')),
      h('button', { class: 'btn small new-folder', type: 'button', onclick: () => void newFolder() }, '+ 새 폴더'),
    );
  }

  function renderHeading(): void {
    const f = current();
    if (!f) {
      heading.replaceChildren(h('h2', {}, view === 'none' ? '폴더 밖 문서' : '모든 문서'));
      return;
    }
    const owner = f.role === 'owner';
    const people = [f.ownerUser?.name, ...f.memberUsers.map((p) => p.name)].filter(Boolean).join(', ');
    heading.replaceChildren(
      h('h2', {}, f.name),
      h('p', { class: 'hint' }, `구성원: ${people || '없음'} — 구성원은 이 폴더의 모든 문서를 열고 고칠 수 있습니다.`),
      h(
        'div',
        { class: 'folder-actions' },
        h('button', { class: 'btn small', type: 'button', onclick: () => openFolderMembers(f, () => void refresh()) }, owner ? '구성원 관리' : '구성원 보기'),
        owner ? h('button', { class: 'btn small', type: 'button', onclick: () => void renameFolder(f) }, '이름 바꾸기') : null,
        owner ? h('button', { class: 'btn small danger', type: 'button', onclick: () => void removeFolder(f) }, '폴더 지우기') : null,
      ),
    );
  }

  async function newFolder(): Promise<void> {
    const name = prompt('새 업무 폴더 이름 (예: 2027 예산 편성)');
    if (!name?.trim()) return;
    try {
      const f = await api.createFolder(name);
      location.hash = `#/f/${f.id}`;
    } catch (e) {
      status.textContent = errorMessage(e);
    }
  }

  async function renameFolder(f: FolderInfo): Promise<void> {
    const name = prompt('폴더 이름', f.name);
    if (!name?.trim() || name === f.name) return;
    try {
      await api.renameFolder(f.id, name);
    } catch (e) {
      status.textContent = errorMessage(e);
    }
    await refresh();
  }

  async function removeFolder(f: FolderInfo): Promise<void> {
    if (!confirm(`"${f.name}" 폴더를 지울까요? 안의 문서는 지워지지 않고 폴더 밖으로 나옵니다. 구성원이라서 열 수 있던 사람은 더는 열 수 없습니다.`)) return;
    try {
      await api.removeFolder(f.id);
      location.hash = '#/';
    } catch (e) {
      status.textContent = errorMessage(e);
    }
  }

  async function refresh(): Promise<void> {
    let docs: DocMeta[] = [];
    try {
      [folders, docs] = await Promise.all([api.folders(), api.list(view)]);
    } catch (e) {
      status.textContent = errorMessage(e);
    }
    if (view && view !== 'none' && !current()) {
      // 폴더가 없어졌거나 구성원에서 빠졌다.
      location.hash = '#/';
      return;
    }
    document.title = `${current()?.name ?? '문서'} — 문서 동시편집`;
    renderNav();
    renderHeading();
    listEl.replaceChildren(...docs.map(row));
    if (!docs.length) listEl.append(h('li', { class: 'empty' }, current() ? '이 폴더에는 아직 문서가 없습니다. 파일을 올리거나 새 문서를 만드세요.' : '문서가 없습니다.'));
  }

  const fileInput = h('input', { type: 'file', accept: '.hwpx,.hwp,.xlsx', hidden: true });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) void create(file, /\.xlsx$/i.test(file.name) ? 'xlsx' : 'hwpx');
    fileInput.value = '';
  });

  const logout = async (): Promise<void> => {
    await api.logout();
    session.set(null);
    location.hash = '#/login';
  };

  root.append(
    h(
      'main',
      { class: 'home' },
      h('header', { class: 'home-head' },
        h('h1', {}, '문서 동시편집'),
        h('span', { class: 'me' }, `${user.name} (${user.username})`, h('button', { class: 'btn small', type: 'button', onclick: () => void logout() }, '로그아웃')),
      ),
      h(
        'div',
        { class: 'home-body' },
        nav,
        h(
          'section',
          { class: 'home-main' },
          heading,
          h(
            'div',
            { class: 'card actions' },
            h('button', { class: 'btn primary', type: 'button', onclick: () => fileInput.click() }, '파일 올리기 (HWPX·XLSX)'),
            h('button', { class: 'btn', type: 'button', onclick: () => void create(null, 'hwpx') }, '빈 한글 문서'),
            h('button', { class: 'btn', type: 'button', onclick: () => void create(null, 'xlsx') }, '빈 엑셀 문서'),
            fileInput,
            status,
          ),
          listEl,
        ),
      ),
    ),
  );
  await refresh();
  // 다른 사람이 새로 공유한 문서가 보이도록 가끔, 그리고 창으로 돌아올 때 새로 고친다.
  const timer = setInterval(() => void refresh(), 15000);
  const onFocus = (): void => void refresh();
  window.addEventListener('focus', onFocus);
  return () => {
    clearInterval(timer);
    window.removeEventListener('focus', onFocus);
  };
}
