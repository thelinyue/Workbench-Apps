import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  // 分析中心以独立 ZIP 发布，运行时目录不提供 node_modules；将所有非 Node 内置依赖内联到 backend，保证正式包可离线启动。
  ssr: { noExternal: true },
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
