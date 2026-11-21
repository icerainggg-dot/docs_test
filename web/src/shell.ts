// 두 편집 화면(HWPX·XLSX)이 함께 쓰는 부분: 실시간 연결, 제목, 공유, 접속·저장 상태

import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { api, h, errorMessage } from './api.ts';
import type { DocMeta } from './api.ts';
import { openShareDialog } from './share.ts';

const fmtClock = (iso: string): string =>
  new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export interface Collab {
  ydoc: Y.Doc;
  provider: HocuspocusProvider;
  /** 처음 동기화 결과 */
  ready: Promise<'synced' | 'denied' | 'timeout'>;
  /** 권한을 잃었을 때 */
  onDenied(fn: () => void): void;
}

/** 실시간 연결. 로그인 쿠키로 서버가 권한을 확인한다. */
export function connectCollab(id: string): Collab {
  const ydoc = new Y.Doc();
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const provider = new HocuspocusProvider({ url: `${proto}://${location.host}/collab`, name: id, document: ydoc, token: 'cookie' });
  const denied = new Set<() => void>();
  let wasDenied = false;
  const deny = (): void => {
    if (wasDenied) return;
    wasDenied = true;
    for (const fn of denied) fn();
  };
  provider.on('authenticationFailed', deny);
  provider.on('close', ({ event }: { event: { reason?: string } }) => {
    if (event?.reason === 'Forbidden') deny();
    // 편집↔보기 권한이 바뀌면 새 권한으로 다시 연다.
    if (event?.reason === 'RoleChanged') location.reload();
  });
  const ready = new Promise<'synced' | 'denied' | 'timeout'>((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 15000);
    provider.on('synced', () => {
      clearTimeout(timer);
      resolve('synced');
    });
    denied.add(() => {
      clearTimeout(timer);
      resolve('denied');
    });
  });
  return { ydoc, provider, ready, onDenied: (fn) => denied.add(fn) };
}

/** 권한을 잃으면 화면을 막는다. */
export function denyOverlay(root: HTMLElement): void {
  root.append(
    h(
      'div',
      { class: 'blocker', role: 'alertdialog', 'aria-label': '편집 권한 없음' },
      h('div', { class: 'card' }, h('p', {}, '이 문서를 편집할 권한이 없습니다.'), h('a', { class: 'btn primary', href: '#/' }, '문서 목록으로')),
    ),
  );
}

export function flasher(): { el: HTMLElement; flash(text: string): void } {
  const el = h('div', { class: 'flash', role: 'status' });
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    el,
    flash(text) {
      el.textContent = text;
      el.classList.add('show');
      clearTimeout(timer);
      timer = setTimeout(() => el.classList.remove('show'), 2500);
    },
  };
}

/** 제목 입력란 (올린 사람만 바꿀 수 있다) */
export function titleField(meta: DocMeta, flash: (t: string) => void, suffix: string): HTMLInputElement {
  const input = h('input', { class: 'title', value: meta.title, 'aria-label': '문서 제목', readonly: meta.role !== 'owner' });
  input.addEventListener('change', async () => {
    try {
      const m = await api.rename(meta.id, input.value);
      meta.title = m.title;
      document.title = `${m.title} — ${suffix}`;
    } catch (e) {
      flash(errorMessage(e));
      input.value = meta.title;
    }
  });
  return input;
}

export function shareButton(meta: DocMeta): HTMLButtonElement {
  return h(
    'button',
    { class: 'btn small', type: 'button', onclick: () => openShareDialog(meta, (m) => Object.assign(meta, m)) },
    meta.role === 'owner' ? '공유' : '권한',
  );
}

/** 보기 권한일 때 도구 모음에 붙이는 표시 */
export function readOnlyBadge(meta: DocMeta): HTMLElement | null {
  return meta.role === 'view' ? h('span', { class: 'ro', title: '보기 권한으로 열었습니다. 고칠 수 없습니다.' }, '보기 전용') : null;
}

export interface PeerView {
  me: boolean;
  user: { name: string; color: string };
}

/** 동그라미에 넣을 글자: 세 글자 한글 이름은 이름(뒤 두 글자), 그 밖에는 앞 두 글자 */
export function initials(name: string): string {
  return /^[가-힣]{3}$/.test(name) ? name.slice(1) : name.slice(0, 2);
}

export function peerAvatars(el: HTMLElement, peers: PeerView[]): void {
  el.replaceChildren(
    ...peers.map((p) =>
      h(
        'span',
        { class: 'peer', style: `--c:${p.user.color}`, title: p.me ? `${p.user.name} (나)` : p.user.name },
        initials(p.user.name || '익명'),
      ),
    ),
  );
}

/** 접속 상태와 저장 상태 표시. 정리 함수를 돌려준다. */
export function statusWidgets(id: string, provider: HocuspocusProvider): { conn: HTMLElement; save: HTMLElement; stop(): void } {
  const conn = h('span', { class: 'conn' }, '연결됨');
  const save = h('span', { class: 'save' }, '');
  provider.on('status', ({ status }: { status: string }) => {
    const ok = status === 'connected';
    conn.textContent = ok ? '연결됨' : '연결 끊김 — 다시 연결하는 중';
    conn.classList.toggle('bad', !ok);
  });
  const poll = async (): Promise<void> => {
    try {
      const m = await api.get(id);
      if (!m.save) save.textContent = '';
      else if (m.save.ok) save.textContent = `저장됨 ${fmtClock(m.save.at)}`;
      else save.textContent = m.save.error ? '저장 실패' : `저장됨 (검사 불일치 ${m.save.diffs}건)`;
      save.classList.toggle('bad', Boolean(m.save && !m.save.ok));
    } catch {
      /* 다음에 다시 */
    }
  };
  const timer = setInterval(() => void poll(), 4000);
  void poll();
  return { conn, save, stop: () => clearInterval(timer) };
}
