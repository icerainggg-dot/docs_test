import { defineConfig } from 'vite';

const server = `http://localhost:${process.env.PORT || 8787}`;

export default defineConfig({
  root: 'web',
  build: { outDir: '../dist/web', emptyOutDir: true, target: 'es2022' },
  optimizeDeps: { exclude: ['@rhwp/core'] },
  server: {
    proxy: {
      '/api': server,
      '/collab': { target: server.replace('http', 'ws'), ws: true },
    },
  },
});
