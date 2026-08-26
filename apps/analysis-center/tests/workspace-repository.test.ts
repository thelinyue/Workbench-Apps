import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceRepository } from '../backend/lib/data/workspace-repository';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('工作台 SQLite 数据仓储', () => {
  it('持久化诊断包和任务', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'workbench-data-'));
    directories.push(dataDirectory);
    const databasePath = join(dataDirectory, 'workbench.db');
    const repository = new WorkspaceRepository(databasePath);

    repository.upsertPackage({
      id: 'package-1',
      sourcePath: 'D:/Inbox/core-048.tgz',
      extractPath: 'D:/Inbox/core-048',
      reportPath: undefined,
      displayName: 'core-048.tgz',
      detectedAt: '2026-08-25T10:25:00.000Z',
      status: 'pending',
      taskIds: [],
      caseId: 'case-1'
    });
    repository.upsertTask({
      id: 'task-1',
      packageId: 'package-1',
      scope: 'comprehensive',
      status: 'queued',
      createdAt: '2026-08-25T10:25:01.000Z',
      progress: 0,
      message: '等待分析'
    });

    expect(repository.listPackages()).toHaveLength(1);
    expect(repository.listTasks()).toEqual([expect.objectContaining({ id: 'task-1', packageId: 'package-1' })]);

    repository.close();
  });

  it('以分钟为单位持久化自动扫描间隔并拒绝小于一分钟的值', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'workbench-settings-'));
    directories.push(dataDirectory);
    const repository = new WorkspaceRepository(join(dataDirectory, 'workbench.db'));

    try {
      expect(repository.getMonitorScanIntervalMinutes()).toBe(5);
      repository.saveMonitorScanIntervalMinutes(1);
      expect(repository.getMonitorScanIntervalMinutes()).toBe(1);
      expect(() => repository.saveMonitorScanIntervalMinutes(0)).toThrow('自动扫描间隔至少为 1 分钟');
    } finally {
      repository.close();
    }
  });
});
