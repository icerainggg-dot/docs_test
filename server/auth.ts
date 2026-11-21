// 로그인 API 와 요청마다 사용자를 확인하는 도우미

import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import { UserStore, UserError, SESSION_DAYS } from './users.ts';
import type { User } from './users.ts';

export const COOKIE = 'hwpx_sid';

declare module 'express-serve-static-core' {
  interface Request {
    user?: User;
  }
}

export function parseCookies(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* 깨진 쿠키는 무시 */
    }
  }
  return out;
}

/** 요청이 같은 사이트에서 왔는지 (다른 사이트가 사용자 몰래 보내는 요청 막기) */
export function sameOrigin(origin: string | null | undefined, host: string | null | undefined): boolean {
  if (!origin) return true; // 브라우저가 아닌 도구
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export interface AuthOptions {
  users: UserStore;
  /** 스스로 가입할 수 있는지 */
  signup: boolean;
  /** HTTPS 에서만 쿠키를 보낸다 */
  secureCookie: boolean;
}

/** 로그인 실패 횟수 제한 (아이디+주소별, 15분에 10번) */
class Throttle {
  private readonly hits = new Map<string, { n: number; until: number }>();
  check(key: string): boolean {
    const h = this.hits.get(key);
    return !h || h.until < Date.now() || h.n < 10;
  }
  fail(key: string): void {
    const now = Date.now();
    const h = this.hits.get(key);
    if (!h || h.until < now) this.hits.set(key, { n: 1, until: now + 15 * 60_000 });
    else h.n++;
    if (this.hits.size > 10000) for (const [k, v] of this.hits) if (v.until < now) this.hits.delete(k);
  }
  clear(key: string): void {
    this.hits.delete(key);
  }
}

export function authRouter({ users, signup, secureCookie }: AuthOptions): express.Router {
  const r = express.Router();
  const throttle = new Throttle();

  const setCookie = (res: Response, token: string): void => {
    res.cookie(COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: secureCookie,
      path: '/',
      maxAge: SESSION_DAYS * 86400_000,
    });
  };

  const body = (req: Request): Record<string, string> => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(b).map(([k, v]) => [k, typeof v === 'string' ? v : '']));
  };

  r.get('/me', async (req, res) => {
    const user = await users.userForToken(parseCookies(req.headers.cookie)[COOKIE]);
    if (!user) {
      res.status(401).json({ error: '로그인이 필요합니다.', signup });
      return;
    }
    res.json({ user, signup });
  });

  r.post('/signup', express.json({ limit: '10kb' }), async (req, res, next) => {
    try {
      if (!signup) throw new UserError('가입이 닫혀 있습니다. 관리자에게 계정을 요청하세요.', 403);
      const { username = '', name = '', password = '' } = body(req);
      const user = await users.create(username, name, password);
      setCookie(res, await users.startSession(user.id));
      res.status(201).json({ user });
    } catch (e) {
      next(e);
    }
  });

  r.post('/login', express.json({ limit: '10kb' }), async (req, res, next) => {
    try {
      const { username = '', password = '' } = body(req);
      const key = `${username.trim().toLowerCase()}|${req.ip}`;
      if (!throttle.check(key)) throw new UserError('로그인 시도가 너무 많습니다. 15분 뒤에 다시 하세요.', 429);
      const user = await users.verify(username, password);
      if (!user) {
        throttle.fail(key);
        throw new UserError('아이디나 암호가 맞지 않습니다.', 401);
      }
      throttle.clear(key);
      setCookie(res, await users.startSession(user.id));
      res.json({ user });
    } catch (e) {
      next(e);
    }
  });

  r.post('/logout', async (req, res) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) await users.endSession(token);
    res.clearCookie(COOKIE, { path: '/' });
    res.status(204).end();
  });

  return r;
}

/** 로그인한 사람만 통과시킨다. */
export function requireUser(users: UserStore) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const user = await users.userForToken(parseCookies(req.headers.cookie)[COOKIE]);
      if (!user) {
        res.status(401).json({ error: '로그인이 필요합니다.' });
        return;
      }
      req.user = user;
      next();
    } catch (e) {
      next(e);
    }
  };
}

/** 값을 바꾸는 요청은 같은 사이트에서 온 것만 받는다. */
export function checkOrigin(req: Request, res: Response, next: NextFunction): void {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (!sameOrigin(req.headers.origin, req.headers.host)) {
    res.status(403).json({ error: '다른 사이트에서 온 요청은 받지 않습니다.' });
    return;
  }
  next();
}
