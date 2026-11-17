async function json(res) {
  if (res.ok) return res.status === 204 ? null : res.json();
  let message = `요청 실패 (${res.status})`;
  try {
    message = (await res.json()).error || message;
  } catch {
    /* 그대로 */
  }
  throw new Error(message);
}

export const api = {
  list: () => fetch('/api/docs').then(json),
  get: (id) => fetch(`/api/docs/${id}`).then(json),
  create: (file) =>
    fetch(`/api/docs?filename=${encodeURIComponent(file?.name || '')}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: file || new Uint8Array(),
    }).then(json),
  rename: (id, title) =>
    fetch(`/api/docs/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    }).then(json),
  remove: (id) => fetch(`/api/docs/${id}`, { method: 'DELETE' }).then(json),
  base: async (id) => {
    const res = await fetch(`/api/docs/${id}/base`);
    if (!res.ok) throw new Error('원본 문서를 받지 못했습니다.');
    return new Uint8Array(await res.arrayBuffer());
  },
  exportUrl: (id) => `/api/docs/${id}/export`,
  versionUrl: (id, name) => `/api/docs/${id}/versions/${name}`,
};

const COLORS = ['#d9480f', '#1971c2', '#2f9e44', '#9c36b5', '#e8590c', '#0c8599', '#c2255c', '#5f3dc4'];

export function getUser() {
  let name = '';
  let color = '';
  try {
    name = localStorage.getItem('hwpx-coedit:name') || '';
    color = localStorage.getItem('hwpx-coedit:color') || '';
  } catch {
    /* 저장소를 못 쓰는 환경 */
  }
  if (!color) {
    color = COLORS[Math.floor(Math.random() * COLORS.length)];
    try {
      localStorage.setItem('hwpx-coedit:color', color);
    } catch {
      /* 무시 */
    }
  }
  return { name: name || '익명', color, named: Boolean(name) };
}

export function setUserName(name) {
  try {
    localStorage.setItem('hwpx-coedit:name', name.trim().slice(0, 30));
  } catch {
    /* 무시 */
  }
}

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}
