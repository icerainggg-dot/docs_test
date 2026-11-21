// 사용자 계정과 로그인 세션.
//   <DATA_DIR>/users.json     계정 (암호는 scrypt 로 감춘 값만 저장)
//   <DATA_DIR>/sessions.json  로그인 세션 (쿠키 값의 SHA-256 만 저장)
//
// SSO 를 붙이면 외부 시스템의 사람은 source 'sso' 와 externalId 로 들어오고, 이 서버의 암호는 없다.

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import path from 'node:path';

export type UserRole = 'admin' | 'user';

export interface User {
  id: string;
  /** 로그인 아이디 (영문 소문자·숫자·._-) */
  username: string;
  /** 화면에 보이는 이름 */
  name: string;
  createdAt: string;
  /** 관리자는 조직도와 구성원을 고칠 수 있다 */
  role: UserRole;
  /** 소속 부서 */
  deptId: string | null;
  /** 직위·직급 */
  title: string;
  /** 사용 중지된 계정은 로그인할 수 없다 */
  active: boolean;
  /** 계정이 어디서 왔는지: 이 서버에서 만든 것 / 외부 시스템(SSO·인사) */
  source: 'local' | 'sso';
  /** 외부 시스템의 사람 id (사번 등) */
  externalId?: string;
}

interface StoredUser extends User {
  salt?: string;
  hash?: string;
}

interface Session {
  userId: string;
  expires: number;
}

export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
export const SESSION_DAYS = 14;

const scryptAsync = (password: string, salt: Buffer): Promise<Buffer> =>
  new Promise((resolve, reject) => scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => (e ? reject(e) : resolve(k))));

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

export class UserError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface UserPatch {
  name?: string;
  deptId?: string | null;
  title?: string;
  role?: UserRole;
  active?: boolean;
  password?: string;
  externalId?: string;
}

