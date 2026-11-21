// 공유 대화상자: 올린 사람이 사람을 찾아 동시편집 권한을 주고 거둔다.

import { api, h, errorMessage } from './api.ts';
import type { DocMeta, Person } from './api.ts';

export function openShareDialog(meta: DocMeta, onChange: (m: DocMeta) => void): void {
  let doc = meta;
  const owner = doc.role === 'owner';
  const dialog = h('dialog', { class: 'share', 'aria-labelledby': 'share-title' });
  const status = h('p', { class: 'status', role: 'status' });
  const members = h('ul', { class: 'members' });
  const results = h('ul', { class: 'results' });
  const search = h('input', { type: 'search', placeholder: '이름이나 아이디로 찾기', 'aria-label': '사람 찾기', autocomplete: 'off' });

  const save = async (ids: string[]): Promise<void> => {
    try {
      doc = { ...doc, ...(await api.setEditors(doc.id, ids)) };
      onChange(doc);
      render();
      status.textContent = '저장했습니다.';
    } catch (e) {
      status.textContent = errorMessage(e);
    }
  };

  const person = (p: Person, note: string, action?: HTMLElement): HTMLLIElement =>
    h('li', {}, h('span', { class: 'who' }, h('b', {}, p.name), ` ${p.username}`), h('span', { class: 'note' }, note), action ?? null);

  function render(): void {
    members.replaceChildren(
      ...(doc.ownerUser ? [person(doc.ownerUser, '올린 사람')] : []),
      ...doc.editorUsers.map((p) =>
        person(
          p,
          '편집 가능',
          owner
            ? h('button', { class: 'btn small danger', type: 'button', onclick: () => void save(doc.editors.filter((x) => x !== p.id)) }, '권한 빼기')
            : undefined,
        ),
      ),
    );
    if (!doc.editorUsers.length) members.append(h('li', { class: 'empty' }, '아직 함께 편집하는 사람이 없습니다.'));
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = search.value.trim();
      if (!q) {
        results.replaceChildren();
        return;
      }
      try {
        const found = await api.searchUsers(q);
        results.replaceChildren(
          ...found.map((p) => {
            const already = p.id === doc.owner || doc.editors.includes(p.id);
            return person(
              p,
              already ? '이미 편집 가능' : '',
              already ? undefined : h('button', { class: 'btn small primary', type: 'button', onclick: () => void save([...doc.editors, p.id]) }, '편집 권한 주기'),
            );
          }),
        );
        if (!found.length) results.append(h('li', { class: 'empty' }, '찾는 사람이 없습니다.'));
      } catch (e) {
        status.textContent = errorMessage(e);
      }
    }, 200);
  });

  dialog.append(
    h('h2', { id: 'share-title' }, `"${doc.title}" 함께 편집`),
    h('p', { class: 'hint' }, owner ? '권한을 받은 사람만 이 문서를 열고 고칠 수 있습니다.' : '권한은 문서를 올린 사람만 바꿀 수 있습니다.'),
    members,
    ...(owner ? [h('div', { class: 'search' }, search, results)] : []),
    status,
    h('form', { method: 'dialog', class: 'actions' }, h('button', { class: 'btn', value: 'close' }, '닫기')),
  );
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  render();
  dialog.showModal();
  if (owner) search.focus();
}
