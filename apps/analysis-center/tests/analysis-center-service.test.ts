import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceRepository } from '../backend/lib/data/workspace-repository';
import { AnalysisCenterService } from '../backend/lib/services/analysis-center-service';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe('分析中心服务', () => {
  it('手动扫描监控目录时只发现 nas_server_log 开头的 ZIP 诊断包', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workbench-service-'));
    directories.push(root);
    const inbox = join(root, 'Inbox');
    await mkdir(inbox);
    await writeFile(join(inbox, 'valid.tgz'), 'content');
    await writeFile(join(inbox, 'valid.tgz.temp'), 'content');
    await writeFile(join(inbox, 'nas_server_log_valid.zip'), 'content');
    await writeFile(join(inbox, 'other.zip'), 'content');
    const repository = new WorkspaceRepository(join(root, 'workbench.db'));
    repository.saveMonitorDirectories([inbox]);
    const service = new AnalysisCenterService(repository);

    try {
      const packages = await service.scanMonitorDirectories();

      expect(packages.map((item) => item.displayName).sort()).toEqual(['nas_server_log_valid.zip', 'valid.tgz', 'valid.tgz.temp']);
    } finally {
      repository.close();
    }
  });

  it('手动导入其他 ZIP 时提示文件名必须以 nas_server_log 开头', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workbench-service-'));
    directories.push(root);
    const unsupportedPath = join(root, 'other.zip');
    await writeFile(unsupportedPath, 'content');
    const repository = new WorkspaceRepository(join(root, 'workbench.db'));
    const service = new AnalysisCenterService(repository);

    try {
      await expect(service.importPackage(unsupportedPath)).rejects.toThrow('ZIP 诊断包文件名必须以 nas_server_log 开头');
    } finally {
      repository.close();
    }
  });

  it('导入不支持的格式时提示包含 ZIP 支持范围', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workbench-service-'));
    directories.push(root);
    const unsupportedPath = join(root, 'unsupported.rar');
    await writeFile(unsupportedPath, 'content');
    const repository = new WorkspaceRepository(join(root, 'workbench.db'));
    const service = new AnalysisCenterService(repository);

    try {
      await expect(service.importPackage(unsupportedPath)).rejects.toThrow('.zip');
    } finally {
      repository.close();
    }
  });
});
