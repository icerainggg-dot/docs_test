// 서버 API 와 화면 도우미

export type DocKind = 'hwpx' | 'xlsx';

export interface Person {
  id: string;
  username: string;
  name: string;
}

/** 서버의 문서 정보 */
export interface DocMeta {
  id: string;
  kind: DocKind;
  title: string;
  filename: string;
  owner: string;
  editors: string[];
  createdAt: string;
  updatedAt: string;
  save: { at: string; ok: boolean; diffs: number; error?: string; webdav: string | null } | null;
  /** 나의 권한 */
  role: 'owner' | 'editor';
  ownerUser: Person | null;
  editorUsers: Person[];
}

export interface DocInfo extends DocMeta {
  versions: string[];
}

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function json<T>(res: Response): Promise<T> {
  if (res.ok) return (res.status === 204 ? null : await res.json()) as T;
  let message = `요청 실패 (${res.status})`;
  try {
    message = ((await res.json()) as { error?: string }).error || message;
  } catch {
    /* 그대로 */
  }
  if (res.status === 401 && !location.hash.startsWith('#/login')) location.hash = '#/login';
  throw new ApiError(message, res.status);
}

const send = (url: string, method: string, body?: unknown): Promise<Response> =>
  fetch(url, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

export const api = {
  me: async (): Promise<{ user: Person | null; signup: boolean }> => {
    const res = await fetch('/api/auth/me');
    const data = (await res.json()) as { user?: Person; signup: boolean };
    return { user: res.ok ? (data.user ?? null) : null, signup: data.signup };
  },
  login: (username: string, password: string): Promise<{ user: Person }> =>
    send('/api/auth/login', 'POST', { username, password }).then((r) => json<{ user: Person }>(r)),
  signup: (username: string, name: string, password: string): Promise<{ user: Person }> =>
    send('/api/auth/signup', 'POST', { username, name, password }).then((r) => json<{ user: Person }>(r)),
  logout: (): Promise<Response> => send('/api/auth/logout', 'POST'),
  searchUsers: (q: string): Promise<Person[]> => fetch(`/api/users?q=${encodeURIComponent(q)}`).then((r) => json<Person[]>(r)),

  list: (): Promise<DocMeta[]> => fetch('/api/docs').then((r) => json<DocMeta[]>(r)),
  get: (id: string): Promise<DocInfo> => fetch(`/api/docs/${id}`).then((r) => json<DocInfo>(r)),
  create: (file: File | null, kind: DocKind = 'hwpx'): Promise<DocMeta> =>
    fetch(`/api/docs?filename=${encodeURIComponent(file?.name || '')}&kind=${kind}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file || new Uint8Array(),
    }).then((r) => json<DocMeta>(r)),
  rename: (id: string, title: string): Promise<DocMeta> => send(`/api/docs/${id}`, 'PATCH', { title }).then((r) => json<DocMeta>(r)),
  setEditors: (id: string, userIds: string[]): Promise<DocMeta> =>
    send(`/api/docs/${id}/editors`, 'PUT', { userIds }).then((r) => json<DocMeta>(r)),
  remove: (id: string): Promise<null> => send(`/api/docs/${id}`, 'DELETE').then((r) => json<null>(r)),
  base: async (id: string): Promise<Uint8Array> => {
    const res = await fetch(`/api/docs/${id}/base`);
    if (!res.ok) throw new ApiError('원본 문서를 받지 못했습니다.', res.status);
    return new Uint8Array(await res.arrayBuffer());
  },
  model: <T>(id: string): Promise<T> => fetch(`/api/docs/${id}/model`).then((r) => json<T>(r)),
  exportUrl: (id: string): string => `/api/docs/${id}/export`,
  versionUrl: (id: string, name: string): string => `/api/docs/${id}/versions/${name}`,
};

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

type AttrValue = string | boolean | null | undefined | ((e: Event) => void);
type Child = Node | string | number | null | undefined | false;

/** 작은 DOM 만들기 도우미. on* 속성은 이벤트 처리기로 붙는다. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, AttrValue> = {},
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = String(v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
  return el;
}
