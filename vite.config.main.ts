// vite.config.main.ts — Electron 主进程打包（CJS：require('electron') 走内置模块，规避 ESM interop 坑）
import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { copyFileSync } from 'node:fs';

export default defineConfig({
  plugins: [
    {
      name: 'copy-preload',
      closeBundle() {
        copyFileSync(resolve(__dirname, 'electron/preload.cjs'), resolve(__dirname, 'dist/electron/preload.cjs'));
        console.log('[build] preload.cjs 已复制到 dist/electron/');
      },
    },
  ],
  build: {
    target: 'node22',
    outDir: 'dist/electron',
    emptyOutDir: true,
    lib: {
      entry: resolve(__dirname, 'electron/main.ts'),
      formats: ['cjs'],
      fileName: () => 'main.cjs',
    },
    rollupOptions: {
      external: ['electron', 'node:sqlite', 'node:crypto', 'node:fs', 'node:path', 'node:url', 'node:child_process', 'node:util', 'node:http', 'node:net', 'node:os'],
    },
  },
});
