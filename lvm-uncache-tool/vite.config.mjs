import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  root: resolve('.'),
  base: './',
  build: {
    outDir: resolve('dist'),
    emptyOutDir: true,
    rollupOptions: { input: resolve('renderer/index.html') }
  }
});
