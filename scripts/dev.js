// 개발용: 서버(8787)와 Vite 개발 서버(5173)를 함께 띄운다.
import { spawn } from 'node:child_process';

const run = (cmd, args) => spawn(cmd, args, { stdio: 'inherit', env: process.env });
const procs = [run('node', ['--watch', 'server/index.js']), run('npx', ['vite'])];
const stop = () => procs.forEach((p) => p.kill());
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
procs.forEach((p) => p.on('exit', stop));
