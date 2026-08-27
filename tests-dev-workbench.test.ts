import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { validateDevWorkbenchPaths } from './tools/dev-workbench.mjs';

describe('本地工作台联调启动器', () => {
  it('只接受已支持应用，并返回应用 dist 与同级 Workbench 路径', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workbench-apps-dev-'));
    const appsRoot = join(root, 'Workbench-Apps');
    const workbenchRoot = join(root, 'Hephaestus Workbench');
    await mkdir(join(appsRoot, 'apps', 'analysis-center'), { recursive: true });
    await mkdir(workbenchRoot, { recursive: true });
    await writeFile(join(appsRoot, 'apps', 'analysis-center', 'manifest.json'), '{}');
    await writeFile(join(workbenchRoot, 'package.json'), '{}');

    await expect(validateDevWorkbenchPaths('analysis-center', appsRoot, workbenchRoot)).resolves.toEqual({
      appDirectory: join(appsRoot, 'apps', 'analysis-center'),
      distDirectory: join(appsRoot, 'apps', 'analysis-center', 'dist'),
      workbenchRoot
    });
  });

  it('拒绝未知应用和缺失的 Workbench 路径', async () => {
    await expect(validateDevWorkbenchPaths('unknown-app', 'D:/apps', 'D:/workbench')).rejects.toThrow('不支持本地联调的应用');
    await expect(validateDevWorkbenchPaths('terminal', 'D:/apps', 'D:/workbench')).rejects.toThrow('找不到 Workbench');
  });
});
