import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { createAppBackend } from '../backend/entry';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe('分析中心 backend Worker', () => {
  it('从应用私有目录读取内置规则状态，不调用 Workbench 规则服务', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'analysis-center-rules-state-'));
    directories.push(dataDirectory);
    const backend = createAppBackend({ appId: 'analysis-center', dataDirectory, manifest: {}, emit: () => undefined, showNotification: () => undefined });

    try {
      await expect(backend.invoke('rules.get-state', null)).resolves.toEqual({ currentVersion: '1.0.0', source: 'bundled' });
    } finally {
      await backend.close();
    }
  });

  it('使用独立数据库并通过 Host RPC 保存带扫描间隔的设置', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'analysis-center-backend-'));
    directories.push(dataDirectory);
    const backend = createAppBackend({ appId: 'analysis-center', dataDirectory, manifest: {}, emit: () => undefined, showNotification: () => undefined });

    try {
      await expect(backend.invoke('packages.list', null)).resolves.toEqual([]);
      await expect(backend.invoke('settings.get', null)).resolves.toEqual({ directory: undefined, enabled: false, autoAnalyzeEnabled: true, scanIntervalSeconds: 10 });
      await backend.invoke('settings.save', { directory: dataDirectory, enabled: true, autoAnalyzeEnabled: false, scanIntervalSeconds: 60 });
      await expect(backend.invoke('settings.get', null)).resolves.toEqual({ directory: dataDirectory, enabled: true, autoAnalyzeEnabled: false, scanIntervalSeconds: 60 });
      await expect(backend.invoke('settings.save', { directory: dataDirectory, enabled: true, autoAnalyzeEnabled: true, scanIntervalSeconds: 0 })).rejects.toThrow('自动扫描间隔至少为 10 秒');
      await expect(backend.invoke('settings.save', { directory: dataDirectory, enabled: true, autoAnalyzeEnabled: true, scanIntervalSeconds: 70 })).rejects.toThrow('自动扫描间隔最多为 60 秒');
      await expect(backend.invoke('settings.save', { directory: dataDirectory, enabled: true, autoAnalyzeEnabled: true, scanIntervalSeconds: 15 })).rejects.toThrow('自动扫描间隔必须为 10 秒的整数倍');
    } finally {
      await backend.close();
    }

    await expect(readFile(join(dataDirectory, 'analysis-center.db'))).resolves.toBeDefined();
    await expect(readFile(join(dataDirectory, 'workbench.db'))).rejects.toThrow();
  });

  it('仅按 packageId 从私有记录生成完整 sysinfo 报告，不接受伪造源路径', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'analysis-center-backend-'));
    directories.push(dataDirectory);
    const sourcePath = join(dataDirectory, 'history.tgz');
    const forgedPath = join(dataDirectory, 'forged-sysinfo.json');
    await writeFile(sourcePath, 'archive-placeholder', 'utf8');
    await writeFile(forgedPath, JSON.stringify({ deviceName: 'Forged device' }), 'utf8');
    const backend = createAppBackend({ appId: 'analysis-center', dataDirectory, manifest: {}, emit: () => undefined, showNotification: () => undefined });

    try {
      const diagnosticPackage = await backend.invoke('packages.import', { sourcePath }) as { id: string; extractPath: string };
      await mkdir(join(diagnosticPackage.extractPath, 'diag'), { recursive: true });
      await writeFile(join(diagnosticPackage.extractPath, 'diag', 'sysinfo.json'), JSON.stringify({ deviceName: 'Trusted device' }), 'utf8');

      const reportPath = await backend.invoke('results.sysinfo-report-path', { packageId: diagnosticPackage.id, sourcePath: forgedPath }) as string;
      expect(reportPath).toBe(join(diagnosticPackage.extractPath, 'sysinfo-report.html'));
      await expect(readFile(reportPath, 'utf8')).resolves.toContain('Trusted device');
      await expect(readFile(reportPath, 'utf8')).resolves.not.toContain('Forged device');
      await expect(backend.invoke('results.sysinfo-report-path', { packageId: 'missing-package' })).rejects.toThrow('找不到指定的诊断包');
    } finally {
      await backend.close();
    }
  });

  it('源文件已不存在时，仍可通过 IPC 仅删除记录，并拒绝物理删除令牌混用', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'analysis-center-record-delete-'));
    directories.push(dataDirectory);
    const sourcePath = join(dataDirectory, 'device.tgz');
    await writeFile(sourcePath, 'archive-placeholder', 'utf8');
    const backend = createAppBackend({ appId: 'analysis-center', dataDirectory, manifest: {}, emit: () => undefined, showNotification: () => undefined });

    try {
      const diagnosticPackage = await backend.invoke('packages.import', { sourcePath }) as { id: string };
      await rm(sourcePath);
      const recordPreview = await backend.invoke('packages.delete-record-preview', { packageIds: [diagnosticPackage.id] }) as { confirmationToken: string };
      await expect(backend.invoke('packages.delete', { packageIds: [diagnosticPackage.id], confirmationToken: recordPreview.confirmationToken })).rejects.toThrow('操作类型不匹配');

      const validPreview = await backend.invoke('packages.delete-record-preview', { packageIds: [diagnosticPackage.id] }) as { confirmationToken: string };
      await backend.invoke('packages.delete-record', { packageIds: [diagnosticPackage.id], confirmationToken: validPreview.confirmationToken });

      await expect(access(sourcePath)).rejects.toThrow();
      await expect(backend.invoke('packages.list', null)).resolves.toEqual([]);
    } finally {
      await backend.close();
    }
  });

  it('源文件已不存在时，仍可通过 IPC 删除诊断包并清理记录', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'analysis-center-lifecycle-delete-'));
    directories.push(dataDirectory);
    const sourcePath = join(dataDirectory, 'device.tgz');
    await writeFile(sourcePath, 'archive-placeholder');
    const backend = createAppBackend({ appId: 'analysis-center', dataDirectory, manifest: {}, emit: () => undefined, showNotification: () => undefined });

    try {
      const diagnosticPackage = await backend.invoke('packages.import', { sourcePath }) as { id: string };
      await rm(sourcePath);
      const preview = await backend.invoke('packages.delete-preview', { packageIds: [diagnosticPackage.id] }) as { confirmationToken: string };

      await backend.invoke('packages.delete', { packageIds: [diagnosticPackage.id], confirmationToken: preview.confirmationToken });

      await expect(backend.invoke('packages.list', null)).resolves.toEqual([]);
    } finally {
      await backend.close();
    }
  });

  it('使用同一个确认令牌批量永久删除多个诊断包及其记录', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'analysis-center-batch-delete-'));
    directories.push(dataDirectory);
    const sourcePaths = [join(dataDirectory, 'device-a.tgz'), join(dataDirectory, 'device-b.tgz')];
    await Promise.all(sourcePaths.map((sourcePath) => writeFile(sourcePath, 'archive-placeholder')));
    const backend = createAppBackend({ appId: 'analysis-center', dataDirectory, manifest: {}, emit: () => undefined, showNotification: () => undefined });

    try {
      const packages = await Promise.all(sourcePaths.map((sourcePath) => backend.invoke('packages.import', { sourcePath }) as Promise<{ id: string }>));
      const packageIds = packages.map((item) => item.id);
      const preview = await backend.invoke('packages.delete-preview', { packageIds }) as { packageCount: number; confirmationToken: string };
      expect(preview.packageCount).toBe(2);

      await backend.invoke('packages.delete', { packageIds, confirmationToken: preview.confirmationToken });

      await Promise.all(sourcePaths.map((sourcePath) => expect(access(sourcePath)).rejects.toThrow()));
      await expect(backend.invoke('packages.list', null)).resolves.toEqual([]);
    } finally {
      await backend.close();
    }
  });
});
