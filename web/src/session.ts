// 로그인한 사람

import type { Me } from './api.ts';

let current: Me | null = null;

export const session = {
  get user(): Me | null {
    return current;
  },
  set(user: Me | null): void {
    current = user;
  },
};

const COLORS = ['#d9480f', '#1971c2', '#2f9e44', '#9c36b5', '#e8590c', '#0c8599', '#c2255c', '#5f3dc4'];

/** 사람마다 늘 같은 색 */
export function colorFor(id: string): string {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length]!;
}
