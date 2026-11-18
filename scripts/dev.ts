// 개발용: 서버(8787)와 Vite 개발 서버(5173)를 함께 띄운다.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

const run = (cmd: string, args: string[]): ChildProcess => spawn(cmd, args, { stdio: 'inherit', env: process.env });
const procs = [run('node', ['--watch', 'server/index.ts']), run('npx', ['vite'])];
const stop = (): void => {
  for (const p of procs) p.kill();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const p of procs) p.on('exit', stop);
