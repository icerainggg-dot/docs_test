import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleXlsx } from './xlsx-sample.ts';
import { startServer, Agent, timeout, until } from './server-helpers.ts';

interface FolderInfo {
  id: string;
  name: string;
  parentId: string | null;
  depth: number;
  canAddChild: boolean;
  role: string;
  grants: { type: string; id: string; role: string; name: string }[];
  path: { id: string; name: string }[];
  docCount: number;
}
interface DocInfo {
  id: string;
  role: string;
  folderId: string | null;
  path: { name: string }[];
}

const json = async <T>(r: Response): Promise<T> => (await r.json()) as T;
const user = (id: string, role = 'edit'): object => ({ type: 'user', id, role });
const dept = (id: string, role = 'edit'): object => ({ type: 'dept', id, role });

test('업무 폴더: 3단계까지, 위 폴더 권한은 아래로 이어진다', async () => {
  const t = await startServer();
  try {
    const lead = await new Agent(t.origin).signup('lead', '팀장');
    const mate = await new Agent(t.origin).signup('mate', '팀원');
    const guest = await new Agent(t.origin).signup('guest', '참관인');
    const other = await new Agent(t.origin).signup('other', '외부인');

    assert.equal((await lead.json('/api/folders', 'POST', { name: '   ' })).status, 400);
    const top = await json<FolderInfo>(await lead.json('/api/folders', 'POST', { name: '2027 예산' }));
    const mid = await json<FolderInfo>(await lead.json('/api/folders', 'POST', { name: '본예산', parentId: top.id }));
    const low = await json<FolderInfo>(await lead.json('/api/folders', 'POST', { name: '정보화', parentId: mid.id }));
    assert.deepEqual([top.depth, mid.depth, low.depth], [1, 2, 3]);
    assert.deepEqual(low.path.map((p) => p.name), ['2027 예산', '본예산', '정보화']);
    assert.equal(low.canAddChild, false);
    const fourth = await lead.json('/api/folders', 'POST', { name: '넷째', parentId: low.id });
    assert.equal(fourth.status, 400, '4단계는 만들 수 없다');
    assert.match(((await fourth.json()) as { error: string }).error, /3단계/);

    // 맨 아래 폴더에 문서
    const doc = await json<DocInfo>(
      await lead.fetch(`/api/docs?filename=a.xlsx&folder=${low.id}`, { method: 'POST', body: Buffer.from(await sampleXlsx()) }),
    );
    assert.deepEqual(doc.path.map((p) => p.name), ['2027 예산', '본예산', '정보화']);
    assert.deepEqual(await json(await mate.fetch('/api/folders')), []);

    // 맨 위 폴더에 팀원(편집)·참관인(보기) → 아래 폴더와 문서에도
    const set = await lead.json(`/api/folders/${top.id}/grants`, 'PUT', { grants: [user(mate.id), user(guest.id, 'view'), user(lead.id), user('u없음')] });
    assert.deepEqual(((await set.json()) as FolderInfo).grants.map((g) => [g.name, g.role]), [['팀원', 'edit'], ['참관인', 'view']]);
    const mateFolders = await json<FolderInfo[]>(await mate.fetch('/api/folders'));
    assert.deepEqual(mateFolders.map((f) => [f.name, f.role]).sort(), [['2027 예산', 'edit'], ['본예산', 'edit'], ['정보화', 'edit']]);
    assert.equal((await json<DocInfo>(await mate.fetch(`/api/docs/${doc.id}`))).role, 'edit');
    assert.equal((await json<DocInfo>(await guest.fetch(`/api/docs/${doc.id}`))).role, 'view');
    assert.equal((await other.fetch(`/api/docs/${doc.id}`)).status, 404);

    // 편집 권한이 있으면 하위 폴더·문서를 만들 수 있고, 보기 권한은 못 한다.
    const byMate = await mate.json('/api/folders', 'POST', { name: '팀원 폴더', parentId: mid.id });
    assert.equal(byMate.status, 201);
    assert.equal((await guest.json('/api/folders', 'POST', { name: 'x', parentId: mid.id })).status, 403);
    assert.equal((await guest.fetch(`/api/docs?kind=xlsx&folder=${mid.id}`, { method: 'POST' })).status, 403);
    assert.equal((await mate.fetch(`/api/docs?kind=hwpx&folder=${mid.id}`, { method: 'POST' })).status, 201);
    // 구성원은 권한을 바꾸지 못하고, 위 폴더를 만든 사람은 아래 폴더 권한도 바꿀 수 있다.
    assert.equal((await mate.json(`/api/folders/${low.id}/grants`, 'PUT', { grants: [] })).status, 403);
    const mateFolder = await json<FolderInfo>(byMate);
    assert.equal((await lead.json(`/api/folders/${mateFolder.id}`, 'PATCH', { name: '팀원 폴더(정리)' })).status, 200);

    // 보기 권한 실시간 연결은 읽기 전용
    const g = guest.connect(t.port, doc.id);
    assert.equal(await timeout(g.result, 4000, 'timeout' as const), 'synced');
    // 아래 폴더에서 참관인에게 편집 권한을 더 주면 그 폴더에서는 편집이 된다 (가장 높은 권한).
    await lead.json(`/api/folders/${low.id}/grants`, 'PUT', { grants: [user(guest.id)] });
    await until(() => g.closedReason === 'RoleChanged', 3000);
    g.destroy();
    assert.equal((await json<DocInfo>(await guest.fetch(`/api/docs/${doc.id}`))).role, 'edit');

    // 맨 위 폴더 권한을 거두면 아래 폴더 문서도 닫힌다 (아래 폴더에 따로 받은 권한은 남는다).
    const m = mate.connect(t.port, doc.id);
    await m.result;
    await lead.json(`/api/folders/${top.id}/grants`, 'PUT', { grants: [] });
    await until(() => m.denied, 3000);
    m.destroy();
    assert.equal((await mate.fetch(`/api/docs/${doc.id}`)).status, 404);
    assert.equal((await json<DocInfo>(await guest.fetch(`/api/docs/${doc.id}`))).role, 'edit');

    // 가운데 폴더를 지우면 아래 폴더도 지워지고, 문서는 맨 위 폴더로 올라온다.
    assert.equal((await lead.fetch(`/api/folders/${mid.id}`, { method: 'DELETE' })).status, 204);
    assert.equal((await lead.fetch(`/api/folders/${low.id}`)).status, 404);
    assert.equal((await json<DocInfo>(await lead.fetch(`/api/docs/${doc.id}`))).folderId, top.id);
    // 문서 옮기기: 편집 권한이 있는 폴더로만
    const theirs = await json<FolderInfo>(await other.json('/api/folders', 'POST', { name: '남의 폴더' }));
    assert.equal((await lead.json(`/api/docs/${doc.id}/folder`, 'PUT', { folderId: theirs.id })).status, 404);
    await other.json(`/api/folders/${theirs.id}/grants`, 'PUT', { grants: [user(lead.id, 'view')] });
    assert.equal((await lead.json(`/api/docs/${doc.id}/folder`, 'PUT', { folderId: theirs.id })).status, 403, '보기 권한 폴더로는 못 옮긴다');
    assert.equal((await json<DocInfo>(await lead.json(`/api/docs/${doc.id}/folder`, 'PUT', { folderId: null }))).folderId, null);
  } finally {
    await t.close();
  }
});

