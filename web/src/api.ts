// 서버 API 와 화면 도우미

/** 서버의 문서 정보 (server/store.ts 의 DocMeta 와 같은 모양) */
export interface DocMeta {
  id: string;
  title: string;
  filename: string;
  createdAt: string;
  updatedAt: string;
  save: { at: string; ok: boolean; diffs: number; error?: string; webdav: string | null } | null;
}

export interface DocInfo extends DocMeta {
  versions: string[];
}

async function json<T>(res: Response): Promise<T> {
  if (res.ok) return (res.status === 204 ? null : await res.json()) as T;
  let message = `요청 실패 (${res.status})`;
  try {
    message = ((await res.json()) as { error?: string }).error || message;
  } catch {
    /* 그대로 */
  }
  throw new Error(message);
}

export const api = {
  list: (): Promise<DocMeta[]> => fetch('/api/docs').then((r) => json<DocMeta[]>(r)),
  get: (id: string): Promise<DocInfo> => fetch(`/api/docs/${id}`).then((r) => json<DocInfo>(r)),
  create: (file: File | null): Promise<DocMeta> =>
    fetch(`/api/docs?filename=${encodeURIComponent(file?.name || '')}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file || new Uint8Array(),
    }).then((r) => json<DocMeta>(r)),
  rename: (id: string, title: string): Promise<DocMeta> =>
    fetch(`/api/docs/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    }).then((r) => json<DocMeta>(r)),
  remove: (id: string): Promise<null> => fetch(`/api/docs/${id}`, { method: 'DELETE' }).then((r) => json<null>(r)),
  base: async (id: string): Promise<Uint8Array> => {
    const res = await fetch(`/api/docs/${id}/base`);
    if (!res.ok) throw new Error('원본 문서를 받지 못했습니다.');
    return new Uint8Array(await res.arrayBuffer());
  },
  exportUrl: (id: string): string => `/api/docs/${id}/export`,
  versionUrl: (id: string, name: string): string => `/api/docs/${id}/versions/${name}`,
};

const COLORS = ['#d9480f', '#1971c2', '#2f9e44', '#9c36b5', '#e8590c', '#0c8599', '#c2255c', '#5f3dc4'];

export function getUser(): { name: string; color: string; named: boolean } {
  let name = '';
  let color = '';
  try {
    name = localStorage.getItem('hwpx-coedit:name') || '';
    color = localStorage.getItem('hwpx-coedit:color') || '';
  } catch {
    /* 저장소를 못 쓰는 환경 */
  }
  if (!color) {
    color = COLORS[Math.floor(Math.random() * COLORS.length)] ?? '#1971c2';
    try {
      localStorage.setItem('hwpx-coedit:color', color);
    } catch {
      /* 무시 */
    }
  }
  return { name: name || '익명', color, named: Boolean(name) };
}

export function setUserName(name: string): void {
  try {
    localStorage.setItem('hwpx-coedit:name', name.trim().slice(0, 30));
  } catch {
    /* 무시 */
  }
}

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
