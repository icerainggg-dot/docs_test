import { showHome } from './home.js';
import { showDoc } from './docpage.js';

const app = document.getElementById('app');
let cleanup = null;

async function route() {
  if (cleanup) {
    cleanup();
    cleanup = null;
  }
  app.replaceChildren();
  const m = /^#\/d\/([a-z0-9]{12})$/.exec(location.hash);
  cleanup = m ? await showDoc(app, m[1]) : await showHome(app);
}

window.addEventListener('hashchange', route);
route();
