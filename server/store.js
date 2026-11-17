// 파일 기반 저장소.
//   <DATA_DIR>/docs/<id>/meta.json     제목·시각·저장 상태
//   <DATA_DIR>/docs/<id>/base.bin      올린 원본(HWP/HWPX) — 모든 참여자가 같은 원본에서 출발한다
//   <DATA_DIR>/docs/<id>/ydoc.bin      동시편집 상태(Yjs)
//   <DATA_DIR>/docs/<id>/latest.hwpx   가장 최근 저장본
//   <DATA_DIR>/docs/<id>/versions/     시점별 저장본

import { mkdir, readFile, writeFile, readdir, rm, rename, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

const ID_RE = /^[a-z0-9]{12}$/;
const VERSION_RE = /^\d{8}T\d{6}Z\.hwpx$/;

export class Store {
  constructor(dataDir, { maxVersions = 30, versionIntervalMs = 5 * 60 * 1000 } = {}) {
    this.root = path.join(dataDir, 'docs');
    this.maxVersions = maxVersions;
    this.versionIntervalMs = versionIntervalMs;
  }

  static isId(id) {
    return typeof id === 'string' && ID_RE.test(id);
  }

  dir(id) {
    if (!Store.isId(id)) throw new Error('잘못된 문서 id');
    return path.join(this.root, id);
  }

  async write(file, data) {
    const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, file);
  }

  async create({ title, filename, base, ydocUpdate }) {
    const id = randomBytes(9).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, 'x').slice(0, 12);
    const dir = this.dir(id);
    await mkdir(path.join(dir, 'versions'), { recursive: true });
    const now = new Date().toISOString();
    const meta = { id, title, filename, createdAt: now, updatedAt: now, save: null };
    await this.write(path.join(dir, 'base.bin'), base);
    await this.write(path.join(dir, 'ydoc.bin'), ydocUpdate);
    await this.write(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
    return meta;
  }

  async meta(id) {
    try {
      return JSON.parse(await readFile(path.join(this.dir(id), 'meta.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  async updateMeta(id, patch) {
    const meta = await this.meta(id);
    if (!meta) return null;
    Object.assign(meta, patch);
    await this.write(path.join(this.dir(id), 'meta.json'), JSON.stringify(meta, null, 2));
    return meta;
  }

  async list() {
    let names = [];
    try {
      names = await readdir(this.root);
    } catch {
      return [];
    }
    const metas = await Promise.all(names.filter(Store.isId).map((id) => this.meta(id)));
    return metas.filter(Boolean).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  async read(id, name) {
    try {
      return new Uint8Array(await readFile(path.join(this.dir(id), name)));
    } catch {
      return null;
    }
  }

  base(id) {
    return this.read(id, 'base.bin');
  }

  ydoc(id) {
    return this.read(id, 'ydoc.bin');
  }

  latest(id) {
    return this.read(id, 'latest.hwpx');
  }

  async saveYdoc(id, update) {
    await this.write(path.join(this.dir(id), 'ydoc.bin'), update);
  }

  /** 저장본을 기록한다. 일정 간격마다 시점별 저장본도 남긴다. */
  async saveHwpx(id, bytes) {
    const dir = this.dir(id);
    await this.write(path.join(dir, 'latest.hwpx'), bytes);
    const vdir = path.join(dir, 'versions');
    await mkdir(vdir, { recursive: true });
    const names = (await readdir(vdir)).filter((n) => VERSION_RE.test(n)).sort();
    const last = names[names.length - 1];
    if (last) {
      const age = Date.now() - (await stat(path.join(vdir, last))).mtimeMs;
      if (age < this.versionIntervalMs) return;
    }
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    await this.write(path.join(vdir, `${stamp}.hwpx`), bytes);
    for (const old of names.slice(0, Math.max(0, names.length + 1 - this.maxVersions))) {
      await rm(path.join(vdir, old), { force: true });
    }
  }

  async versions(id) {
    try {
      const names = await readdir(path.join(this.dir(id), 'versions'));
      return names.filter((n) => VERSION_RE.test(n)).sort().reverse();
    } catch {
      return [];
    }
  }

  version(id, name) {
    if (!VERSION_RE.test(name)) return null;
    return this.read(id, path.join('versions', name));
  }

  async remove(id) {
    await rm(this.dir(id), { recursive: true, force: true });
  }
}
