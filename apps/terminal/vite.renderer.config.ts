import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({ root: resolve('apps/terminal'), plugins: [react()], build: { outDir: resolve('apps/terminal/dist'), emptyOutDir: true, rollupOptions: { input: resolve('apps/terminal/renderer/index.html') } } });
