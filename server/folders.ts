// 업무(프로젝트) 폴더. 최대 3단계까지 하위 폴더를 둘 수 있다.
//   <DATA_DIR>/folders.json
// 폴더를 만든 사람이 권한을 정한다. 위 폴더에 준 권한은 아래 폴더와 그 안의 문서에도 그대로 간다.

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { UserError } from './users.ts';
import type { Grant } from './access.ts';

export interface Folder {
  id: string;
  name: string;
  /** 상위 폴더 (맨 위 폴더는 null) */
  parentId: string | null;
  /** 만든 사람 (권한을 정할 수 있는 사람) */
  owner: string;
  /** 사람·부서에 준 편집/보기 권한 */
  grants: Grant[];
  createdAt: string;
}

export const MAX_FOLDER_DEPTH = 3;
const ID_RE = /^f[a-z0-9]{11}$/;

export class FolderStore {
  private readonly file: string;
  private folders: Folder[] = [];
  private loaded: Promise<void> | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'folders.json');
  }

  static isId(id: unknown): id is string {
    return typeof id === 'string' && ID_RE.test(id);
  }

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      await mkdir(path.dirname(this.file), { recursive: true });
      try {
        const raw = JSON.parse(await readFile(this.file, 'utf8')) as (Folder & { members?: string[] })[];
        // 예전 판: members(편집 권한) → grants
        this.folders = raw.map((f) => {
          const { members, ...rest } = f;
          return { ...rest, parentId: f.parentId ?? null, grants: f.grants ?? (members ?? []).map((id) => ({ type: 'user', id, role: 'edit' })) };
        });
      } catch {
        this.folders = [];
      }
    })();
    return this.loaded;
  }

  private save(): Promise<void> {
    const data = JSON.stringify(this.folders, null, 2);
    this.writing = this.writing.then(async () => {
      const tmp = `${this.file}.${randomBytes(4).toString('hex')}.tmp`;
      await writeFile(tmp, data);
      await rename(tmp, this.file);
    });
    return this.writing;
  }

  private static cleanName(name: string): string {
    const n = String(name ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60);
    if (!n) throw new UserError('폴더 이름을 입력하세요.');
    return n;
  }

  async all(): Promise<Folder[]> {
    await this.load();
    return [...this.folders];
  }

  async get(id: string | null | undefined): Promise<Folder | null> {
    if (!FolderStore.isId(id)) return null;
    await this.load();
    return this.folders.find((f) => f.id === id) ?? null;
  }

  /** 폴더와 상위 폴더들 (자기 자신부터 맨 위까지) */
  async chain(id: string | null | undefined): Promise<Folder[]> {
    await this.load();
    const out: Folder[] = [];
    let cur = FolderStore.isId(id) ? this.folders.find((f) => f.id === id) : undefined;
    while (cur && out.length < MAX_FOLDER_DEPTH + 2) {
      out.push(cur);
      cur = cur.parentId ? this.folders.find((f) => f.id === cur!.parentId) : undefined;
    }
    return out;
  }

  /** 폴더와 모든 하위 폴더 id */
  async subtree(id: string): Promise<Set<string>> {
    await this.load();
    const out = new Set<string>([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const f of this.folders) {
        if (f.parentId && out.has(f.parentId) && !out.has(f.id)) {
          out.add(f.id);
          grew = true;
        }
      }
    }
    return out;
  }

  async create(name: string, owner: string, parentId: string | null = null): Promise<Folder> {
    await this.load();
    if (parentId) {
      const depth = (await this.chain(parentId)).length;
      if (!depth) throw new UserError('상위 폴더를 찾을 수 없습니다.', 404);
      if (depth >= MAX_FOLDER_DEPTH) throw new UserError(`폴더는 ${MAX_FOLDER_DEPTH}단계까지 만들 수 있습니다.`);
    }
    const folder: Folder = {
      id: 'f' + randomBytes(9).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, 'x').slice(0, 11),
      name: FolderStore.cleanName(name),
      parentId,
      owner,
      grants: [],
      createdAt: new Date().toISOString(),
    };
    this.folders.push(folder);
    await this.save();
    return folder;
  }

  async update(id: string, patch: { name?: string; grants?: Grant[] }): Promise<Folder> {
    await this.load();
    const f = this.folders.find((x) => x.id === id);
    if (!f) throw new UserError('폴더를 찾을 수 없습니다.', 404);
    if (patch.name !== undefined) f.name = FolderStore.cleanName(patch.name);
    if (patch.grants) f.grants = patch.grants.filter((g) => !(g.type === 'user' && g.id === f.owner));
    await this.save();
    return f;
  }

  /** 폴더와 하위 폴더를 모두 지운다. 지운 폴더 id 를 돌려준다. */
  async removeTree(id: string): Promise<Set<string>> {
    await this.load();
    const gone = await this.subtree(id);
    this.folders = this.folders.filter((f) => !gone.has(f.id));
    await this.save();
    return gone;
  }
}
