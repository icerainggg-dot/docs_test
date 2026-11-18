// 저장본을 WebDAV(Nextcloud 등)에 올린다. 환경변수로 켠다.
//   WEBDAV_URL       예) https://cloud.example.kr/remote.php/dav/files/hwpx-bot/공동편집
//   WEBDAV_USER, WEBDAV_PASSWORD   (Nextcloud 는 앱 암호 사용을 권장)
// 같은 경로에 덮어쓰므로 Nextcloud 의 파일 버전 기능이 이력을 관리한다.

import type { DocMeta } from './store.ts';

export function webdavFromEnv(env: NodeJS.ProcessEnv = process.env): WebDav | null {
  if (!env.WEBDAV_URL) return null;
  return new WebDav(env.WEBDAV_URL, env.WEBDAV_USER, env.WEBDAV_PASSWORD);
}

export class WebDav {
  readonly url: string;
  private readonly auth: string | null;

  constructor(url: string, user?: string, password?: string) {
    this.url = url.replace(/\/+$/, '');
    this.auth = user ? 'Basic ' + Buffer.from(`${user}:${password ?? ''}`).toString('base64') : null;
  }

  fileName(meta: Pick<DocMeta, 'id' | 'title'>): string {
    const title = (meta.title || '문서').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 80);
    return `${title} (${meta.id}).hwpx`;
  }

  /** @returns 올린 파일의 주소 */
  async put(meta: Pick<DocMeta, 'id' | 'title'>, bytes: Uint8Array): Promise<string> {
    const target = `${this.url}/${encodeURIComponent(this.fileName(meta))}`;
    const headers: Record<string, string> = { 'Content-Type': 'application/hwp+zip' };
    if (this.auth) headers.Authorization = this.auth;
    const res = await fetch(target, { method: 'PUT', headers, body: bytes });
    if (!res.ok) throw new Error(`WebDAV 저장 실패: HTTP ${res.status}`);
    return target;
  }
}
