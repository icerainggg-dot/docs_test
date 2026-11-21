// 업무(프로젝트) 폴더.
//   <DATA_DIR>/folders.json
// 폴더를 만든 사람이 구성원을 정하고, 구성원은 폴더 안의 문서를 모두 열고 고칠 수 있다.

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { UserError } from './users.ts';

export interface Folder {
  id: string;
  name: string;
  /** 만든 사람 (구성원을 정할 수 있는 사람) */
  owner: string;
  members: string[];
  createdAt: string;
}

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
        this.folders = JSON.parse(await readFile(this.file, 'utf8')) as Folder[];
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

  static isMember(folder: Folder, userId: string): boolean {
    return folder.owner === userId || folder.members.includes(userId);
  }

  private static cleanName(name: string): string {
    const n = name.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60);
    if (!n) throw new UserError('폴더 이름을 입력하세요.');
    return n;
  }

  async create(name: string, owner: string): Promise<Folder> {
    await this.load();
    const folder: Folder = {
      id: 'f' + randomBytes(9).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, 'x').slice(0, 11),
      name: FolderStore.cleanName(name),
      owner,
      members: [],
      createdAt: new Date().toISOString(),
    };
    this.folders.push(folder);
    await this.save();
    return folder;
  }

  async get(id: string | null | undefined): Promise<Folder | null> {
    if (!FolderStore.isId(id)) return null;
    await this.load();
    return this.folders.find((f) => f.id === id) ?? null;
  }

  /** 이 사람이 구성원인 폴더 */
  async forUser(userId: string): Promise<Folder[]> {
    await this.load();
    return this.folders.filter((f) => FolderStore.isMember(f, userId)).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  }

  async update(id: string, patch: { name?: string; members?: string[] }): Promise<Folder> {
    await this.load();
    const f = this.folders.find((x) => x.id === id);
    if (!f) throw new UserError('폴더를 찾을 수 없습니다.', 404);
    if (patch.name !== undefined) f.name = FolderStore.cleanName(patch.name);
    if (patch.members) f.members = [...new Set(patch.members)].filter((m) => m !== f.owner).slice(0, 500);
    await this.save();
    return f;
  }

  async remove(id: string): Promise<void> {
    await this.load();
    this.folders = this.folders.filter((f) => f.id !== id);
    await this.save();
  }
}
