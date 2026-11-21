// 첫 화면: 업무 폴더 트리(최대 3단계) + 문서 목록, 문서 올리기/새로 만들기

import { api, h, errorMessage } from './api.ts';
import type { DocKind, DocMeta, FolderInfo, Role } from './api.ts';
import { session } from './session.ts';
import { openShareDialog, openFolderGrants } from './share.ts';

const fmtTime = (iso: string): string => new Date(iso).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });
const KIND_LABEL: Record<DocKind, string> = { hwpx: '한글', xlsx: '엑셀' };
const ROLE_NOTE: Record<Role, string> = { owner: '', edit: '', view: '보기' };
const canWrite = (r: Role): boolean => r === 'owner' || r === 'edit';

/** 폴더 목록을 트리 순서로 펼친다. 상위 폴더가 안 보이는 폴더는 맨 위에 둔다. */
function flattenTree(folders: FolderInfo[]): { f: FolderInfo; level: number }[] {
  const ids = new Set(folders.map((f) => f.id));
  const kids = new Map<string | null, FolderInfo[]>();
  for (const f of folders) {
    const p = f.parentId && ids.has(f.parentId) ? f.parentId : null;
    kids.set(p, [...(kids.get(p) ?? []), f]);
  }
  for (const list of kids.values()) list.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  const out: { f: FolderInfo; level: number }[] = [];
  const walk = (p: string | null, level: number): void => {
    for (const f of kids.get(p) ?? []) {
      out.push({ f, level });
      walk(f.id, level + 1);
    }
  };
  walk(null, 0);
  return out;
}

const pathText = (p: { name: string }[]): string => p.map((x) => x.name).join(' > ');

