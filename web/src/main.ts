import { api } from './api.ts';
import { session } from './session.ts';
import { showLogin } from './login.ts';
import { showHome } from './home.ts';
import { showDoc } from './docpage.ts';
import { showSheet } from './sheet/sheetpage.ts';

const app = document.getElementById('app');
if (!app) throw new Error('#app 이 없습니다.');
let cleanup: (() => void) | null = null;

async function route(root: HTMLElement): Promise<void> {
  cleanup?.();
  cleanup = null;
  root.replaceChildren();
  if (!session.user && !location.hash.startsWith('#/login')) {
    const { user } = await api.me();
    if (!user) {
      location.hash = '#/login';
      return;
    }
    session.set(user);
  }
  if (location.hash.startsWith('#/login')) {
    cleanup = await showLogin(root);
    return;
  }
  const m = /^#\/d\/([a-z0-9]{12})$/.exec(location.hash);
  if (!m?.[1]) {
    cleanup = await showHome(root);
    return;
  }
  const id = m[1];
  try {
    const meta = await api.get(id);
    cleanup = meta.kind === 'xlsx' ? await showSheet(root, meta) : await showDoc(root, meta);
  } catch {
    location.hash = '#/';
  }
}

window.addEventListener('hashchange', () => void route(app));
void route(app);