test('부서 단위 권한: 하위 부서까지, 조직도가 바뀌면 권한도 따라간다', async () => {
  const t = await startServer();
  try {
    const admin = await new Agent(t.origin).signup('admin', '관리자'); // 첫 계정 = 관리자
    const kim = await new Agent(t.origin).signup('kim', '김정보');
    const lee = await new Agent(t.origin).signup('lee', '이기획');

    const mk = async (name: string, parentId: string | null = null): Promise<{ id: string }> =>
      json(await admin.json('/api/admin/org', 'POST', { name, parentId }));
    const hq = await mk('기획조정실');
    const it = await mk('정보화담당관', hq.id);
    const team = await mk('정보운영팀', it.id);
    const plan = await mk('기획예산담당관', hq.id);
    await admin.json(`/api/admin/users/${kim.id}`, 'PATCH', { deptId: team.id, title: '주무관' });
    await admin.json(`/api/admin/users/${lee.id}`, 'PATCH', { deptId: plan.id });

    // 정보화담당관(하위 정보운영팀 포함)에 편집 권한
    const doc = await json<DocInfo>(await admin.fetch('/api/docs?kind=xlsx', { method: 'POST' }));
    const found = await json<{ depts: { id: string; path: string }[] }>(await admin.fetch('/api/people?q=정보화'));
    assert.deepEqual(found.depts.map((d) => d.path), ['기획조정실 > 정보화담당관']);
    await admin.json(`/api/docs/${doc.id}/shares`, 'PUT', { grants: [dept(it.id)] });
    assert.equal((await json<DocInfo>(await kim.fetch(`/api/docs/${doc.id}`))).role, 'edit', '하위 부서 사람도');
    assert.equal((await lee.fetch(`/api/docs/${doc.id}`)).status, 404, '다른 부서는 안 됨');

    // 김정보가 기획예산담당관으로 옮기면 권한이 없어지고, 열어 둔 화면도 끊긴다.
    const c = kim.connect(t.port, doc.id);
    assert.equal(await c.result, 'synced');
    await admin.json(`/api/admin/users/${kim.id}`, 'PATCH', { deptId: plan.id });
    await until(() => c.denied, 3000);
    c.destroy();
    assert.equal((await kim.fetch(`/api/docs/${doc.id}`)).status, 404);

    // 부서를 옮기면(조직 개편) 그 아래 사람의 권한도 바뀐다.
    await admin.json(`/api/admin/org/${plan.id}`, 'PATCH', { parentId: it.id });
    assert.equal((await json<DocInfo>(await lee.fetch(`/api/docs/${doc.id}`))).role, 'edit');
    assert.equal((await admin.json(`/api/admin/org/${it.id}`, 'PATCH', { parentId: team.id })).status, 400, '자기 아래로는 못 옮긴다');

    // 구성원이 있거나 하위 부서가 있으면 지울 수 없다. 지운 부서의 권한은 없어진다.
    assert.equal((await admin.fetch(`/api/admin/org/${plan.id}`, { method: 'DELETE' })).status, 400);
    assert.equal((await admin.fetch(`/api/admin/org/${hq.id}`, { method: 'DELETE' })).status, 400);
    assert.equal((await admin.fetch(`/api/admin/org/${team.id}`, { method: 'DELETE' })).status, 204);
  } finally {
    await t.close();
  }
});
