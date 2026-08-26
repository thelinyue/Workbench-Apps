import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('LVM 缓存清理工具应用包', () => {
  it('是工作台内嵌的纯 Web 应用并且不依赖外部网络', async () => {
    const root = process.cwd();
    const manifest = JSON.parse(await readFile(resolve(root, 'apps/lvm-uncache-tool/manifest.json'), 'utf8')) as { id: string; runtime: { kind: string; rendererEntry: string }; capabilities: string[] };
    const html = await readFile(resolve(root, 'apps/lvm-uncache-tool/renderer/index.html'), 'utf8');
    const app = await readFile(resolve(root, 'apps/lvm-uncache-tool/renderer/app.js'), 'utf8');

    expect(manifest).toMatchObject({ id: 'lvm-uncache-tool', runtime: { kind: 'web', rendererEntry: 'renderer/index.html' } });
    expect(manifest.capabilities).toEqual(['file.save']);
    expect(html).toContain('script type="module" src="app.js"');
    expect(app).not.toMatch(/https?:\/\//);
    expect(app).toContain('host.saveFile');
  });
});
