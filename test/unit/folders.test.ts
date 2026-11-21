import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleXlsx } from './xlsx-sample.ts';
import { startServer, Agent, timeout, until } from './server-helpers.ts';

interface FolderInfo {
  id: string;
  name: string;
  role: 'owner' | 'member';
  memberUsers: { id: string; name: string }[];
  docCount: number;
}
interface DocInfo {
  id: string;
  title: string;
  role: string;
  folderId: string | null;
  folder: { id: string; name: string } | null;
}

const json = async <T>(r: Response): Promise<T> => (await r.json()) as T;

test('업무 폴더: 구성원은 폴더 안 문서를 모두 열고 고칠 수 있다', async () => {
  const t = await startServer();
  try {
    const lead = await new Agent(t.origin).signup('lead', '팀장');
    const mate = await new Agent(t.origin).signup('mate', '팀원');
    const other = await new Agent(t.origin).signup('other', '외부인');

    // 폴더 만들기
    assert.equal((await lead.json('/api/folders', 'POST', { name: '   ' })).status, 400);
    const f = await json<FolderInfo>(await lead.json('/api/folders', 'POST', { name: '2027 예산 편성' }));
    assert.equal(f.role, 'owner');
    assert.deepEqual(await json(await mate.fetch('/api/folders')), [], '구성원이 아니면 폴더가 보이지 않는다');
    assert.equal((await mate.fetch(`/api/folders/${f.id}`)).status, 404);

    // 폴더 안에 문서 올리기
    const doc = await json<DocInfo>(
      await lead.fetch(`/api/docs?filename=${encodeURIComponent('예산.xlsx')}&folder=${f.id}`, { method: 'POST', body: Buffer.from(await sampleXlsx()) }),
    );
    assert.equal(doc.folderId, f.id);
    assert.deepEqual(doc.folder, { id: f.id, name: '2027 예산 편성' });
    // 구성원이 아닌 폴더에는 올릴 수 없다.
    assert.equal((await other.fetch(`/api/docs?kind=xlsx&folder=${f.id}`, { method: 'POST' })).status, 404);
    assert.equal((await mate.fetch(`/api/docs/${doc.id}`)).status, 404, '구성원이 되기 전에는 볼 수 없다');

    // 구성원 추가 → 문서마다 권한을 주지 않아도 열린다.
    const added = await json<FolderInfo>(await lead.json(`/api/folders/${f.id}/members`, 'PUT', { userIds: [mate.id, 'u없는사람'] }));
    assert.deepEqual(added.memberUsers.map((u) => u.name), ['팀원']);
    const mateFolders = await json<FolderInfo[]>(await mate.fetch('/api/folders'));
    assert.deepEqual(mateFolders.map((x) => [x.name, x.role, x.docCount]), [['2027 예산 편성', 'member', 1]]);
    const seen = await json<DocInfo[]>(await mate.fetch(`/api/docs?folder=${f.id}`));
    assert.deepEqual(seen.map((d) => [d.id, d.role]), [[doc.id, 'folder']]);
    assert.deepEqual(await json(await mate.fetch('/api/docs?folder=none')), []);
    assert.equal((await other.fetch(`/api/docs/${doc.id}`)).status, 404);

    // 구성원도 폴더에 문서를 올릴 수 있고, 그 문서는 팀장도 연다.
    const byMate = await json<DocInfo>(await mate.fetch(`/api/docs?kind=hwpx&folder=${f.id}`, { method: 'POST' }));
    assert.equal((await lead.fetch(`/api/docs/${byMate.id}`)).status, 200);

    // 구성원은 구성원을 바꾸거나 폴더를 지울 수 없다.
    assert.equal((await mate.json(`/api/folders/${f.id}/members`, 'PUT', { userIds: [other.id] })).status, 403);
    assert.equal((await mate.fetch(`/api/folders/${f.id}`, { method: 'DELETE' })).status, 403);
    assert.equal((await mate.json(`/api/folders/${f.id}`, 'PATCH', { name: '바꿈' })).status, 403);
    // 남이 올린 문서를 다른 곳으로 옮길 수도 없다.
    assert.equal((await mate.json(`/api/docs/${doc.id}/folder`, 'PUT', { folderId: null })).status, 403);

    // 폴더 구성원으로 실시간 접속 → 구성원에서 빼면 끊긴다.
    const c = mate.connect(t.port, doc.id);
    assert.equal(await timeout(c.result, 4000, 'timeout' as const), 'synced');
    await lead.json(`/api/folders/${f.id}/members`, 'PUT', { userIds: [] });
    await until(() => c.denied, 3000);
    c.destroy();
    assert.equal((await mate.fetch(`/api/docs/${doc.id}`)).status, 404);
    // 자기가 올린 문서는 폴더 구성원에서 빠져도 계속 볼 수 있다.
    assert.equal((await mate.fetch(`/api/docs/${byMate.id}`)).status, 200);

    // 폴더 밖 문서를 폴더로 옮기기
    const loose = await json<DocInfo>(await lead.fetch('/api/docs?kind=xlsx', { method: 'POST' }));
    assert.equal(loose.folderId, null);
    const other2 = await json<FolderInfo>(await other.json('/api/folders', 'POST', { name: '남의 폴더' }));
    assert.equal((await lead.json(`/api/docs/${loose.id}/folder`, 'PUT', { folderId: other2.id })).status, 404, '구성원이 아닌 폴더로는 못 옮긴다');
    const moved = await json<DocInfo>(await lead.json(`/api/docs/${loose.id}/folder`, 'PUT', { folderId: f.id }));
    assert.equal(moved.folderId, f.id);

    // 이름 바꾸기, 지우기 (문서는 남고 폴더 밖으로)
    assert.equal((await json<FolderInfo>(await lead.json(`/api/folders/${f.id}`, 'PATCH', { name: '2027 예산(확정)' }))).name, '2027 예산(확정)');
    await lead.json(`/api/folders/${f.id}/members`, 'PUT', { userIds: [mate.id] });
    assert.equal((await lead.fetch(`/api/folders/${f.id}`, { method: 'DELETE' })).status, 204);
    const after = await json<DocInfo>(await lead.fetch(`/api/docs/${doc.id}`));
    assert.equal(after.folderId, null);
    assert.equal((await mate.fetch(`/api/docs/${doc.id}`)).status, 404, '폴더가 없어지면 구성원 권한도 없어진다');
    assert.equal((await lead.fetch(`/api/folders/${f.id}`)).status, 404);
  } finally {
    await t.close();
  }
});
