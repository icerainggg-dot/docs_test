// 계정 관리 (서버 컴퓨터에서 실행). 화면의 관리자 메뉴로도 같은 일을 할 수 있다.
//   node scripts/users.ts add <아이디> <이름> <암호> [--admin]
//   node scripts/users.ts passwd <아이디> <새 암호>
//   node scripts/users.ts admin <아이디>          관리자로 지정
//   node scripts/users.ts list
// DATA_DIR 환경변수로 데이터 폴더를 고른다 (기본: ./data).

import path from 'node:path';
import { UserStore, UserError } from '../server/users.ts';

const store = new UserStore(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
const argv = process.argv.slice(2);
const admin = argv.includes('--admin');
const [cmd, ...args] = argv.filter((a) => a !== '--admin');

const usage = (): void => {
  console.log(
    '사용법:\n  node scripts/users.ts add <아이디> <이름> <암호> [--admin]\n  node scripts/users.ts passwd <아이디> <새 암호>\n  node scripts/users.ts admin <아이디>\n  node scripts/users.ts list',
  );
  process.exitCode = 1;
};

try {
  if (cmd === 'add' && args.length === 3) {
    const u = await store.create(args[0]!, args[1]!, args[2]!, admin ? { role: 'admin' } : {});
    console.log(`만들었습니다: ${u.username} (${u.name})${u.role === 'admin' ? ' — 관리자' : ''}`);
  } else if (cmd === 'passwd' && args.length === 2) {
    await store.setPassword(args[0]!, args[1]!);
    console.log('암호를 바꿨습니다. 그 계정의 로그인은 모두 끊겼습니다.');
  } else if (cmd === 'admin' && args.length === 1) {
    const u = (await store.list()).find((x) => x.username === args[0]!.toLowerCase());
    if (!u) throw new UserError('없는 아이디입니다.');
    await store.update(u.id, { role: 'admin', active: true });
    console.log(`${u.username} 을(를) 관리자로 지정했습니다.`);
  } else if (cmd === 'list') {
    for (const u of await store.list()) console.log([u.username, u.name, u.role === 'admin' ? '관리자' : '', u.active ? '' : '사용중지'].join('\t'));
  } else usage();
} catch (e) {
  console.error(e instanceof UserError ? e.message : e);
  process.exitCode = 1;
}
