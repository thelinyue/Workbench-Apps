import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('分析中心 renderer 构建产物', () => {
  it('为 workbench-app 协议生成指向根 assets 目录的相对资源路径', async () => {
    await execFileAsync(process.execPath, ['tools/build-analysis-center.mjs'], { cwd: process.cwd() });
    const html = await readFile('apps/analysis-center/dist/renderer/index.html', 'utf8');

    expect(html).toMatch(/src="\.\.\/assets\/[^\"]+\.js"/);
    expect(html).toMatch(/href="\.\.\/assets\/[^\"]+\.css"/);
    expect(html).not.toContain('src="/assets/');
    expect(html).not.toContain('href="/assets/');
  }, 30_000);
});
