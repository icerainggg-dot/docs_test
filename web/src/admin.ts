// 관리자 화면: 조직도(부서) 고치기, 구성원 관리, 인사·SSO 조직 동기화

import { api, h, errorMessage } from './api.ts';
import type { AdminUser, Department } from './api.ts';
import { session } from './session.ts';

/** 부서를 트리 순서로 펼친다. */
function deptTree(depts: Department[]): { d: Department; level: number }[] {
  const kids = new Map<string | null, Department[]>();
  const ids = new Set(depts.map((d) => d.id));
  for (const d of depts) {
    const p = d.parentId && ids.has(d.parentId) ? d.parentId : null;
    kids.set(p, [...(kids.get(p) ?? []), d]);
  }
  for (const list of kids.values()) list.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'ko'));
  const out: { d: Department; level: number }[] = [];
  const walk = (p: string | null, level: number): void => {
    for (const d of kids.get(p) ?? []) {
      out.push({ d, level });
      walk(d.id, level + 1);
    }
  };
  walk(null, 0);
  return out;
}

/** 부서 고르기 칸 */
function deptSelect(depts: Department[], value: string | null, label: string, opts: { none?: string; exclude?: Set<string> } = {}): HTMLSelectElement {
  const sel = h(
    'select',
    { 'aria-label': label },
    h('option', { value: '' }, opts.none ?? '(부서 없음)'),
    ...deptTree(depts)
      .filter(({ d }) => !opts.exclude?.has(d.id))
      .map(({ d, level }) => h('option', { value: d.id }, `${'　'.repeat(level)}${d.name}`)),
  );
  sel.value = value ?? '';
  return sel;
}

/** 부서와 하위 부서 id */
function subtree(depts: Department[], id: string): Set<string> {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const d of depts) {
      if (d.parentId && out.has(d.parentId) && !out.has(d.id)) {
        out.add(d.id);
        grew = true;
      }
    }
  }
  return out;
}

