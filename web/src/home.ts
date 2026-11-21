// 첫 화면: 문서 올리기/새로 만들기, 내 문서와 공유받은 문서

import { api, h, errorMessage } from './api.ts';
import type { DocKind, DocMeta } from './api.ts';
import { session } from './session.ts';
import { openShareDialog } from './share.ts';

const fmtTime = (iso: string): string => new Date(iso).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });
const KIND_LABEL: Record<DocKind, string> = { hwpx: '한글', xlsx: '엑셀' };

export async function showHome(root: HTMLElement): Promise<() => void> {
  document.title = '문서 동시편집';
  const user = session.user!;
  const status = h('p', { class: 'status', role: 'status' });
  const listEl = h('ul', { class: 'doc-list', 'aria-label': '문서 목록' });

  const open = (meta: DocMeta): void => {
    location.hash = `#/d/${meta.id}`;
  };

  async function create(file: File | null, kind: DocKind): Promise<void> {
    status.textContent = file ? `"${file.name}" 올리는 중…` : '새 문서 만드는 중…';
    try {
      open(await api.create(file, kind));
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

  function row(d: DocMeta): HTMLLIElement {
    const mine = d.role === 'owner';
    const who = mine
      ? d.editorUsers.length
        ? `${d.editorUsers.map((p) => p.name).join(', ')}와 함께 편집`
        : '나만 편집'
      : `${d.ownerUser?.name ?? '알 수 없음'} 님이 공유`;
    return h(
      'li',
      {},
      h('span', { class: `kind kind-${d.kind}` }, KIND_LABEL[d.kind]),
      h('span', { class: 'doc-main' }, h('a', { href: `#/d/${d.id}`, class: 'doc-title' }, d.title), h('span', { class: 'doc-sub' }, `${who} · ${fmtTime(d.updatedAt)}`)),
      h('span', { class: 'doc-actions' },
        h('button', { class: 'btn small', type: 'button', onclick: () => openShareDialog(d, () => void refresh()) }, mine ? '공유' : '참여자'),
        h('a', { href: api.exportUrl(d.id), class: 'btn small', download: '' }, '받기'),
        mine ? h('button', { class: 'btn small danger', type: 'button', onclick: () => void remove(d) }, '지우기') : null,
      ),
    );
  }

  async function refresh(): Promise<void> {
    let docs: DocMeta[] = [];
    try {
      docs = await api.list();
    } catch (e) {
      status.textContent = errorMessage(e);
    }
    listEl.replaceChildren(...docs.map(row));
    if (!docs.length) listEl.append(h('li', { class: 'empty' }, '아직 문서가 없습니다. 파일을 올리거나 새 문서를 만드세요.'));
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
      h('p', { class: 'lead' }, '한글(HWPX)·엑셀(XLSX) 문서를 올리고, 함께 고칠 사람을 지정하세요.'),
      h(
        'section',
        { class: 'card actions' },
        h('button', { class: 'btn primary', type: 'button', onclick: () => fileInput.click() }, '파일 올리기 (HWPX·XLSX)'),
        h('button', { class: 'btn', type: 'button', onclick: () => void create(null, 'hwpx') }, '빈 한글 문서'),
        h('button', { class: 'btn', type: 'button', onclick: () => void create(null, 'xlsx') }, '빈 엑셀 문서'),
        fileInput,
        status,
      ),
      h('h2', {}, '문서'),
      listEl,
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
