// 조직도 (부서 트리).
//   <DATA_DIR>/org.json
// 관리자가 화면에서 고치거나, 인사·SSO 시스템과 동기화 API 로 맞춘다 (externalId 기준).

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { UserError } from './users.ts';

export interface Department {
  id: string;
  name: string;
  parentId: string | null;
  /** 같은 상위 부서 안에서의 순서 */
  order: number;
  /** 외부 시스템(인사·SSO)의 부서 코드 */
  externalId?: string;
}

const ID_RE = /^d[a-z0-9]{11}$/;
const MAX_DEPTH = 10;

export class OrgStore {
  private readonly file: string;
  private depts: Department[] = [];
  private loaded: Promise<void> | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'org.json');
  }

  static isId(id: unknown): id is string {
    return typeof id === 'string' && ID_RE.test(id);
  }

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      try {
        this.depts = JSON.parse(await readFile(this.file, 'utf8')) as Department[];
      } catch {
        this.depts = [];
      }
    })();
    return this.loaded;
  }

  private save(): Promise<void> {
    const data = JSON.stringify(this.depts, null, 2);
    this.writing = this.writing.then(async () => {
      const tmp = `${this.file}.${randomBytes(4).toString('hex')}.tmp`;
      await writeFile(tmp, data);
      await rename(tmp, this.file);
    });
    return this.writing;
  }

  private static cleanName(name: string): string {
    const n = String(name ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60);
    if (!n) throw new UserError('부서 이름을 입력하세요.');
    return n;
  }

  async list(): Promise<Department[]> {
    await this.load();
    return [...this.depts];
  }

  async get(id: string | null | undefined): Promise<Department | null> {
    if (!OrgStore.isId(id)) return null;
    await this.load();
    return this.depts.find((d) => d.id === id) ?? null;
  }

  /** 부서와 그 모든 상위 부서 id (자기 자신부터) */
  async chain(id: string | null | undefined): Promise<string[]> {
    await this.load();
    const out: string[] = [];
    let cur = this.depts.find((d) => d.id === id);
    while (cur && out.length < 50) {
      out.push(cur.id);
      cur = cur.parentId ? this.depts.find((d) => d.id === cur!.parentId) : undefined;
    }
    return out;
  }

  /** 부서와 그 모든 하위 부서 id */
  async subtree(id: string): Promise<Set<string>> {
    await this.load();
    const out = new Set<string>([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const d of this.depts) {
        if (d.parentId && out.has(d.parentId) && !out.has(d.id)) {
          out.add(d.id);
          grew = true;
        }
      }
    }
    return out;
  }

  private async depthOf(parentId: string | null): Promise<number> {
    return parentId ? (await this.chain(parentId)).length : 0;
  }

  async create(name: string, parentId: string | null, externalId?: string): Promise<Department> {
    await this.load();
    if (parentId && !(await this.get(parentId))) throw new UserError('상위 부서를 찾을 수 없습니다.', 404);
    if ((await this.depthOf(parentId)) >= MAX_DEPTH) throw new UserError(`부서는 ${MAX_DEPTH}단계까지 만들 수 있습니다.`);
    const d: Department = {
      id: 'd' + randomBytes(9).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, 'x').slice(0, 11),
      name: OrgStore.cleanName(name),
      parentId,
      order: this.depts.filter((x) => x.parentId === parentId).length,
    };
    if (externalId) d.externalId = externalId;
    this.depts.push(d);
    await this.save();
    return d;
  }

  async update(id: string, patch: { name?: string; parentId?: string | null; order?: number; externalId?: string }): Promise<Department> {
    await this.load();
    const d = this.depts.find((x) => x.id === id);
    if (!d) throw new UserError('부서를 찾을 수 없습니다.', 404);
    if (patch.name !== undefined) d.name = OrgStore.cleanName(patch.name);
    if (patch.parentId !== undefined && patch.parentId !== d.parentId) {
      if (patch.parentId) {
        if (!(await this.get(patch.parentId))) throw new UserError('상위 부서를 찾을 수 없습니다.', 404);
        if ((await this.subtree(id)).has(patch.parentId)) throw new UserError('자기 하위 부서 아래로는 옮길 수 없습니다.');
        if ((await this.depthOf(patch.parentId)) >= MAX_DEPTH) throw new UserError(`부서는 ${MAX_DEPTH}단계까지 만들 수 있습니다.`);
      }
      d.parentId = patch.parentId;
      d.order = this.depts.filter((x) => x.parentId === d.parentId && x.id !== d.id).length;
    }
    if (patch.order !== undefined && Number.isFinite(patch.order)) d.order = patch.order;
    if (patch.externalId !== undefined) d.externalId = patch.externalId || undefined;
    await this.save();
    return d;
  }

  /** 하위 부서가 없을 때만 지운다 (구성원 확인은 부르는 쪽에서). */
  async remove(id: string): Promise<void> {
    await this.load();
    if (this.depts.some((d) => d.parentId === id)) throw new UserError('하위 부서가 있는 부서는 지울 수 없습니다.');
    this.depts = this.depts.filter((d) => d.id !== id);
    await this.save();
  }

  async byExternalId(externalId: string): Promise<Department | null> {
    await this.load();
    return this.depts.find((d) => d.externalId === externalId) ?? null;
  }

  /** 이름에 q 가 들어간 부서 */
  async search(q: string, limit = 10): Promise<Department[]> {
    await this.load();
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    return this.depts.filter((d) => d.name.toLowerCase().includes(needle)).slice(0, limit);
  }

  /** "본부 > 과 > 팀" 형태의 경로 이름 */
  async pathName(id: string | null | undefined): Promise<string> {
    const chain = await this.chain(id);
    const names = chain.map((c) => this.depts.find((d) => d.id === c)!.name);
    return names.reverse().join(' > ');
  }
}
