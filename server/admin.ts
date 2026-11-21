// 관리자 API: 조직도(부서)와 구성원(계정) 관리, 인사·SSO 시스템과의 조직 동기화

import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { UserError } from './users.ts';
import type { UserStore, UserPatch, User } from './users.ts';
import type { OrgStore, Department } from './org.ts';
import type { FolderStore } from './folders.ts';
import type { Store } from './store.ts';

export interface AdminDeps {
  users: UserStore;
  org: OrgStore;
  folders: FolderStore;
  store: Store;
  /** 권한에 영향을 주는 변경 뒤에 열린 연결을 다시 검사한다 */
  recheck: () => Promise<void>;
}

const adminView = (u: User): object => ({
  id: u.id,
  username: u.username,
  name: u.name,
  title: u.title,
  deptId: u.deptId,
  role: u.role,
  active: u.active,
  source: u.source,
  externalId: u.externalId ?? null,
  createdAt: u.createdAt,
});

export function adminRouter({ users, org, folders, store, recheck }: AdminDeps): express.Router {
  const r = express.Router();
  r.use(express.json({ limit: '5mb' }));
  r.use((req: Request, res: Response, next: NextFunction) => {
    if (req.user?.role !== 'admin') {
      res.status(403).json({ error: '관리자만 할 수 있습니다.' });
      return;
    }
    next();
  });
  const route =
    (fn: (req: Request, res: Response) => Promise<unknown>) =>
    (req: Request, res: Response, next: NextFunction): void => {
      fn(req, res).catch(next);
    };
  const body = (req: Request): Record<string, unknown> => (req.body ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

  async function checkDept(id: unknown): Promise<string | null> {
    if (id === null || id === '' || id === undefined) return null;
    const d = await org.get(String(id));
    if (!d) throw new UserError('부서를 찾을 수 없습니다.', 404);
    return d.id;
  }

  /** 관리자가 한 명도 남지 않게 되는 변경을 막는다. */
  async function keepAnAdmin(target: string, patch: UserPatch): Promise<void> {
    const losing = patch.role === 'user' || patch.active === false;
    if (!losing) return;
    const admins = (await users.list()).filter((u) => u.role === 'admin' && u.active && u.id !== target);
    if (!admins.length) throw new UserError('관리자가 한 명은 있어야 합니다.');
  }

  // ── 구성원 ──
  r.get('/users', route(async (req, res) => {
    res.json((await users.list()).map(adminView));
  }));

  r.post('/users', route(async (req, res) => {
    const b = body(req);
    const u = await users.create(str(b.username) ?? '', str(b.name) ?? '', str(b.password) ?? '', {
      role: b.role === 'admin' ? 'admin' : 'user',
      deptId: await checkDept(b.deptId),
      title: str(b.title) ?? '',
    });
    res.status(201).json(adminView(u));
  }));

  r.patch('/users/:id', route(async (req, res) => {
    const b = body(req);
    const target = await users.get(String(req.params.id));
    if (!target) throw new UserError('사람을 찾을 수 없습니다.', 404);
    const patch: UserPatch = {};
    if (b.name !== undefined) patch.name = String(b.name);
    if (b.title !== undefined) patch.title = String(b.title);
    if (b.deptId !== undefined) patch.deptId = await checkDept(b.deptId);
    if (b.role !== undefined) patch.role = b.role === 'admin' ? 'admin' : 'user';
    if (b.active !== undefined) patch.active = b.active === true;
    if (b.password !== undefined) patch.password = String(b.password);
    if (target.id === req.user!.id && (patch.role === 'user' || patch.active === false)) {
      throw new UserError('자기 자신의 관리자 권한을 빼거나 사용 중지할 수 없습니다.');
    }
    await keepAnAdmin(target.id, patch);
    const u = await users.update(target.id, patch);
    await recheck();
    res.json(adminView(u));
  }));

  // ── 조직도 ──
  r.get('/org', route(async (req, res) => {
    res.json(await org.list());
  }));

  r.post('/org', route(async (req, res) => {
    const b = body(req);
    const d = await org.create(str(b.name) ?? '', await checkDept(b.parentId), str(b.externalId));
    res.status(201).json(d);
  }));

  r.patch('/org/:id', route(async (req, res) => {
    const b = body(req);
    const patch: { name?: string; parentId?: string | null; order?: number; externalId?: string } = {};
    if (b.name !== undefined) patch.name = String(b.name);
    if (b.parentId !== undefined) patch.parentId = await checkDept(b.parentId);
    if (typeof b.order === 'number') patch.order = b.order;
    if (b.externalId !== undefined) patch.externalId = String(b.externalId ?? '');
    const d = await org.update(String(req.params.id), patch);
    await recheck(); // 부서를 옮기면 부서 단위 권한이 달라질 수 있다
    res.json(d);
  }));

  r.delete('/org/:id', route(async (req, res) => {
    const id = String(req.params.id);
    if (!(await org.get(id))) throw new UserError('부서를 찾을 수 없습니다.', 404);
    if ((await users.list()).some((u) => u.deptId === id)) throw new UserError('구성원이 있는 부서는 지울 수 없습니다. 구성원을 먼저 다른 부서로 옮기세요.');
    await org.remove(id);
    // 이 부서에 주었던 권한은 함께 없앤다.
    for (const f of await folders.all()) {
      if (f.grants.some((g) => g.type === 'dept' && g.id === id)) await folders.update(f.id, { grants: f.grants.filter((g) => g.id !== id) });
    }
    for (const m of await store.list()) {
      if (m.shares.some((g) => g.type === 'dept' && g.id === id)) await store.updateMeta(m.id, { shares: m.shares.filter((g) => g.id !== id) });
    }
    await recheck();
    res.status(204).end();
  }));

  // ── 인사·SSO 시스템과 조직 동기화 ──
  // 본문: { departments: [{externalId, name, parentExternalId?, order?}],
  //        users: [{externalId, username, name, deptExternalId?, title?, active?}],
  //        deactivateMissing?: boolean }
  r.post('/sync', route(async (req, res) => {
    const b = body(req);
    const depts = Array.isArray(b.departments) ? (b.departments as Record<string, unknown>[]) : [];
    const people = Array.isArray(b.users) ? (b.users as Record<string, unknown>[]) : [];
    const result = { deptsCreated: 0, deptsUpdated: 0, usersCreated: 0, usersUpdated: 0, usersDeactivated: 0, errors: [] as string[] };

    // 1) 부서 만들기·이름 맞추기
    const byExt = new Map<string, Department>();
    for (const d of depts) {
      const ext = str(d.externalId);
      if (!ext) continue;
      try {
        const cur = await org.byExternalId(ext);
        if (cur) {
          byExt.set(ext, await org.update(cur.id, { name: str(d.name) ?? cur.name, ...(typeof d.order === 'number' ? { order: d.order } : {}) }));
          result.deptsUpdated++;
        } else {
          byExt.set(ext, await org.create(str(d.name) ?? ext, null, ext));
          result.deptsCreated++;
        }
      } catch (e) {
        result.errors.push(`부서 ${ext}: ${(e as Error).message}`);
      }
    }
    // 2) 상위 부서 맞추기
    for (const d of depts) {
      const ext = str(d.externalId);
      const me = ext ? byExt.get(ext) : undefined;
      if (!me) continue;
      const parentExt = str(d.parentExternalId);
      const parent = parentExt ? (byExt.get(parentExt) ?? (await org.byExternalId(parentExt))) : null;
      if (parentExt && !parent) {
        result.errors.push(`부서 ${ext}: 상위 부서 ${parentExt} 가 없습니다.`);
        continue;
      }
      try {
        if ((parent?.id ?? null) !== me.parentId) await org.update(me.id, { parentId: parent?.id ?? null });
      } catch (e) {
        result.errors.push(`부서 ${ext}: ${(e as Error).message}`);
      }
    }
    // 3) 사람
    const seen = new Set<string>();
    for (const p of people) {
      const ext = str(p.externalId);
      if (!ext) continue;
      seen.add(ext);
      const deptExt = str(p.deptExternalId);
      const dept = deptExt ? (byExt.get(deptExt) ?? (await org.byExternalId(deptExt))) : null;
      try {
        const { created } = await users.upsertExternal({
          externalId: ext,
          username: str(p.username) ?? ext,
          name: str(p.name) ?? ext,
          deptId: dept?.id ?? null,
          title: str(p.title),
          active: p.active === undefined ? true : p.active === true,
        });
        if (created) result.usersCreated++;
        else result.usersUpdated++;
      } catch (e) {
        result.errors.push(`사람 ${ext}: ${(e as Error).message}`);
      }
    }
    if (b.deactivateMissing === true) {
      for (const u of await users.list()) {
        if (u.source === 'sso' && u.active && u.externalId && !seen.has(u.externalId)) {
          await users.update(u.id, { active: false });
          result.usersDeactivated++;
        }
      }
    }
    await recheck();
    res.json(result);
  }));

  return r;
}
