// 계정 관리 (서버 컴퓨터에서 실행)
//   node scripts/users.ts add <아이디> <이름> <암호>
//   node scripts/users.ts passwd <아이디> <새 암호>
//   node scripts/users.ts list
// DATA_DIR 환경변수로 데이터 폴더를 고른다 (기본: ./data).

import path from 'node:path';
import { UserStore, UserError } from '../server/users.ts';

const store = new UserStore(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
const [cmd, ...args] = process.argv.slice(2);

try {
  if (cmd === 'add' && args.length === 3) {
    const u = await store.create(args[0]!, args[1]!, args[2]!);
    console.log(`만들었습니다: ${u.username} (${u.name})`);
  } else if (cmd === 'passwd' && args.length === 2) {
    await store.setPassword(args[0]!, args[1]!);
    console.log('암호를 바꿨습니다. 그 계정의 로그인은 모두 끊겼습니다.');
  } else if (cmd === 'list') {
    for (const u of await store.list()) console.log(`${u.username}\t${u.name}\t${u.createdAt}`);
  } else {
    console.log('사용법:\n  node scripts/users.ts add <아이디> <이름> <암호>\n  node scripts/users.ts passwd <아이디> <새 암호>\n  node scripts/users.ts list');
    process.exitCode = 1;
  }
} catch (e) {
  console.error(e instanceof UserError ? e.message : e);
  process.exitCode = 1;
}
