// 권한 판정.
//
// 권한은 사람 또는 부서에 "편집" / "보기" 로 준다 (Grant). 부서에 주면 그 부서와 하위 부서 사람 모두에게 간다.
//   - 문서: 올린 사람(owner) > 문서에 준 권한 > 문서가 든 폴더(와 그 상위 폴더)에 준 권한 중 가장 높은 것
//   - 폴더: 그 폴더나 상위 폴더를 만든 사람은 관리(owner), 그 밖에는 그 폴더와 상위 폴더에 준 권한 중 가장 높은 것

import type { DocMeta } from './store.ts';
import type { FolderStore } from './folders.ts';
import type { OrgStore } from './org.ts';
import type { User, UserStore } from './users.ts';
import { UserError } from './users.ts';

export type GrantRole = 'edit' | 'view';
export type Role = 'owner' | GrantRole;

export interface Grant {
  type: 'user' | 'dept';
  id: string;
  role: GrantRole;
}

const RANK: Record<Role, number> = { view: 1, edit: 2, owner: 3 };

export const atLeast = (role: Role | null, need: Role): boolean => !!role && RANK[role] >= RANK[need];
const max = (a: Role | null, b: Role | null): Role | null => (!a ? b : !b ? a : RANK[a] >= RANK[b] ? a : b);

/** 권한을 따지는 사람: id 와 소속 부서(상위 부서 포함) */
export interface Who {
  id: string;
  depts: Set<string>;
}

export class Access {
  private readonly folders: FolderStore;
  private readonly org: OrgStore;
  private readonly users: UserStore;

  constructor(folders: FolderStore, org: OrgStore, users: UserStore) {
    this.folders = folders;
    this.org = org;
    this.users = users;
  }

  async who(user: User | string): Promise<Who> {
    const u = typeof user === 'string' ? await this.users.get(user) : user;
    if (!u || !u.active) return { id: typeof user === 'string' ? user : user.id, depts: new Set() };
    return { id: u.id, depts: new Set(await this.org.chain(u.deptId)) };
  }

  grantRole(grants: Grant[] | undefined, who: Who): Role | null {
    let r: Role | null = null;
    for (const g of grants ?? []) {
      if ((g.type === 'user' && g.id === who.id) || (g.type === 'dept' && who.depts.has(g.id))) r = max(r, g.role);
    }
    return r;
  }

  async folderRole(folderId: string | null | undefined, who: Who): Promise<Role | null> {
    let r: Role | null = null;
    for (const f of await this.folders.chain(folderId)) {
      if (f.owner === who.id) return 'owner';
      r = max(r, this.grantRole(f.grants, who));
    }
    return r;
  }

  async docRole(meta: DocMeta, who: Who): Promise<Role | null> {
    if (meta.owner === who.id) return 'owner';
    let r = this.grantRole(meta.shares, who);
    if (meta.folderId) {
      const fr = await this.folderRole(meta.folderId, who);
      // 폴더를 관리하는 사람은 그 안의 문서를 고칠 수 있다 (지우거나 공유를 바꾸는 것은 문서를 올린 사람만).
      r = max(r, fr === 'owner' ? 'edit' : fr);
    }
    return r;
  }

  /** 화면에서 받은 권한 목록을 확인해 정리한다. 없는 사람·부서, 중복, 제외할 사람은 뺀다. */
  async cleanGrants(input: unknown, exclude: string[] = []): Promise<Grant[]> {
    if (!Array.isArray(input)) throw new UserError('grants 가 필요합니다.');
    const out = new Map<string, Grant>();
    for (const raw of input.slice(0, 500)) {
      const g = raw as Partial<Grant>;
      if ((g.type !== 'user' && g.type !== 'dept') || typeof g.id !== 'string') continue;
      const role: GrantRole = g.role === 'view' ? 'view' : 'edit';
      if (exclude.includes(g.id)) continue;
      if (g.type === 'user' ? !(await this.users.get(g.id)) : !(await this.org.get(g.id))) continue;
      out.set(`${g.type}:${g.id}`, { type: g.type, id: g.id, role });
    }
    return [...out.values()];
  }
}
