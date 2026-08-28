import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { createAppBackend } from '../backend/entry';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe('分析中心 backend Worker', () => {
  it('使用独立数据库并通过 Host RPC 保存带扫描间隔的设置', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'analysis-center-backend-'));
    directories.push(dataDirectory);
    const backend = createAppBackend({ appId: 'analysis-center', dataDirectory, manifest: {}, emit: () => undefined, showNotification: () => undefined });

    try {
      await expect(backend.invoke('packages.list', null)).resolves.toEqual([]);
      await expect(backend.invoke('settings.get', null)).resolves.toEqual({ directory: undefined, enabled: false, autoAnalyzeEnabled: true, scanIntervalMinutes: 1 });
      await backend.invoke('settings.save', { directory: dataDirectory, enabled: true, autoAnalyzeEnabled: false, scanIntervalMinutes: 3 });
      await expect(backend.invoke('settings.get', null)).resolves.toEqual({ directory: dataDirectory, enabled: true, autoAnalyzeEnabled: false, scanIntervalMinutes: 3 });
      await expect(backend.invoke('settings.save', { directory: dataDirectory, enabled: true, autoAnalyzeEnabled: true, scanIntervalMinutes: 0 })).rejects.toThrow('自动扫描间隔至少为 1 分钟');
      await expect(backend.invoke('settings.save', { directory: dataDirectory, enabled: true, autoAnalyzeEnabled: true, scanIntervalMinutes: 4 })).rejects.toThrow('自动扫描间隔最多为 3 分钟');
    } finally {
      await backend.close();
    }

    await expect(readFile(join(dataDirectory, 'analysis-center.db'))).resolves.toBeDefined();
    await expect(readFile(join(dataDirectory, 'workbench.db'))).rejects.toThrow();
  });
});
