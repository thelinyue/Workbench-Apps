import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('分析中心独立应用包', () => {
  it('package 与 manifest 使用同一独立版本和运行时入口', async () => {
    const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8')) as { id: string; version: string; hostApiVersion: string; minWorkbenchVersion: string; window: { defaultSize: { width: number; height: number }; minSize: { width: number; height: number } }; runtime: { rendererEntry: string; backendEntry: string }; capabilities: string[] };
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(manifest).toMatchObject({ id: 'analysis-center', version: '2.0.10', hostApiVersion: '1.1', minWorkbenchVersion: '0.1.7', window: { defaultSize: { width: 800, height: 560 }, minSize: { width: 800, height: 560 } }, runtime: { rendererEntry: 'renderer/index.html', backendEntry: 'backend/entry.js' } });
    expect(packageJson.version).toBe(manifest.version);
    expect(manifest.capabilities).toContain('file.open');
    expect(manifest.capabilities).not.toEqual(expect.arrayContaining(['rules.read', 'rules.update']));
    expect(manifest.capabilities).toContain('notification.show');
  });

  it('backend 使用应用自己的数据库文件名，不读取工作台数据库', async () => {
    const source = await readFile(new URL('../backend/entry.ts', import.meta.url), 'utf8');
    expect(source).toContain("analysis-center.db");
    expect(source).not.toContain("workbench.db");
  });
});
