import { showHome } from './home.ts';
import { showDoc } from './docpage.ts';

const app = document.getElementById('app');
if (!app) throw new Error('#app 이 없습니다.');
let cleanup: (() => void) | null = null;

async function route(root: HTMLElement): Promise<void> {
  cleanup?.();
  cleanup = null;
  root.replaceChildren();
  const m = /^#\/d\/([a-z0-9]{12})$/.exec(location.hash);
  cleanup = m?.[1] ? await showDoc(root, m[1]) : await showHome(root);
}

window.addEventListener('hashchange', () => void route(app));
void route(app);