export async function showAdmin(root: HTMLElement): Promise<() => void> {
  if (session.user?.role !== 'admin') {
    location.hash = '#/';
    return () => {};
  }
  document.title = '관리 — 문서 동시편집';
  const status = h('p', { class: 'status', role: 'status', 'aria-live': 'polite' });
  const orgList = h('ul', { class: 'org-list', 'aria-label': '조직도' });
  const userBody = h('tbody');
  const filter = h('input', { type: 'search', placeholder: '이름·아이디로 거르기', 'aria-label': '구성원 거르기' });
  const deptFilterHost = h('span');
  let depts: Department[] = [];
  let users: AdminUser[] = [];
  let deptFilter = '';

  const run = async (fn: () => Promise<unknown>, done?: string): Promise<void> => {
    try {
      await fn();
      if (done) status.textContent = done;
    } catch (e) {
      status.textContent = errorMessage(e);
    }
    await refresh();
  };

  // ── 조직도 ──
  function renderOrg(): void {
    const count = (id: string): number => users.filter((u) => u.deptId === id).length;
    orgList.replaceChildren(
      ...deptTree(depts).map(({ d, level }) => {
        const move = deptSelect(depts, d.parentId, `${d.name} 상위 부서`, { none: '(최상위)', exclude: subtree(depts, d.id) });
        move.addEventListener('change', () => void run(() => api.admin.updateDept(d.id, { parentId: move.value || null }), `"${d.name}"을(를) 옮겼습니다.`));
        return h(
          'li',
          { style: `--lv:${level}` },
          h('span', { class: 'dname' }, d.name, h('span', { class: 'dcount' }, `${count(d.id)}명`), d.externalId ? h('span', { class: 'ext' }, d.externalId) : null),
          h(
            'span',
            { class: 'dactions' },
            h('button', { class: 'btn small', type: 'button', onclick: () => void addDept(d) }, '+ 하위 부서'),
            h('button', {
              class: 'btn small',
              type: 'button',
              onclick: () => {
                const name = prompt('부서 이름', d.name);
                if (name?.trim() && name !== d.name) void run(() => api.admin.updateDept(d.id, { name }), '이름을 바꿨습니다.');
              },
            }, '이름'),
            h('label', { class: 'inline' }, '상위 ', move),
            h('button', {
              class: 'btn small danger',
              type: 'button',
              onclick: () => {
                if (confirm(`"${d.name}" 부서를 지울까요? 이 부서에 준 문서·폴더 권한도 없어집니다.`)) void run(() => api.admin.removeDept(d.id), '부서를 지웠습니다.');
              },
            }, '지우기'),
          ),
        );
      }),
    );
    if (!depts.length) orgList.append(h('li', { class: 'empty' }, '아직 부서가 없습니다. 「+ 최상위 부서」로 시작하세요.'));
  }

  async function addDept(parent: Department | null): Promise<void> {
    const name = prompt(parent ? `"${parent.name}" 아래에 만들 부서 이름` : '최상위 부서 이름 (예: 기획조정실)');
    if (!name?.trim()) return;
    await run(() => api.admin.createDept(name, parent?.id ?? null), '부서를 만들었습니다.');
  }

  // ── 구성원 ──
  function renderUsers(): void {
    const me = session.user!;
    const q = filter.value.trim().toLowerCase();
    const inDept = deptFilter ? subtree(depts, deptFilter) : null;
    const shown = users
      .filter((u) => !q || u.username.includes(q) || u.name.toLowerCase().includes(q))
      .filter((u) => !inDept || (u.deptId && inDept.has(u.deptId)))
      .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name, 'ko'));
    userBody.replaceChildren(
      ...shown.map((u) => {
        const dept = deptSelect(depts, u.deptId, `${u.name} 부서`);
        dept.addEventListener('change', () => void run(() => api.admin.updateUser(u.id, { deptId: dept.value || null }), `${u.name}의 부서를 바꿨습니다.`));
        const title = h('input', { value: u.title, 'aria-label': `${u.name} 직위`, maxlength: '40', class: 'title-in' });
        title.addEventListener('change', () => void run(() => api.admin.updateUser(u.id, { title: title.value }), '직위를 바꿨습니다.'));
        const admin = h('input', { type: 'checkbox', 'aria-label': `${u.name} 관리자`, checked: u.role === 'admin', disabled: u.id === me.id });
        admin.addEventListener('change', () => void run(() => api.admin.updateUser(u.id, { role: admin.checked ? 'admin' : 'user' }), '관리자 지정을 바꿨습니다.'));
        const active = h('input', { type: 'checkbox', 'aria-label': `${u.name} 사용`, checked: u.active, disabled: u.id === me.id });
        active.addEventListener('change', () =>
          void run(() => api.admin.updateUser(u.id, { active: active.checked }), active.checked ? `${u.name} 계정을 다시 쓰게 했습니다.` : `${u.name} 계정을 사용 중지했습니다.`),
        );
        return h(
          'tr',
          { class: u.active ? '' : 'inactive' },
          h('td', {}, h('b', {}, u.name), h('div', { class: 'sub' }, u.username, u.source === 'sso' ? ' · SSO' : '')),
          h('td', {}, dept),
          h('td', {}, title),
          h('td', { class: 'c' }, admin),
          h('td', { class: 'c' }, active),
          h(
            'td',
            {},
            u.source === 'local'
              ? h('button', {
                  class: 'btn small',
                  type: 'button',
                  onclick: () => {
                    const pw = prompt(`${u.name}의 새 암호 (8자 이상). 바꾸면 그 사람의 로그인이 모두 끊깁니다.`);
                    if (pw) void run(() => api.admin.updateUser(u.id, { password: pw }), '암호를 바꿨습니다. 새 암호를 본인에게 알려 주세요.');
                  },
                }, '암호 초기화')
              : h('span', { class: 'sub' }, 'SSO 로그인'),
          ),
        );
      }),
    );
    if (!shown.length) userBody.append(h('tr', {}, h('td', { colspan: '6', class: 'empty' }, '해당하는 구성원이 없습니다.')));
  }

  // 구성원 추가
  const nu = {
    username: h('input', { 'aria-label': '아이디', placeholder: '아이디', autocapitalize: 'off', required: true }),
    name: h('input', { 'aria-label': '이름', placeholder: '이름', required: true }),
    password: h('input', { 'aria-label': '임시 암호', placeholder: '임시 암호 (8자 이상)', type: 'text', required: true, minlength: '8' }),
    title: h('input', { 'aria-label': '직위', placeholder: '직위' }),
    deptHost: h('span'),
    admin: h('input', { type: 'checkbox', 'aria-label': '관리자로' }),
  };
  const addForm = h(
    'form',
    { class: 'add-user' },
    nu.username,
    nu.name,
    nu.password,
    nu.deptHost,
    nu.title,
    h('label', { class: 'inline' }, nu.admin, ' 관리자'),
    h('button', { class: 'btn primary small', type: 'submit' }, '구성원 추가'),
  );
  addForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const dept = nu.deptHost.querySelector('select');
    void run(
      () =>
        api.admin.createUser({
          username: nu.username.value,
          name: nu.name.value,
          password: nu.password.value,
          title: nu.title.value,
          deptId: dept?.value || null,
          role: nu.admin.checked ? 'admin' : 'user',
        }),
      `${nu.name.value} 계정을 만들었습니다. 아이디와 임시 암호를 본인에게 알려 주세요.`,
    ).then(() => addForm.reset());
  });

  // 조직 동기화
  const syncText = h('textarea', {
    rows: '6',
    'aria-label': '동기화할 조직 정보 (JSON)',
    placeholder:
      '{\n  "departments": [{ "externalId": "D100", "name": "기획조정실" }, { "externalId": "D110", "name": "정보화담당관", "parentExternalId": "D100" }],\n  "users": [{ "externalId": "E1001", "username": "hong", "name": "홍길동", "deptExternalId": "D110", "title": "주무관" }],\n  "deactivateMissing": false\n}',
  });
  const syncOut = h('pre', { class: 'sync-out' });
  const syncBtn = h('button', {
    class: 'btn small',
    type: 'button',
    onclick: async () => {
      let payload: unknown;
      try {
        payload = JSON.parse(syncText.value);
      } catch {
        syncOut.textContent = 'JSON 형식이 맞지 않습니다.';
        return;
      }
      try {
        syncOut.textContent = JSON.stringify(await api.admin.sync(payload), null, 2);
      } catch (e) {
        syncOut.textContent = errorMessage(e);
      }
      await refresh();
    },
  }, '동기화 실행');

  filter.addEventListener('input', renderUsers);

  async function refresh(): Promise<void> {
    try {
      [depts, users] = await Promise.all([api.admin.org(), api.admin.users()]);
    } catch (e) {
      status.textContent = errorMessage(e);
    }
    const df = deptSelect(depts, deptFilter || null, '부서로 거르기', { none: '모든 부서' });
    df.addEventListener('change', () => {
      deptFilter = df.value;
      renderUsers();
    });
    deptFilterHost.replaceChildren(df);
    const keep = nu.deptHost.querySelector('select')?.value ?? '';
    nu.deptHost.replaceChildren(deptSelect(depts, keep || null, '새 구성원 부서'));
    renderOrg();
    renderUsers();
  }

  root.append(
    h(
      'main',
      { class: 'home admin' },
      h('header', { class: 'home-head' }, h('h1', {}, '관리'), h('a', { class: 'btn small', href: '#/' }, '← 문서로')),
      status,
      h(
        'section',
        { class: 'card' },
        h('div', { class: 'sec-head' }, h('h2', {}, '조직도'), h('button', { class: 'btn small', type: 'button', onclick: () => void addDept(null) }, '+ 최상위 부서')),
        h('p', { class: 'hint' }, '부서에 준 문서·폴더 권한은 그 부서와 하위 부서 사람 모두에게 갑니다. 부서를 옮기면 권한도 따라 바뀝니다.'),
        orgList,
      ),
      h(
        'section',
        { class: 'card' },
        h('div', { class: 'sec-head' }, h('h2', {}, '구성원'), h('span', { class: 'filters' }, filter, deptFilterHost)),
        addForm,
        h(
          'div',
          { class: 'table-wrap' },
          h(
            'table',
            { class: 'users' },
            h('thead', {}, h('tr', {}, ...['이름', '부서', '직위', '관리자', '사용', ''].map((t) => h('th', {}, t)))),
            userBody,
          ),
        ),
      ),
      h(
        'section',
        { class: 'card' },
        h('h2', {}, '조직 동기화 (인사·SSO 시스템)'),
        h(
          'p',
          { class: 'hint' },
          '외부 시스템의 부서 코드·사번(externalId)으로 조직도와 구성원을 맞춥니다. 같은 내용을 관리용 API(POST /api/admin/sync)로 보낼 수도 있습니다. 이렇게 들어온 계정은 SSO로 로그인합니다.',
        ),
        syncText,
        syncBtn,
        syncOut,
      ),
    ),
  );
  await refresh();
  return () => {};
}
