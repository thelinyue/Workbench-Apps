import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceRepository } from '../backend/lib/data/workspace-repository';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe('工作台 SQLite 数据仓储', () => {
  it('数据库父目录不存在时会自动创建数据目录', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workbench-db-parent-'));
    directories.push(root);
    const repository = new WorkspaceRepository(join(root, 'created-later', 'workbench.db'));
    expect(repository.listPackages()).toEqual([]);
    repository.close();
  });
});