/** view: undefined = 모든 문서, 'none' = 폴더 밖 문서, 그 밖 = 폴더 id */
export async function showHome(root: HTMLElement, view?: string): Promise<() => void> {
  const user = session.user!;
  const status = h('p', { class: 'status', role: 'status' });
  const listEl = h('ul', { class: 'doc-list', 'aria-label': '문서 목록' });
  const nav = h('nav', { class: 'folders', 'aria-label': '업무 폴더' });
  const heading = h('div', { class: 'folder-head' });
  const actions = h('div', { class: 'card actions' });
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
      const f = folders.find((x) => x.id === folderId);
      status.textContent = f ? `"${d.title}"을(를) "${pathText(f.path)}" 폴더로 옮겼습니다.` : `"${d.title}"을(를) 폴더 밖으로 꺼냈습니다.`;
    } catch (e) {
      status.textContent = errorMessage(e);
    }
    await refresh();
  }

  function moveSelect(d: DocMeta): HTMLSelectElement {
    const targets = flattenTree(folders.filter((f) => canWrite(f.role)));
    const sel = h(
      'select',
      { class: 'move', 'aria-label': `"${d.title}" 폴더 옮기기` },
      h('option', { value: '' }, '폴더 없음'),
      ...targets.map(({ f, level }) => h('option', { value: f.id }, `${'　'.repeat(level)}${f.name}`)),
    );
    sel.value = d.folderId && targets.some((x) => x.f.id === d.folderId) ? d.folderId : '';
    if (d.folderId && !targets.some((x) => x.f.id === d.folderId)) {
      sel.prepend(h('option', { value: d.folderId }, d.folder?.name ?? '(다른 폴더)'));
      sel.value = d.folderId;
    }
    sel.addEventListener('change', () => void move(d, sel.value || null));
    return sel;
  }

  function row(d: DocMeta): HTMLLIElement {
    const mine = d.role === 'owner';
    const people = d.shares.map((g) => g.name).join(', ');
    const who = mine ? (people ? `${people}와 함께` : '내가 올림') : `${d.ownerUser?.name ?? '알 수 없음'} 님 문서`;
    const where = !view && d.path.length ? h('span', { class: 'in-folder' }, pathText(d.path)) : null;
    return h(
      'li',
      {},
      h('span', { class: `kind kind-${d.kind}` }, KIND_LABEL[d.kind]),
      h(
        'span',
        { class: 'doc-main' },
        h('a', { href: `#/d/${d.id}`, class: 'doc-title' }, d.title, d.role === 'view' ? h('span', { class: 'ro' }, '보기 전용') : null),
        h('span', { class: 'doc-sub' }, where, `${who} · ${fmtTime(d.updatedAt)}`),
      ),
      h(
        'span',
        { class: 'doc-actions' },
        mine && folders.some((f) => canWrite(f.role)) ? moveSelect(d) : null,
        h('button', { class: 'btn small', type: 'button', onclick: () => openShareDialog(d, () => void refresh()) }, mine ? '공유' : '권한'),
        h('a', { href: api.exportUrl(d.id), class: 'btn small', download: '' }, '받기'),
        mine ? h('button', { class: 'btn small danger', type: 'button', onclick: () => void remove(d) }, '지우기') : null,
      ),
    );
  }

  function renderNav(): void {
    const link = (href: string, label: string, on: boolean, level = 0, count?: number, note?: string): HTMLAnchorElement =>
      h(
        'a',
        { href, class: `lv${level}${on ? ' on' : ''}`, 'aria-current': on ? 'page' : null },
        h('span', { class: 'fname' }, label),
        note ? h('span', { class: 'fnote' }, note) : null,
        count !== undefined ? h('span', { class: 'count' }, String(count)) : null,
      );
    nav.replaceChildren(
      link('#/', '모든 문서', !view),
      link('#/f/none', '폴더 밖 문서', view === 'none'),
      h('p', { class: 'nav-title' }, '업무 폴더'),
      ...flattenTree(folders).map(({ f, level }) => link(`#/f/${f.id}`, f.name, view === f.id, Math.min(level, 2), f.docCount, ROLE_NOTE[f.role])),
      h('button', { class: 'btn small new-folder', type: 'button', onclick: () => void newFolder(null) }, '+ 새 폴더'),
    );
  }

  function renderHeading(): void {
    const f = current();
    const writable = !f || canWrite(f.role);
    actions.hidden = !writable;
    if (!f) {
      heading.replaceChildren(h('h2', {}, view === 'none' ? '폴더 밖 문서' : '모든 문서'));
      return;
    }
    const owner = f.role === 'owner';
    const granted = f.grants.map((g) => `${g.name}(${g.role === 'edit' ? '편집' : '보기'})`).join(', ');
    heading.replaceChildren(
      ...(f.path.length > 1 ? [h('p', { class: 'crumbs' }, ...f.path.slice(0, -1).flatMap((p) => [h('a', { href: `#/f/${p.id}` }, p.name), ' › ']))] : []),
      h('h2', {}, f.name, f.role === 'view' ? h('span', { class: 'ro' }, '보기 전용') : null),
      h('p', { class: 'hint' }, `만든 사람: ${f.ownerUser?.name ?? '-'} · 이 폴더 권한: ${granted || '없음'}${f.depth > 1 ? ' · 상위 폴더 권한도 적용됩니다' : ''}`),
      h(
        'div',
        { class: 'folder-actions' },
        h('button', { class: 'btn small', type: 'button', onclick: () => openFolderGrants(f, () => void refresh()) }, owner ? '권한 관리' : '권한 보기'),
        f.canAddChild ? h('button', { class: 'btn small', type: 'button', onclick: () => void newFolder(f) }, '+ 하위 폴더') : null,
        owner ? h('button', { class: 'btn small', type: 'button', onclick: () => void renameFolder(f) }, '이름 바꾸기') : null,
        owner ? h('button', { class: 'btn small danger', type: 'button', onclick: () => void removeFolder(f) }, '폴더 지우기') : null,
      ),
    );
  }

  async function newFolder(parent: FolderInfo | null): Promise<void> {
    const name = prompt(parent ? `"${parent.name}" 안에 만들 폴더 이름` : '새 업무 폴더 이름 (예: 2027 예산 편성)');
    if (!name?.trim()) return;
    try {
      const f = await api.createFolder(name, parent?.id ?? null);
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
    const up = f.parentId ? '상위 폴더로' : '폴더 밖으로';
    if (!confirm(`"${f.name}" 폴더와 그 하위 폴더를 지울까요? 안의 문서는 지워지지 않고 ${up} 옮겨집니다. 이 폴더 권한으로 열던 사람은 더는 열 수 없습니다.`)) return;
    try {
      await api.removeFolder(f.id);
      location.hash = f.parentId ? `#/f/${f.parentId}` : '#/';
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
      // 폴더가 없어졌거나 권한을 잃었다.
      location.hash = '#/';
      return;
    }
    document.title = `${current()?.name ?? '문서'} — 문서 동시편집`;
    renderNav();
    renderHeading();
    listEl.replaceChildren(...docs.map(row));
    if (!docs.length) listEl.append(h('li', { class: 'empty' }, current() ? '이 폴더에는 문서가 없습니다.' : '문서가 없습니다.'));
  }

  const fileInput = h('input', { type: 'file', accept: '.hwpx,.hwp,.xlsx', hidden: true });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) void create(file, /\.xlsx$/i.test(file.name) ? 'xlsx' : 'hwpx');
    fileInput.value = '';
  });
  actions.append(
    h('button', { class: 'btn primary', type: 'button', onclick: () => fileInput.click() }, '파일 올리기 (HWPX·XLSX)'),
    h('button', { class: 'btn', type: 'button', onclick: () => void create(null, 'hwpx') }, '빈 한글 문서'),
    h('button', { class: 'btn', type: 'button', onclick: () => void create(null, 'xlsx') }, '빈 엑셀 문서'),
    fileInput,
  );

  const logout = async (): Promise<void> => {
    await api.logout();
    session.set(null);
    location.hash = '#/login';
  };

  root.append(
    h(
      'main',
      { class: 'home' },
      h(
        'header',
        { class: 'home-head' },
        h('h1', {}, '문서 동시편집'),
        h(
          'span',
          { class: 'me' },
          `${user.name} (${user.username})`,
          user.role === 'admin' ? h('a', { class: 'btn small', href: '#/admin' }, '관리') : null,
          h('button', { class: 'btn small', type: 'button', onclick: () => void logout() }, '로그아웃'),
        ),
      ),
      h('div', { class: 'home-body' }, nav, h('section', { class: 'home-main' }, heading, actions, status, listEl)),
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
