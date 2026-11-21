import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, Agent } from './server-helpers.ts';

interface AdminUser {
  id: string;
  username: string;
  name: string;
  role: string;
  active: boolean;
  deptId: string | null;
  title: string;
  source: string;
}
const json = async <T>(r: Response): Promise<T> => (await r.json()) as T;

test('관리자: 첫 계정이 관리자, 구성원 만들기·고치기·사용 중지', async () => {
  const t = await startServer();
  try {
    const admin = await new Agent(t.origin).signup('admin', '관리자');
    const bob = await new Agent(t.origin).signup('bob', '박보통');
    const me = await json<{ user: { role: string } }>(await admin.fetch('/api/auth/me'));
    assert.equal(me.user.role, 'admin');
    assert.equal((await bob.fetch('/api/admin/users')).status, 403, '일반 사용자는 관리 화면을 못 쓴다');
    assert.equal((await bob.json('/api/admin/org', 'POST', { name: '몰래' })).status, 403);

    // 계정 만들기
    const dept = await json<{ id: string }>(await admin.json('/api/admin/org', 'POST', { name: '총무과' }));
    const created = await admin.json('/api/admin/users', 'POST', { username: 'choi', name: '최신규', password: 'temporary-pw1', deptId: dept.id, title: '주무관' });
    assert.equal(created.status, 201);
    const choi = await json<AdminUser>(created);
    assert.deepEqual([choi.deptId, choi.title, choi.role], [dept.id, '주무관', 'user']);
    assert.equal((await new Agent(t.origin).json('/api/auth/login', 'POST', { username: 'choi', password: 'temporary-pw1' })).status, 200);

    // 암호 초기화 → 예전 암호와 로그인이 모두 무효
    const choiAgent = new Agent(t.origin);
    await choiAgent.json('/api/auth/login', 'POST', { username: 'choi', password: 'temporary-pw1' });
    await admin.json(`/api/admin/users/${choi.id}`, 'PATCH', { password: 'new-password-9' });
    assert.equal((await choiAgent.fetch('/api/docs')).status, 401);
    assert.equal((await new Agent(t.origin).json('/api/auth/login', 'POST', { username: 'choi', password: 'new-password-9' })).status, 200);

    // 사용 중지 → 로그인 불가, 찾기에서도 안 보임
    const doc = await json<{ id: string }>(await bob.fetch('/api/docs?kind=xlsx', { method: 'POST' }));
    await admin.json(`/api/admin/users/${bob.id}`, 'PATCH', { active: false });
    assert.equal((await bob.fetch('/api/docs')).status, 401, '로그인이 끊긴다');
    assert.equal((await new Agent(t.origin).json('/api/auth/login', 'POST', { username: 'bob', password: 'password1234' })).status, 401);
    assert.deepEqual((await json<{ users: unknown[] }>(await admin.fetch('/api/people?q=보통'))).users, []);
    await admin.json(`/api/admin/users/${bob.id}`, 'PATCH', { active: true });
    const bob2 = new Agent(t.origin);
    await bob2.json('/api/auth/login', 'POST', { username: 'bob', password: 'password1234' });
    assert.equal((await bob2.fetch(`/api/docs/${doc.id}`)).status, 200, '다시 쓰면 문서는 그대로');

    // 관리자 지정, 자기 자신·마지막 관리자 보호
    assert.equal((await admin.json(`/api/admin/users/${admin.id}`, 'PATCH', { role: 'user' })).status, 400);
    assert.equal((await admin.json(`/api/admin/users/${admin.id}`, 'PATCH', { active: false })).status, 400);
    await admin.json(`/api/admin/users/${bob.id}`, 'PATCH', { role: 'admin' });
    assert.equal((await bob2.fetch('/api/admin/users')).status, 200);
    assert.equal((await bob2.json(`/api/admin/users/${admin.id}`, 'PATCH', { role: 'user' })).status, 200, '다른 관리자가 있으면 뺄 수 있다');
    assert.equal((await bob2.json(`/api/admin/users/${bob.id}`, 'PATCH', { role: 'user' })).status, 400);

    // 부서가 없는 사람·없는 부서
    assert.equal((await bob2.json(`/api/admin/users/${choi.id}`, 'PATCH', { deptId: 'dnosuchdept1' })).status, 404);
  } finally {
    await t.close();
  }
});

