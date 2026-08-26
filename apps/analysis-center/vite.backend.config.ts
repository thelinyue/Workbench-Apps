import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  build: {
    ssr: true,
    outDir: resolve('apps/analysis-center/dist'),
    emptyOutDir: false,
    rollupOptions: {
      input: {
        'backend/entry': resolve('apps/analysis-center/backend/entry.ts'),
        'backend/analysis-worker': resolve('apps/analysis-center/backend/analysis-worker.ts')
      },
      output: { format: 'es', entryFileNames: '[name].js', chunkFileNames: 'backend/chunks/[name]-[hash].js' }
    }
  }
});
