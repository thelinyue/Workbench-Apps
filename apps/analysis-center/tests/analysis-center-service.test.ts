import { mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceRepository } from '../backend/lib/data/workspace-repository';
import { AnalysisCenterService } from '../backend/lib/services/analysis-center-service';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe('分析中心服务', () => {
  it('新导入的 tgz、tgz.temp 和 zip 使用原文件同级的去格式后缀目录', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workbench-service-'));
    directories.push(root);
    const inbox = join(root, 'Inbox');
    await mkdir(inbox);
    const cases = [
      { sourceName: 'device-tgz.tgz', extractName: 'device-tgz' },
      { sourceName: 'device-temp.tgz.temp', extractName: 'device-temp' },
      { sourceName: 'nas_server_log_device.zip', extractName: 'nas_server_log_device' }
    ];
    await Promise.all(cases.map((item) => writeFile(join(inbox, item.sourceName), 'content')));
    const repository = new WorkspaceRepository(join(root, 'data', 'analysis-center.db'));
    const service = new AnalysisCenterService(repository);

    try {
      const packages = await Promise.all(cases.map((item) => service.importPackage(join(inbox, item.sourceName))));

      expect(packages.map((item) => item.extractPath)).toEqual(cases.map((item) => join(inbox, item.extractName)));
    } finally {
      repository.close();
    }
  });

  it('拒绝缺少可用名称的诊断包，避免把源目录作为解压目标', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workbench-service-'));
    directories.push(root);
    const sourcePath = join(root, '.tgz');
    await writeFile(sourcePath, 'content');
    const repository = new WorkspaceRepository(join(root, 'data', 'analysis-center.db'));
    const service = new AnalysisCenterService(repository);

    try {
      await expect(service.importPackage(sourcePath)).rejects.toThrow('诊断包文件名缺少可用名称');
    } finally {
      repository.close();
    }
  });

  it('tgz.temp 改名为 tgz 后复用原记录和解压目录', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workbench-service-'));
    directories.push(root);
    const temporaryPath = join(root, 'device.tgz.temp');
    const finalPath = join(root, 'device.tgz');
    await writeFile(temporaryPath, 'content');
    const repository = new WorkspaceRepository(join(root, 'data', 'analysis-center.db'));
    const service = new AnalysisCenterService(repository);

    try {
      const temporaryPackage = await service.importPackage(temporaryPath);
      await rename(temporaryPath, finalPath);
      const finalPackage = await service.importPackage(finalPath);

      expect(finalPackage).toMatchObject({ id: temporaryPackage.id, sourcePath: finalPath, displayName: 'device.tgz', extractPath: join(root, 'device') });
      expect(service.listPackages()).toHaveLength(1);
    } finally {
      repository.close();
    }
  });

  it('不同格式映射到同一解压目录时拒绝覆盖已有诊断包记录', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workbench-service-'));
    directories.push(root);
    const tgzPath = join(root, 'nas_server_log_device.tgz');
    const zipPath = join(root, 'nas_server_log_device.zip');
    await writeFile(tgzPath, 'tgz-content');
    await writeFile(zipPath, 'zip-content');
    const repository = new WorkspaceRepository(join(root, 'data', 'analysis-center.db'));
    const service = new AnalysisCenterService(repository);

    try {
      const tgzPackage = await service.importPackage(tgzPath);

      await expect(service.importPackage(zipPath)).rejects.toThrow('另一个诊断包已使用相同解压目录');
      expect(service.listPackages()).toEqual([expect.objectContaining({ id: tgzPackage.id, sourcePath: tgzPath, displayName: 'nas_server_log_device.tgz' })]);
    } finally {
      repository.close();
    }
  });

  it('重新导入历史记录时保留数据库中的私有解压路径', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workbench-service-'));
    directories.push(root);
    const sourcePath = join(root, 'history.tgz');
    const historicalExtractPath = join(root, 'data', 'extracted', 'package-history');
    await writeFile(sourcePath, 'content');
    const repository = new WorkspaceRepository(join(root, 'data', 'analysis-center.db'));
    repository.upsertPackage({ id: 'package-history', sourcePath, extractPath: historicalExtractPath, displayName: 'history.tgz', sourceSizeBytes: 7, detectedAt: '2026-08-28T00:00:00.000Z', status: 'report-ready', taskIds: [], caseId: 'case-history' });
    const service = new AnalysisCenterService(repository);

    try {
      const diagnosticPackage = await service.importPackage(sourcePath);

      expect(diagnosticPackage.extractPath).toBe(historicalExtractPath);
    } finally {
      repository.close();
    }
  });

  it('历史 tgz.temp 改名为 tgz 后复用任务历史且不迁移私有解压路径', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workbench-service-'));
    directories.push(root);
    const temporaryPath = join(root, 'history.tgz.temp');
    const finalPath = join(root, 'history.tgz');
    const historicalExtractPath = join(root, 'data', 'extracted', 'package-history');
    await writeFile(temporaryPath, 'content');
    const repository = new WorkspaceRepository(join(root, 'data', 'analysis-center.db'));
    repository.upsertPackage({ id: 'package-history', sourcePath: temporaryPath, extractPath: historicalExtractPath, displayName: 'history.tgz.temp', sourceSizeBytes: 7, detectedAt: '2026-08-28T00:00:00.000Z', status: 'report-ready', taskIds: ['task-history'], caseId: 'case-history' });
    const service = new AnalysisCenterService(repository);

    try {
      await rename(temporaryPath, finalPath);
      const diagnosticPackage = await service.importPackage(finalPath);

      expect(diagnosticPackage).toMatchObject({ id: 'package-history', sourcePath: finalPath, extractPath: historicalExtractPath, status: 'report-ready', taskIds: ['task-history'] });
      expect(service.listPackages()).toHaveLength(1);
    } finally {
      repository.close();
    }
  });

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
