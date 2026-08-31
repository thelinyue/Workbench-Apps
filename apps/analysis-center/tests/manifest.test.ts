import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('分析中心独立应用包', () => {
  it('拥有独立版本和独立运行时入口', async () => {
    const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8')) as { id: string; version: string; hostApiVersion: string; minWorkbenchVersion: string; window: { defaultSize: { width: number; height: number }; minSize: { width: number; height: number } }; runtime: { rendererEntry: string; backendEntry: string }; capabilities: string[] };
    expect(manifest).toMatchObject({ id: 'analysis-center', version: '2.0.4', hostApiVersion: '1.1', minWorkbenchVersion: '0.1.7', window: { defaultSize: { width: 1200, height: 800 }, minSize: { width: 800, height: 560 } }, runtime: { rendererEntry: 'renderer/index.html', backendEntry: 'backend/entry.js' } });
    expect(manifest.capabilities).toContain('file.open');
    expect(manifest.capabilities).toEqual(expect.arrayContaining(['rules.read', 'rules.update']));
    expect(manifest.capabilities).toContain('notification.show');
  });

  it('backend 使用应用自己的数据库文件名，不读取工作台数据库', async () => {
    const source = await readFile(new URL('../backend/entry.ts', import.meta.url), 'utf8');
    expect(source).toContain("analysis-center.db");
    expect(source).not.toContain("workbench.db");
  });
});
