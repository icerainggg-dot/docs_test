// 사람 고르기 창: 문서의 편집자, 폴더의 구성원을 정할 때 함께 쓴다.

import { api, h, errorMessage } from './api.ts';
import type { DocMeta, FolderInfo, Person } from './api.ts';

interface PeopleOptions {
  title: string;
  hint: string;
  ownerLabel: string;
  memberLabel: string;
  addLabel: string;
  removeLabel: string;
  emptyText: string;
  owner: Person | null;
  ownerId: string;
  members: Person[];
  canManage: boolean;
  /** 구성원 목록을 저장하고 새 목록을 돌려준다. */
  save(ids: string[]): Promise<Person[]>;
}

export function openPeopleDialog(o: PeopleOptions): void {
  let members = o.members;
  const dialog = h('dialog', { class: 'share', 'aria-labelledby': 'share-title' });
  const status = h('p', { class: 'status', role: 'status' });
  const list = h('ul', { class: 'members' });
  const results = h('ul', { class: 'results' });
  const search = h('input', { type: 'search', placeholder: '이름이나 아이디로 찾기', 'aria-label': '사람 찾기', autocomplete: 'off' });

  const save = async (ids: string[]): Promise<void> => {
    try {
      members = await o.save(ids);
      render();
      results.replaceChildren();
      search.value = '';
      status.textContent = '저장했습니다.';
    } catch (e) {
      status.textContent = errorMessage(e);
    }
  };

  const person = (p: Person, note: string, action?: HTMLElement): HTMLLIElement =>
    h('li', {}, h('span', { class: 'who' }, h('b', {}, p.name), ` ${p.username}`), h('span', { class: 'note' }, note), action ?? null);

  function render(): void {
    list.replaceChildren(
      ...(o.owner ? [person(o.owner, o.ownerLabel)] : []),
      ...members.map((p) =>
        person(
          p,
          o.memberLabel,
          o.canManage
            ? h('button', { class: 'btn small danger', type: 'button', onclick: () => void save(members.filter((x) => x.id !== p.id).map((x) => x.id)) }, o.removeLabel)
            : undefined,
        ),
      ),
    );
    if (!members.length) list.append(h('li', { class: 'empty' }, o.emptyText));
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
            const already = p.id === o.ownerId || members.some((m) => m.id === p.id);
            return person(
              p,
              already ? '이미 들어 있음' : '',
              already ? undefined : h('button', { class: 'btn small primary', type: 'button', onclick: () => void save([...members.map((m) => m.id), p.id]) }, o.addLabel),
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
    h('h2', { id: 'share-title' }, o.title),
    h('p', { class: 'hint' }, o.hint),
    list,
    ...(o.canManage ? [h('div', { class: 'search' }, search, results)] : []),
    status,
    h('form', { method: 'dialog', class: 'actions' }, h('button', { class: 'btn', value: 'close' }, '닫기')),
  );
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  render();
  dialog.showModal();
  if (o.canManage) search.focus();
}

/** 문서 공유 창: 올린 사람이 문서마다 편집 권한을 준다. */
export function openShareDialog(meta: DocMeta, onChange: (m: DocMeta) => void): void {
  const owner = meta.role === 'owner';
  const folderNote = meta.folder ? ` "${meta.folder.name}" 폴더의 구성원도 이 문서를 고칠 수 있습니다.` : '';
  openPeopleDialog({
    title: `"${meta.title}" 함께 편집`,
    hint: (owner ? '권한을 받은 사람만 이 문서를 열고 고칠 수 있습니다.' : '권한은 문서를 올린 사람만 바꿀 수 있습니다.') + folderNote,
    ownerLabel: '올린 사람',
    memberLabel: '편집 가능',
    addLabel: '편집 권한 주기',
    removeLabel: '권한 빼기',
    emptyText: '아직 함께 편집하는 사람이 없습니다.',
    owner: meta.ownerUser,
    ownerId: meta.owner,
    members: meta.editorUsers,
    canManage: owner,
    async save(ids) {
      const m = await api.setEditors(meta.id, ids);
      Object.assign(meta, m);
      onChange(m);
      return m.editorUsers;
    },
  });
}

/** 폴더 구성원 창: 폴더를 만든 사람이 구성원을 정한다. */
export function openFolderMembers(folder: FolderInfo, onChange: (f: FolderInfo) => void): void {
  const owner = folder.role === 'owner';
  openPeopleDialog({
    title: `"${folder.name}" 구성원`,
    hint: owner
      ? '구성원은 이 폴더의 모든 문서를 열고 고칠 수 있고, 폴더에 새 문서를 올릴 수 있습니다.'
      : '구성원은 폴더를 만든 사람만 바꿀 수 있습니다.',
    ownerLabel: '만든 사람',
    memberLabel: '구성원',
    addLabel: '구성원으로 추가',
    removeLabel: '빼기',
    emptyText: '아직 구성원이 없습니다.',
    owner: folder.ownerUser,
    ownerId: folder.owner,
    members: folder.memberUsers,
    canManage: owner,
    async save(ids) {
      const f = await api.setFolderMembers(folder.id, ids);
      Object.assign(folder, f);
      onChange(f);
      return f.memberUsers;
    },
  });
}
