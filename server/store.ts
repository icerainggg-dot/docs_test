// 파일 기반 저장소.
//   <DATA_DIR>/docs/<id>/meta.json     제목·종류·소유자·편집자·시각·저장 상태
//   <DATA_DIR>/docs/<id>/base.bin      올린 원본(HWP/HWPX/XLSX) — 모든 참여자가 같은 원본에서 출발한다
//   <DATA_DIR>/docs/<id>/model.json    XLSX 의 해석 결과 (화면 표시·계산용)
//   <DATA_DIR>/docs/<id>/ydoc.bin      동시편집 상태(Yjs)
//   <DATA_DIR>/docs/<id>/latest.<ext>  가장 최근 저장본
//   <DATA_DIR>/docs/<id>/versions/     시점별 저장본

import { mkdir, readFile, writeFile, readdir, rm, rename, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

const ID_RE = /^[a-z0-9]{12}$/;
const VERSION_RE = /^\d{8}T\d{6}Z\.(hwpx|xlsx)$/;

export type DocKind = 'hwpx' | 'xlsx';

/** 마지막 저장 결과 */
export interface SaveStatus {
  at: string;
  ok: boolean;
  /** 저장 검사에서 나온 불일치 수 */
  diffs: number;
  error?: string;
  /** WebDAV 에 올린 주소, 또는 실패 메시지 */
  webdav: string | null;
}

export interface DocMeta {
  id: string;
  kind: DocKind;
  title: string;
  /** 올린 사람 (권한을 줄 수 있는 사람) */
  owner: string;
  /** 동시편집 권한을 받은 사람들 */
  editors: string[];
  /** 들어 있는 업무 폴더 (없으면 null) */
  folderId: string | null;
  filename: string;
  createdAt: string;
  updatedAt: string;
  save: SaveStatus | null;
}

export interface StoreOptions {
  maxVersions?: number;
  versionIntervalMs?: number;
}

export class Store {
  readonly root: string;
  readonly maxVersions: number;
  readonly versionIntervalMs: number;

  constructor(dataDir: string, { maxVersions = 30, versionIntervalMs = 5 * 60 * 1000 }: StoreOptions = {}) {
    this.root = path.join(dataDir, 'docs');
    this.maxVersions = maxVersions;
    this.versionIntervalMs = versionIntervalMs;
  }

  static isId(id: unknown): id is string {
    return typeof id === 'string' && ID_RE.test(id);
  }

  dir(id: string): string {
    if (!Store.isId(id)) throw new Error('잘못된 문서 id');
    return path.join(this.root, id);
  }

  private async write(file: string, data: Uint8Array | string): Promise<void> {
    const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, file);
  }

  async create(input: {
    kind: DocKind;
    title: string;
    filename: string;
    owner: string;
    folderId?: string | null;
    base: Uint8Array;
    ydocUpdate: Uint8Array;
    model?: unknown;
  }): Promise<DocMeta> {
    const id = randomBytes(9).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, 'x').slice(0, 12);
    const dir = this.dir(id);
    await mkdir(path.join(dir, 'versions'), { recursive: true });
    const now = new Date().toISOString();
    const meta: DocMeta = {
      id,
      kind: input.kind,
      title: input.title,
      owner: input.owner,
      editors: [],
      folderId: input.folderId ?? null,
      filename: input.filename,
      createdAt: now,
      updatedAt: now,
      save: null,
    };
    await this.write(path.join(dir, 'base.bin'), input.base);
    if (input.model !== undefined) await this.write(path.join(dir, 'model.json'), JSON.stringify(input.model));
    await this.write(path.join(dir, 'ydoc.bin'), input.ydocUpdate);
    await this.write(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
    return meta;
  }

  async meta(id: string): Promise<DocMeta | null> {
    try {
      const meta = JSON.parse(await readFile(path.join(this.dir(id), 'meta.json'), 'utf8')) as DocMeta;
      meta.kind ??= 'hwpx'; // 예전 판에서 만든 문서
      meta.editors ??= [];
      meta.folderId ??= null;
      return meta;
    } catch {
      return null;
    }
  }

  async updateMeta(id: string, patch: Partial<Omit<DocMeta, 'id'>>): Promise<DocMeta | null> {
    const meta = await this.meta(id);
    if (!meta) return null;
    Object.assign(meta, patch);
    await this.write(path.join(this.dir(id), 'meta.json'), JSON.stringify(meta, null, 2));
    return meta;
  }

  async list(): Promise<DocMeta[]> {
    let names: string[] = [];
    try {
      names = await readdir(this.root);
    } catch {
      return [];
    }
    const metas = await Promise.all(names.filter((n) => Store.isId(n)).map((id) => this.meta(id)));
    return metas.filter((m): m is DocMeta => m !== null).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  private async read(id: string, name: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(path.join(this.dir(id), name)));
    } catch {
      return null;
    }
  }

  base(id: string): Promise<Uint8Array | null> {
    return this.read(id, 'base.bin');
  }

  ydoc(id: string): Promise<Uint8Array | null> {
    return this.read(id, 'ydoc.bin');
  }

  /** XLSX 해석 결과 (JSON 문자열 그대로) */
  async modelJson(id: string): Promise<string | null> {
    try {
      return await readFile(path.join(this.dir(id), 'model.json'), 'utf8');
    } catch {
      return null;
    }
  }

  async saveYdoc(id: string, update: Uint8Array): Promise<void> {
    await this.write(path.join(this.dir(id), 'ydoc.bin'), update);
  }

  /** 저장본을 기록한다. 일정 간격마다 시점별 저장본도 남긴다. */
  async saveFile(id: string, kind: DocKind, bytes: Uint8Array): Promise<void> {
    const dir = this.dir(id);
    await this.write(path.join(dir, `latest.${kind}`), bytes);
    const vdir = path.join(dir, 'versions');
    await mkdir(vdir, { recursive: true });
    const names = (await readdir(vdir)).filter((n) => VERSION_RE.test(n)).sort();
    const last = names[names.length - 1];
    if (last) {
      const age = Date.now() - (await stat(path.join(vdir, last))).mtimeMs;
      if (age < this.versionIntervalMs) return;
    }
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    await this.write(path.join(vdir, `${stamp}.${kind}`), bytes);
    for (const old of names.slice(0, Math.max(0, names.length + 1 - this.maxVersions))) {
      await rm(path.join(vdir, old), { force: true });
    }
  }

  async versions(id: string): Promise<string[]> {
    try {
      const names = await readdir(path.join(this.dir(id), 'versions'));
      return names.filter((n) => VERSION_RE.test(n)).sort().reverse();
    } catch {
      return [];
    }
  }

  version(id: string, name: string): Promise<Uint8Array | null> {
    if (!VERSION_RE.test(name)) return Promise.resolve(null);
    return this.read(id, path.join('versions', name));
  }

  async remove(id: string): Promise<void> {
    await rm(this.dir(id), { recursive: true, force: true });
  }
}
