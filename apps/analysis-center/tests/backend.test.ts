import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { createAppBackend } from '../backend/entry';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe('分析中心 backend Worker', () => {
  it('使用独立数据库并通过 Host RPC 保存设置', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'analysis-center-backend-'));
    directories.push(dataDirectory);
    const backend = createAppBackend({ appId: 'analysis-center', dataDirectory, manifest: {}, emit: () => undefined });

    await expect(backend.invoke('packages.list', null)).resolves.toEqual([]);
    await expect(backend.invoke('settings.get', null)).resolves.toEqual({ directories: [], scanIntervalMinutes: 5 });
    await backend.invoke('settings.save', { directories: [dataDirectory], scanIntervalMinutes: 10 });
    await expect(backend.invoke('settings.get', null)).resolves.toEqual({ directories: [dataDirectory], scanIntervalMinutes: 10 });

    backend.close();
    await expect(readFile(join(dataDirectory, 'analysis-center.db'))).resolves.toBeDefined();
    await expect(readFile(join(dataDirectory, 'workbench.db'))).rejects.toThrow();
  });
});
