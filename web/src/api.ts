// 서버 API 와 화면 도우미

export type DocKind = 'hwpx' | 'xlsx';

export interface Person {
  id: string;
  username: string;
  name: string;
  title?: string;
  /** 부서 경로 (예: 기획조정실 > 정보화담당관) */
  dept?: string;
}

/** 로그인한 사람 */
export interface Me extends Person {
  role: 'admin' | 'user';
  deptId: string | null;
}

export type GrantRole = 'edit' | 'view';
export type Role = 'owner' | GrantRole;

/** 사람이나 부서에 준 권한 */
export interface Grant {
  type: 'user' | 'dept';
  id: string;
  role: GrantRole;
}

export interface GrantView extends Grant {
  name: string;
  /** 아이디 또는 부서 경로 */
  sub: string;
  active?: boolean;
}

export interface Department {
  id: string;
  name: string;
  parentId: string | null;
  order: number;
  externalId?: string;
}

export interface AdminUser {
  id: string;
  username: string;
  name: string;
  title: string;
  deptId: string | null;
  role: 'admin' | 'user';
  active: boolean;
  source: 'local' | 'sso';
  externalId: string | null;
}

/** 서버의 문서 정보 */
export interface DocMeta {
  id: string;
  kind: DocKind;
  title: string;
  filename: string;
  owner: string;
  folderId: string | null;
  createdAt: string;
  updatedAt: string;
  save: { at: string; ok: boolean; diffs: number; error?: string; webdav: string | null } | null;
  /** 나의 권한: 올린 사람 / 편집 / 보기 */
  role: Role;
  ownerUser: Person | null;
  shares: GrantView[];
  folder: { id: string; name: string } | null;
  /** 폴더 경로 (맨 위부터) */
  path: { id: string; name: string }[];
}

/** 업무 폴더 */
export interface FolderInfo {
  id: string;
  name: string;
  parentId: string | null;
  depth: number;
  canAddChild: boolean;
  owner: string;
  /** owner: 이 폴더나 상위 폴더를 만든 사람 (권한을 정할 수 있음) */
  role: Role;
  ownerUser: Person | null;
  grants: GrantView[];
  path: { id: string; name: string }[];
  docCount: number;
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
  me: async (): Promise<{ user: Me | null; signup: boolean }> => {
    const res = await fetch('/api/auth/me');
    const data = (await res.json()) as { user?: Me; signup: boolean };
    return { user: res.ok ? (data.user ?? null) : null, signup: data.signup };
  },
  login: (username: string, password: string): Promise<{ user: Me }> =>
    send('/api/auth/login', 'POST', { username, password }).then((r) => json<{ user: Me }>(r)),
  signup: (username: string, name: string, password: string): Promise<{ user: Me }> =>
    send('/api/auth/signup', 'POST', { username, name, password }).then((r) => json<{ user: Me }>(r)),
  logout: (): Promise<Response> => send('/api/auth/logout', 'POST'),
  /** 권한 줄 사람·부서 찾기 */
  people: (q: string): Promise<{ users: Person[]; depts: { id: string; name: string; path: string }[] }> =>
    fetch(`/api/people?q=${encodeURIComponent(q)}`).then((r) => json(r)),

  /** folder: 폴더 id, 'none'(폴더 밖), 없으면 전체 */
  list: (folder?: string): Promise<DocMeta[]> =>
    fetch(folder ? `/api/docs?folder=${encodeURIComponent(folder)}` : '/api/docs').then((r) => json<DocMeta[]>(r)),
  get: (id: string): Promise<DocInfo> => fetch(`/api/docs/${id}`).then((r) => json<DocInfo>(r)),
  create: (file: File | null, kind: DocKind = 'hwpx', folderId?: string | null): Promise<DocMeta> =>
    fetch(`/api/docs?filename=${encodeURIComponent(file?.name || '')}&kind=${kind}${folderId ? `&folder=${folderId}` : ''}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file || new Uint8Array(),
    }).then((r) => json<DocMeta>(r)),
  rename: (id: string, title: string): Promise<DocMeta> => send(`/api/docs/${id}`, 'PATCH', { title }).then((r) => json<DocMeta>(r)),
  setShares: (id: string, grants: Grant[]): Promise<DocMeta> => send(`/api/docs/${id}/shares`, 'PUT', { grants }).then((r) => json<DocMeta>(r)),
  remove: (id: string): Promise<null> => send(`/api/docs/${id}`, 'DELETE').then((r) => json<null>(r)),
  moveToFolder: (id: string, folderId: string | null): Promise<DocMeta> =>
    send(`/api/docs/${id}/folder`, 'PUT', { folderId }).then((r) => json<DocMeta>(r)),

  folders: (): Promise<FolderInfo[]> => fetch('/api/folders').then((r) => json<FolderInfo[]>(r)),
  createFolder: (name: string, parentId: string | null = null): Promise<FolderInfo> =>
    send('/api/folders', 'POST', { name, parentId }).then((r) => json<FolderInfo>(r)),
  renameFolder: (id: string, name: string): Promise<FolderInfo> => send(`/api/folders/${id}`, 'PATCH', { name }).then((r) => json<FolderInfo>(r)),
  setFolderGrants: (id: string, grants: Grant[]): Promise<FolderInfo> =>
    send(`/api/folders/${id}/grants`, 'PUT', { grants }).then((r) => json<FolderInfo>(r)),
  org: (): Promise<Department[]> => fetch('/api/org').then((r) => json<Department[]>(r)),
  removeFolder: (id: string): Promise<null> => send(`/api/folders/${id}`, 'DELETE').then((r) => json<null>(r)),
  base: async (id: string): Promise<Uint8Array> => {
    const res = await fetch(`/api/docs/${id}/base`);
    if (!res.ok) throw new ApiError('원본 문서를 받지 못했습니다.', res.status);
    return new Uint8Array(await res.arrayBuffer());
  },
  model: <T>(id: string): Promise<T> => fetch(`/api/docs/${id}/model`).then((r) => json<T>(r)),
  exportUrl: (id: string): string => `/api/docs/${id}/export`,

  admin: {
    users: (): Promise<AdminUser[]> => fetch('/api/admin/users').then((r) => json<AdminUser[]>(r)),
    createUser: (u: { username: string; name: string; password: string; deptId: string | null; title: string; role: 'admin' | 'user' }): Promise<AdminUser> =>
      send('/api/admin/users', 'POST', u).then((r) => json<AdminUser>(r)),
    updateUser: (id: string, patch: Partial<Omit<AdminUser, 'id' | 'username' | 'source'>> & { password?: string }): Promise<AdminUser> =>
      send(`/api/admin/users/${id}`, 'PATCH', patch).then((r) => json<AdminUser>(r)),
    org: (): Promise<Department[]> => fetch('/api/admin/org').then((r) => json<Department[]>(r)),
    createDept: (name: string, parentId: string | null): Promise<Department> =>
      send('/api/admin/org', 'POST', { name, parentId }).then((r) => json<Department>(r)),
    updateDept: (id: string, patch: { name?: string; parentId?: string | null; order?: number; externalId?: string }): Promise<Department> =>
      send(`/api/admin/org/${id}`, 'PATCH', patch).then((r) => json<Department>(r)),
    removeDept: (id: string): Promise<null> => send(`/api/admin/org/${id}`, 'DELETE').then((r) => json<null>(r)),
    sync: (payload: unknown): Promise<Record<string, unknown>> => send('/api/admin/sync', 'POST', payload).then((r) => json<Record<string, unknown>>(r)),
  },
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