export class UserStore {
  private readonly usersFile: string;
  private readonly sessionsFile: string;
  private users: StoredUser[] = [];
  private sessions = new Map<string, Session>();
  private loaded: Promise<void> | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.usersFile = path.join(dataDir, 'users.json');
    this.sessionsFile = path.join(dataDir, 'sessions.json');
  }

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      await mkdir(path.dirname(this.usersFile), { recursive: true });
      try {
        this.users = JSON.parse(await readFile(this.usersFile, 'utf8')) as StoredUser[];
      } catch {
        this.users = [];
      }
      // 예전 판에서 만든 계정: 첫 계정을 관리자로
      this.users.forEach((u, i) => {
        u.role ??= i === 0 ? 'admin' : 'user';
        u.deptId ??= null;
        u.title ??= '';
        u.active ??= true;
        u.source ??= 'local';
      });
      try {
        const raw = JSON.parse(await readFile(this.sessionsFile, 'utf8')) as Record<string, Session>;
        const now = Date.now();
        for (const [k, s] of Object.entries(raw)) if (s.expires > now) this.sessions.set(k, s);
      } catch {
        /* 세션 없음 */
      }
    })();
    return this.loaded;
  }

  private async save(file: string, data: unknown): Promise<void> {
    // 쓰기를 한 줄로 세워 파일이 섞이지 않게 한다.
    const text = JSON.stringify(data, null, 2);
    this.writing = this.writing.then(async () => {
      const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
      await writeFile(tmp, text, { mode: 0o600 });
      await rename(tmp, file);
    });
    return this.writing;
  }

  private saveUsers(): Promise<void> {
    return this.save(this.usersFile, this.users);
  }

  private saveSessions(): Promise<void> {
    return this.save(this.sessionsFile, Object.fromEntries(this.sessions));
  }

  private static pub(u: StoredUser): User {
    const out: User = {
      id: u.id,
      username: u.username,
      name: u.name,
      createdAt: u.createdAt,
      role: u.role,
      deptId: u.deptId,
      title: u.title,
      active: u.active,
      source: u.source,
    };
    if (u.externalId) out.externalId = u.externalId;
    return out;
  }

  private static newId(): string {
    return 'u' + randomBytes(9).toString('base64url').replace(/[^a-zA-Z0-9]/g, 'x');
  }

  private static checkPassword(password: string): void {
    if (password.length < 8) throw new UserError('암호는 8자 이상이어야 합니다.');
    if (password.length > 200) throw new UserError('암호가 너무 깁니다.');
  }

  private static cleanName(name: string): string {
    const n = String(name ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40);
    if (!n) throw new UserError('이름을 입력하세요.');
    return n;
  }

  async count(): Promise<number> {
    await this.load();
    return this.users.length;
  }

  /** 새 계정. 이 서버의 첫 계정은 관리자가 된다. */
  async create(username: string, name: string, password: string, opts: { role?: UserRole; deptId?: string | null; title?: string } = {}): Promise<User> {
    await this.load();
    username = username.trim().toLowerCase();
    if (!USERNAME_RE.test(username)) throw new UserError('아이디는 영문 소문자·숫자·마침표·밑줄·하이픈으로 3~32자여야 합니다.');
    UserStore.checkPassword(password);
    if (this.users.some((u) => u.username === username)) throw new UserError('이미 있는 아이디입니다.', 409);
    const salt = randomBytes(16);
    const hash = await scryptAsync(password, salt);
    const user: StoredUser = {
      id: UserStore.newId(),
      username,
      name: UserStore.cleanName(name),
      createdAt: new Date().toISOString(),
      role: opts.role ?? (this.users.length === 0 ? 'admin' : 'user'),
      deptId: opts.deptId ?? null,
      title: (opts.title ?? '').trim().slice(0, 40),
      active: true,
      source: 'local',
      salt: salt.toString('base64'),
      hash: hash.toString('base64'),
    };
    this.users.push(user);
    await this.saveUsers();
    return UserStore.pub(user);
  }

  async setPassword(username: string, password: string): Promise<void> {
    await this.load();
    const u = this.users.find((x) => x.username === username.trim().toLowerCase());
    if (!u) throw new UserError('없는 아이디입니다.', 404);
    await this.update(u.id, { password });
  }

  /** 관리자가 계정을 고친다. 사용 중지·암호 변경이면 그 사람의 로그인을 모두 끊는다. */
  async update(id: string, patch: UserPatch): Promise<User> {
    await this.load();
    const u = this.users.find((x) => x.id === id);
    if (!u) throw new UserError('사람을 찾을 수 없습니다.', 404);
    let endSessions = false;
    if (patch.name !== undefined) u.name = UserStore.cleanName(patch.name);
    if (patch.deptId !== undefined) u.deptId = patch.deptId;
    if (patch.title !== undefined) u.title = String(patch.title).trim().slice(0, 40);
    if (patch.role !== undefined) u.role = patch.role === 'admin' ? 'admin' : 'user';
    if (patch.externalId !== undefined) u.externalId = patch.externalId || undefined;
    if (patch.active !== undefined && patch.active !== u.active) {
      u.active = patch.active;
      if (!u.active) endSessions = true;
    }
    if (patch.password !== undefined) {
      UserStore.checkPassword(patch.password);
      const salt = randomBytes(16);
      u.salt = salt.toString('base64');
      u.hash = (await scryptAsync(patch.password, salt)).toString('base64');
      endSessions = true;
    }
    if (endSessions) for (const [k, s] of this.sessions) if (s.userId === u.id) this.sessions.delete(k);
    await Promise.all([this.saveUsers(), endSessions ? this.saveSessions() : Promise.resolve()]);
    return UserStore.pub(u);
  }

  /**
   * 외부 시스템(인사·SSO)의 사람을 externalId 로 찾아 만들거나 고친다.
   * SSO 로그인 처리기와 조직 동기화 API 가 쓴다. 이렇게 들어온 계정은 이 서버의 암호가 없다.
   */
  async upsertExternal(p: { externalId: string; username: string; name: string; deptId: string | null; title?: string; active?: boolean }): Promise<{ user: User; created: boolean }> {
    await this.load();
    const username = p.username.trim().toLowerCase();
    let u = this.users.find((x) => x.externalId === p.externalId);
    const created = !u;
    if (!u) {
      if (!USERNAME_RE.test(username)) throw new UserError(`아이디 형식이 맞지 않습니다: ${p.username}`);
      if (this.users.some((x) => x.username === username)) throw new UserError(`이미 있는 아이디입니다: ${username}`, 409);
      u = {
        id: UserStore.newId(),
        username,
        name: UserStore.cleanName(p.name),
        createdAt: new Date().toISOString(),
        role: 'user',
        deptId: p.deptId,
        title: (p.title ?? '').trim().slice(0, 40),
        active: p.active ?? true,
        source: 'sso',
        externalId: p.externalId,
      };
      this.users.push(u);
      await this.saveUsers();
      return { user: UserStore.pub(u), created };
    }
    return { user: await this.update(u.id, { name: p.name, deptId: p.deptId, title: p.title ?? u.title, active: p.active ?? u.active }), created };
  }

  /** 아이디·암호 확인. 틀리거나 사용 중지된 계정이면 null. */
  async verify(username: string, password: string): Promise<User | null> {
    await this.load();
    const u = this.users.find((x) => x.username === username.trim().toLowerCase());
    // 없는 아이디도 같은 시간이 걸리게 한다.
    const salt = u?.salt ? Buffer.from(u.salt, 'base64') : randomBytes(16);
    const hash = await scryptAsync(password, salt);
    if (!u || !u.hash || !u.active) return null;
    const want = Buffer.from(u.hash, 'base64');
    return want.length === hash.length && timingSafeEqual(want, hash) ? UserStore.pub(u) : null;
  }

  async get(id: string): Promise<User | null> {
    await this.load();
    const u = this.users.find((x) => x.id === id);
    return u ? UserStore.pub(u) : null;
  }

  async getMany(ids: string[]): Promise<User[]> {
    await this.load();
    const set = new Set(ids);
    return this.users.filter((u) => set.has(u.id)).map(UserStore.pub);
  }

  async list(): Promise<User[]> {
    await this.load();
    return this.users.map(UserStore.pub);
  }

  /** 아이디나 이름에 q 가 들어간, 사용 중인 사람 */
  async search(q: string, limit = 20): Promise<User[]> {
    await this.load();
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    return this.users
      .filter((u) => u.active && (u.username.includes(needle) || u.name.toLowerCase().includes(needle)))
      .slice(0, limit)
      .map(UserStore.pub);
  }

  /** 새 세션을 만들고 쿠키에 넣을 값을 돌려준다. */
  async startSession(userId: string): Promise<string> {
    await this.load();
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(sha(token), { userId, expires: Date.now() + SESSION_DAYS * 86400_000 });
    await this.saveSessions();
    return token;
  }

  async endSession(token: string): Promise<void> {
    await this.load();
    if (this.sessions.delete(sha(token))) await this.saveSessions();
  }

  async userForToken(token: string | undefined): Promise<User | null> {
    if (!token) return null;
    await this.load();
    const s = this.sessions.get(sha(token));
    if (!s) return null;
    if (s.expires < Date.now()) {
      this.sessions.delete(sha(token));
      return null;
    }
    const u = await this.get(s.userId);
    return u?.active ? u : null;
  }
}
