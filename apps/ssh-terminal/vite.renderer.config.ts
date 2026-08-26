import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({ root: resolve('apps/ssh-terminal'), plugins: [react()], build: { outDir: resolve('apps/ssh-terminal/dist'), emptyOutDir: true, rollupOptions: { input: resolve('apps/ssh-terminal/renderer/index.html') } } });
