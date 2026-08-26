import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  root: resolve('apps/analysis-center'),
  // 入口位于 renderer/，构建资源位于应用包根目录，必须生成相对路径以适配 workbench-app:// 协议。
  base: './',
  plugins: [react()],
  build: {
    outDir: resolve('apps/analysis-center/dist'),
    emptyOutDir: true,
    rollupOptions: { input: resolve('apps/analysis-center/renderer/index.html') }
  }
});
