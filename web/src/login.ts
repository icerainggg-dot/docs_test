// 로그인·가입 화면

import { api, h, errorMessage } from './api.ts';
import { session } from './session.ts';

export async function showLogin(root: HTMLElement): Promise<() => void> {
  document.title = '로그인 — 문서 동시편집';
  const { signup: canSignup } = await api.me();
  let mode: 'login' | 'signup' = 'login';

  const status = h('p', { class: 'status', role: 'status' });
  const username = h('input', { type: 'text', id: 'login-username', autocomplete: 'username', required: true, maxlength: '32', autocapitalize: 'off' });
  const name = h('input', { type: 'text', id: 'login-name', autocomplete: 'name', maxlength: '40' });
  const password = h('input', { type: 'password', id: 'login-password', autocomplete: 'current-password', required: true, minlength: '8' });
  const nameRow = h('div', { class: 'field', hidden: true }, h('label', { for: 'login-name' }, '이름 (다른 사람에게 보입니다)'), name);
  const submit = h('button', { class: 'btn primary', type: 'submit' }, '로그인');
  const title = h('h1', {}, '로그인');
  const toggle = h('button', { type: 'button', class: 'linklike', hidden: !canSignup }, '계정이 없으면 가입하기');

  const setMode = (m: typeof mode): void => {
    mode = m;
    const su = m === 'signup';
    title.textContent = su ? '가입하기' : '로그인';
    submit.textContent = su ? '가입하고 시작' : '로그인';
    nameRow.hidden = !su;
    name.required = su;
    password.autocomplete = su ? 'new-password' : 'current-password';
    toggle.textContent = su ? '이미 계정이 있으면 로그인' : '계정이 없으면 가입하기';
    status.textContent = '';
  };
  toggle.addEventListener('click', () => setMode(mode === 'login' ? 'signup' : 'login'));

  const form = h(
    'form',
    { class: 'card login-form' },
    title,
    h('div', { class: 'field' }, h('label', { for: 'login-username' }, '아이디'), username),
    nameRow,
    h('div', { class: 'field' }, h('label', { for: 'login-password' }, '암호 (8자 이상)'), password),
    submit,
    toggle,
    canSignup ? null : h('p', { class: 'hint' }, '계정은 관리자에게 요청하세요.'),
    status,
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    submit.disabled = true;
    status.textContent = '';
    try {
      const { user } =
        mode === 'signup'
          ? await api.signup(username.value, name.value, password.value)
          : await api.login(username.value, password.value);
      session.set(user);
      location.hash = '#/';
    } catch (err) {
      status.textContent = errorMessage(err);
    } finally {
      submit.disabled = false;
    }
  });

  root.append(h('main', { class: 'login' }, h('p', { class: 'brand' }, '문서 동시편집'), form));
  username.focus();
  return () => {};
}
