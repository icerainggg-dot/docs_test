// 첫 화면: 이름 정하기, 문서 올리기/새로 만들기, 문서 목록

import { api, getUser, setUserName, h } from './api.ts';
import type { DocMeta } from './api.ts';

const fmtTime = (iso: string): string => new Date(iso).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });
const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function showHome(root: HTMLElement): Promise<() => void> {
  document.title = 'HWPX 동시편집';
  const user = getUser();
  const status = h('p', { class: 'status', role: 'status' });
  const listEl = h('ul', { class: 'doc-list' });

  const open = (meta: DocMeta): void => {
    location.hash = `#/d/${meta.id}`;
  };

  async function create(file: File | null): Promise<void> {
    status.textContent = file ? `"${file.name}" 올리는 중…` : '새 문서 만드는 중…';
    try {
      open(await api.create(file));
    } catch (e) {
      status.textContent = errorMessage(e);
    }
  }

  async function remove(d: DocMeta): Promise<void> {
    if (!confirm(`"${d.title}" 문서를 지울까요? 되돌릴 수 없습니다.`)) return;
    try {
      await api.remove(d.id);
    } catch (e) {
      status.textContent = errorMessage(e);
    }
    await refresh();
  }

  async function refresh(): Promise<void> {
    let docs: DocMeta[] = [];
    try {
      docs = await api.list();
    } catch (e) {
      status.textContent = errorMessage(e);
    }
    listEl.replaceChildren(
      ...docs.map((d) =>
        h(
          'li',
          {},
          h('a', { href: `#/d/${d.id}`, class: 'doc-title' }, d.title),
          h('span', { class: 'doc-time' }, fmtTime(d.updatedAt)),
          h('a', { href: api.exportUrl(d.id), class: 'btn small', download: '' }, 'HWPX 받기'),
          h('button', { class: 'btn small danger', onclick: () => void remove(d) }, '지우기'),
        ),
      ),
    );
    if (!docs.length) listEl.append(h('li', { class: 'empty' }, '아직 문서가 없습니다. HWPX 파일을 올리거나 새 문서를 만드세요.'));
  }

  const fileInput = h('input', { type: 'file', accept: '.hwpx,.hwp', hidden: true });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) void create(file);
    fileInput.value = '';
  });

  const nameInput = h('input', {
    type: 'text',
    id: 'user-name',
    maxlength: '30',
    placeholder: '예: 홍길동',
    value: user.named ? user.name : '',
  });
  nameInput.addEventListener('change', () => setUserName(nameInput.value));

  root.append(
    h(
      'main',
      { class: 'home' },
      h('h1', {}, 'HWPX 동시편집'),
      h('p', { class: 'lead' }, '한글 문서(HWPX)를 여러 사람이 함께 고칩니다.'),
      h(
        'section',
        { class: 'card' },
        h('label', { for: 'user-name' }, '내 이름 (다른 사람의 화면에 커서와 함께 보입니다)'),
        nameInput,
      ),
      h(
        'section',
        { class: 'card actions' },
        h('button', { class: 'btn primary', onclick: () => fileInput.click() }, 'HWPX 파일 올리기'),
        h('button', { class: 'btn', onclick: () => void create(null) }, '빈 문서로 시작'),
        fileInput,
        status,
      ),
      h('h2', {}, '문서'),
      listEl,
    ),
  );
  await refresh();
  return () => {};
}