test('조직 동기화 API: 외부 시스템 코드로 부서·사람을 맞춘다 (SSO 연동 준비)', async () => {
  const t = await startServer();
  try {
    const admin = await new Agent(t.origin).signup('admin', '관리자');
    const payload = {
      departments: [
        { externalId: 'D100', name: '기획조정실' },
        { externalId: 'D110', name: '정보화담당관', parentExternalId: 'D100' },
        { externalId: 'D111', name: '정보운영팀', parentExternalId: 'D110' },
        { externalId: 'D999', name: '고아부서', parentExternalId: 'NOPE' },
      ],
      users: [
        { externalId: 'E1001', username: 'jeong', name: '정운영', deptExternalId: 'D111', title: '팀장' },
        { externalId: 'E1002', username: 'han', name: '한기획', deptExternalId: 'D100' },
        { externalId: 'E1003', username: 'Bad Name!', name: '잘못된아이디' },
      ],
    };
    const r1 = await json<Record<string, number | string[]>>(await admin.json('/api/admin/sync', 'POST', payload));
    assert.equal(r1.deptsCreated, 4);
    assert.equal(r1.usersCreated, 2);
    assert.equal((r1.errors as string[]).length, 2, '상위 부서 없음, 잘못된 아이디');

    const org = await json<{ id: string; name: string; parentId: string | null; externalId?: string }[]>(await admin.fetch('/api/admin/org'));
    const byExt = new Map(org.map((d) => [d.externalId, d]));
    assert.equal(byExt.get('D111')!.parentId, byExt.get('D110')!.id);
    const users = await json<AdminUser[]>(await admin.fetch('/api/admin/users'));
    const jeong = users.find((u) => u.username === 'jeong')!;
    assert.deepEqual([jeong.source, jeong.deptId, jeong.title], ['sso', byExt.get('D111')!.id, '팀장']);
    // 외부 계정은 이 서버 암호가 없어 로컬 로그인이 안 된다 (SSO 로 들어온다).
    assert.equal((await new Agent(t.origin).json('/api/auth/login', 'POST', { username: 'jeong', password: 'anything12' })).status, 401);

    // 두 번째 동기화: 이름 바뀜, 부서 이동, 빠진 사람은 사용 중지
    const r2 = await json<Record<string, number>>(
      await admin.json('/api/admin/sync', 'POST', {
        departments: [
          { externalId: 'D100', name: '기획조정실' },
          { externalId: 'D110', name: '디지털정책담당관', parentExternalId: 'D100' },
          { externalId: 'D111', name: '정보운영팀', parentExternalId: 'D100' },
        ],
        users: [{ externalId: 'E1001', username: 'jeong', name: '정운영', deptExternalId: 'D110', title: '과장' }],
        deactivateMissing: true,
      }),
    );
    assert.equal(r2.deptsCreated, 0);
    assert.equal(r2.usersUpdated, 1);
    assert.equal(r2.usersDeactivated, 1);
    const org2 = await json<{ name: string; parentId: string | null; externalId?: string }[]>(await admin.fetch('/api/admin/org'));
    const by2 = new Map(org2.map((d) => [d.externalId, d]));
    assert.equal(by2.get('D110')!.name, '디지털정책담당관');
    const users2 = await json<AdminUser[]>(await admin.fetch('/api/admin/users'));
    assert.equal(users2.find((u) => u.username === 'han')!.active, false);
    assert.equal(users2.find((u) => u.username === 'admin')!.active, true, '이 서버에서 만든 계정은 건드리지 않는다');
  } finally {
    await t.close();
  }
});
