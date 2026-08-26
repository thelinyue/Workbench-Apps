import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({ build: { ssr: true, outDir: resolve('apps/terminal/dist'), emptyOutDir: false, rollupOptions: { external: ['ssh2'], input: { 'backend/entry': resolve('apps/terminal/backend/entry.ts') }, output: { format: 'es', entryFileNames: '[name].js' } } } });
