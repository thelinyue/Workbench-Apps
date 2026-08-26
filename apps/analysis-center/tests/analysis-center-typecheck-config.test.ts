import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('分析中心 TypeScript 配置', () => {
  it('包含工作台报告使用的 Vite raw 资源声明', async () => {
    const config = await readFile(new URL('../tsconfig.json', import.meta.url), 'utf8');

    expect(config).toContain('../../sdk/vite-raw.d.ts');
  });
});
