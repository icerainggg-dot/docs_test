// 사용자 계정과 로그인 세션.
//   <DATA_DIR>/users.json     계정 (암호는 scrypt 로 감춘 값만 저장)
//   <DATA_DIR>/sessions.json  로그인 세션 (쿠키 값의 SHA-256 만 저장)

import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import path from 'node:path';

export interface User {
  id: string;
  /** 로그인 아이디 (영문 소문자·숫자·._-) */
  username: string;
  /** 화면에 보이는 이름 */
  name: string;
  createdAt: string;
}

interface StoredUser extends User {
  salt: string;
  hash: string;
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
    this.writing = this.writing.then(async () => {
      const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
      await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
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
    return { id: u.id, username: u.username, name: u.name, createdAt: u.createdAt };
  }

  async count(): Promise<number> {
    await this.load();
    return this.users.length;
  }

  async create(username: string, name: string, password: string): Promise<User> {
    await this.load();
    username = username.trim().toLowerCase();
    name = name.trim().slice(0, 40);
    if (!USERNAME_RE.test(username)) throw new UserError('아이디는 영문 소문자·숫자·마침표·밑줄·하이픈으로 3~32자여야 합니다.');
    if (!name) throw new UserError('이름을 입력하세요.');
    if (password.length < 8) throw new UserError('암호는 8자 이상이어야 합니다.');
    if (password.length > 200) throw new UserError('암호가 너무 깁니다.');
    if (this.users.some((u) => u.username === username)) throw new UserError('이미 있는 아이디입니다.', 409);
    const salt = randomBytes(16);
    const hash = await scryptAsync(password, salt);
    const user: StoredUser = {
      id: 'u' + randomBytes(9).toString('base64url').replace(/[^a-zA-Z0-9]/g, 'x'),
      username,
      name,
      createdAt: new Date().toISOString(),
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
    if (password.length < 8) throw new UserError('암호는 8자 이상이어야 합니다.');
    const salt = randomBytes(16);
    u.salt = salt.toString('base64');
    u.hash = (await scryptAsync(password, salt)).toString('base64');
    // 암호를 바꾸면 그 사람의 모든 세션을 끝낸다.
    for (const [k, s] of this.sessions) if (s.userId === u.id) this.sessions.delete(k);
    await Promise.all([this.saveUsers(), this.saveSessions()]);
  }

  /** 아이디·암호 확인. 틀리면 null. */
  async verify(username: string, password: string): Promise<User | null> {
    await this.load();
    const u = this.users.find((x) => x.username === username.trim().toLowerCase());
    // 없는 아이디도 같은 시간이 걸리게 한다.
    const salt = u ? Buffer.from(u.salt, 'base64') : randomBytes(16);
    const hash = await scryptAsync(password, salt);
    if (!u) return null;
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

  /** 아이디나 이름에 q 가 들어간 사람 */
  async search(q: string, limit = 20): Promise<User[]> {
    await this.load();
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    return this.users
      .filter((u) => u.username.includes(needle) || u.name.toLowerCase().includes(needle))
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
    return this.get(s.userId);
  }
}
