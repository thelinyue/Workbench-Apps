import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  root: resolve('apps/analysis-center'),
  plugins: [react()],
  build: {
    outDir: resolve('apps/analysis-center/dist'),
    emptyOutDir: true,
    rollupOptions: { input: resolve('apps/analysis-center/renderer/index.html') }
  }
});
