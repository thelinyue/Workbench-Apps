import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
});
