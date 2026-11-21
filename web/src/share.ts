// 권한 창: 문서 공유와 폴더 권한에 함께 쓴다.
// 사람이나 부서를 찾아 "편집" 또는 "보기" 권한을 준다. 부서에 주면 하위 부서 사람까지 포함된다.

import { api, h, errorMessage } from './api.ts';
import type { DocMeta, FolderInfo, Grant, GrantRole, GrantView, Person } from './api.ts';

interface GrantOptions {
  title: string;
  hint: string;
  ownerLabel: string;
  owner: Person | null;
  ownerId: string;
  grants: GrantView[];
  canManage: boolean;
  /** 권한 목록을 저장하고 새 목록을 돌려준다. */
  save(grants: Grant[]): Promise<GrantView[]>;
}

const ROLE_LABEL: Record<GrantRole, string> = { edit: '편집', view: '보기' };

export function openGrantDialog(o: GrantOptions): void {
  let grants = o.grants;
  const dialog = h('dialog', { class: 'share', 'aria-labelledby': 'share-title' });
  const status = h('p', { class: 'status', role: 'status' });
  const list = h('ul', { class: 'members' });
  const results = h('ul', { class: 'results' });
  const search = h('input', { type: 'search', placeholder: '이름·아이디·부서로 찾기', 'aria-label': '사람이나 부서 찾기', autocomplete: 'off' });
  const newRole = h('select', { 'aria-label': '줄 권한' }, h('option', { value: 'edit' }, '편집'), h('option', { value: 'view' }, '보기'));

  const plain = (g: GrantView): Grant => ({ type: g.type, id: g.id, role: g.role });
  const save = async (next: Grant[]): Promise<void> => {
    try {
      grants = await o.save(next);
      render();
      status.textContent = '저장했습니다.';
    } catch (e) {
      status.textContent = errorMessage(e);
    }
  };

  const row = (label: HTMLElement, note: HTMLElement | string, ...actions: (HTMLElement | null)[]): HTMLLIElement =>
    h('li', {}, label, typeof note === 'string' ? h('span', { class: 'note' }, note) : note, ...actions);
  const who = (name: string, sub: string, dept: boolean): HTMLElement =>
    h('span', { class: 'who' }, dept ? h('span', { class: 'tag' }, '부서') : null, h('b', {}, name), ` ${sub}`);

  function render(): void {
    list.replaceChildren(
      ...(o.owner ? [row(who(o.owner.name, o.owner.username, false), o.ownerLabel)] : []),
      ...grants.map((g) => {
        const label = who(g.name, g.sub + (g.active === false ? ' (사용 중지)' : ''), g.type === 'dept');
        if (!o.canManage) return row(label, ROLE_LABEL[g.role]);
        const sel = h('select', { 'aria-label': `${g.name} 권한` }, h('option', { value: 'edit' }, '편집'), h('option', { value: 'view' }, '보기'));
        sel.value = g.role;
        sel.addEventListener('change', () => void save(grants.map((x) => (x === g ? { ...plain(x), role: sel.value as GrantRole } : plain(x)))));
        return row(
          label,
          sel,
          h('button', { class: 'btn small danger', type: 'button', onclick: () => void save(grants.filter((x) => x !== g).map(plain)) }, '빼기'),
        );
      }),
    );
    if (!grants.length) list.append(h('li', { class: 'empty' }, '아직 권한을 받은 사람이나 부서가 없습니다.'));
  }

  const add = (g: Grant): void => void save([...grants.filter((x) => !(x.type === g.type && x.id === g.id)).map(plain), g]);
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
        const found = await api.people(q);
        const has = (type: string, id: string): boolean => (type === 'user' && id === o.ownerId) || grants.some((g) => g.type === type && g.id === id);
        results.replaceChildren(
          ...found.depts.map((d) =>
            row(
              who(d.name, d.path, true),
              has('dept', d.id) ? '이미 있음' : '하위 부서 포함',
              has('dept', d.id) ? null : h('button', { class: 'btn small primary', type: 'button', onclick: () => add({ type: 'dept', id: d.id, role: newRole.value as GrantRole }) }, '추가'),
            ),
          ),
          ...found.users.map((p) =>
            row(
              who(p.name, [p.username, p.dept, p.title].filter(Boolean).join(' · '), false),
              has('user', p.id) ? '이미 있음' : '',
              has('user', p.id) ? null : h('button', { class: 'btn small primary', type: 'button', onclick: () => add({ type: 'user', id: p.id, role: newRole.value as GrantRole }) }, '추가'),
            ),
          ),
        );
        if (!found.users.length && !found.depts.length) results.append(h('li', { class: 'empty' }, '찾는 사람이나 부서가 없습니다.'));
      } catch (e) {
        status.textContent = errorMessage(e);
      }
    }, 200);
  });

  dialog.append(
    h('h2', { id: 'share-title' }, o.title),
    h('p', { class: 'hint' }, o.hint),
    list,
    ...(o.canManage ? [h('div', { class: 'search' }, h('div', { class: 'search-row' }, search, newRole), results)] : []),
    status,
    h('form', { method: 'dialog', class: 'actions' }, h('button', { class: 'btn', value: 'close' }, '닫기')),
  );
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  render();
  dialog.showModal();
  if (o.canManage) search.focus();
}

/** 문서 공유 창: 올린 사람이 문서마다 권한을 준다. */
export function openShareDialog(meta: DocMeta, onChange: (m: DocMeta) => void): void {
  const owner = meta.role === 'owner';
  const where = meta.path.length ? ` "${meta.path.map((p) => p.name).join(' > ')}" 폴더에 권한이 있는 사람도 이 문서를 열 수 있습니다.` : '';
  openGrantDialog({
    title: `"${meta.title}" 권한`,
    hint: (owner ? '편집 권한은 고칠 수 있고, 보기 권한은 읽고 내려받기만 할 수 있습니다.' : '권한은 문서를 올린 사람만 바꿀 수 있습니다.') + where,
    ownerLabel: '올린 사람',
    owner: meta.ownerUser,
    ownerId: meta.owner,
    grants: meta.shares,
    canManage: owner,
    async save(grants) {
      const m = await api.setShares(meta.id, grants);
      Object.assign(meta, m);
      onChange(m);
      return m.shares;
    },
  });
}

/** 폴더 권한 창: 폴더(또는 상위 폴더)를 만든 사람이 권한을 정한다. 아래 폴더와 문서에도 그대로 간다. */
export function openFolderGrants(folder: FolderInfo, onChange: (f: FolderInfo) => void): void {
  const owner = folder.role === 'owner';
  openGrantDialog({
    title: `"${folder.name}" 폴더 권한`,
    hint: owner
      ? '여기서 준 권한은 이 폴더의 하위 폴더와 모든 문서에 그대로 갑니다. 편집 권한이 있으면 문서와 하위 폴더를 만들 수 있습니다.'
      : '권한은 폴더를 만든 사람만 바꿀 수 있습니다. 상위 폴더에서 받은 권한도 이 폴더에 적용됩니다.',
    ownerLabel: '만든 사람',
    owner: folder.ownerUser,
    ownerId: folder.owner,
    grants: folder.grants,
    canManage: owner,
    async save(grants) {
      const f = await api.setFolderGrants(folder.id, grants);
      Object.assign(folder, f);
      onChange(f);
      return f.grants;
    },
  });
}
