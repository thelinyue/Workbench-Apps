import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnalysisCenterService } from '../backend/lib/services/analysis-center-service';
import { MonitorDirectoryService } from '../backend/lib/services/monitor-directory-service';
import { WorkspaceRepository } from '../backend/lib/data/workspace-repository';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe('监控目录', () => {
  it('仅在同一输入连续两次大小和修改时间稳定后登记一次', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'analysis-monitor-'));
    directories.push(directory);
    const sourcePath = join(directory, 'device.tgz');
    await writeFile(sourcePath, 'diagnostic archive');
    const repository = new WorkspaceRepository(join(directory, 'analysis-center.db'));
    const analysis = new AnalysisCenterService(repository);
    const monitor = new MonitorDirectoryService(repository, analysis);

    repository.saveMonitorSettings({ directory, enabled: true, autoAnalyzeEnabled: false, scanIntervalMinutes: 3 });
    await monitor.scanNow();
    expect(analysis.listPackages()).toEqual([]);
    await monitor.scanNow();
    expect(analysis.listPackages().map((item) => item.sourcePath)).toEqual([sourcePath]);
    await monitor.scanNow();
    expect(analysis.listPackages()).toHaveLength(1);

    monitor.close();
    repository.close();
  });

  it('启用监控时把目录存量建立为基线，只自动分析之后新增的诊断包', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'analysis-monitor-auto-'));
    directories.push(directory);
    await writeFile(join(directory, 'existing.tgz'), 'existing diagnostic archive');
    const repository = new WorkspaceRepository(join(directory, 'analysis-center.db'));
    const analysis = new AnalysisCenterService(repository);
    const enqueued: string[] = [];
    const monitor = new MonitorDirectoryService(repository, analysis, { enqueue: async (packageId) => { enqueued.push(packageId); } });

    try {
      repository.saveMonitorSettings({ directory, enabled: true, autoAnalyzeEnabled: true, scanIntervalMinutes: 1 });
      await monitor.start();
      await monitor.scanNow();
      expect(analysis.listPackages()).toEqual([]);

      await writeFile(join(directory, 'new.tgz'), 'new diagnostic archive');
      await monitor.scanNow();
      await monitor.scanNow();

      expect(analysis.listPackages()).toEqual([expect.objectContaining({ displayName: 'new.tgz', sourceSizeBytes: 22 })]);
      expect(enqueued).toEqual([analysis.listPackages()[0]!.id]);

      await monitor.scanExistingNow();
      expect(analysis.listPackages()).toEqual(expect.arrayContaining([
        expect.objectContaining({ displayName: 'existing.tgz', status: 'pending' }),
        expect.objectContaining({ displayName: 'new.tgz' })
      ]));
      expect(enqueued).toHaveLength(1);
    } finally {
      monitor.close();
      repository.close();
    }
  });

  it('关闭自动分析后仍登记扫描到的新包但不加入任务队列', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'analysis-monitor-manual-'));
    directories.push(directory);
    await writeFile(join(directory, 'manual.tgz'), 'diagnostic archive');
    const repository = new WorkspaceRepository(join(directory, 'analysis-center.db'));
    const analysis = new AnalysisCenterService(repository);
    const enqueue = vi.fn(async () => undefined);
    const monitor = new MonitorDirectoryService(repository, analysis, { enqueue });

    try {
      repository.saveMonitorSettings({ directory, enabled: true, autoAnalyzeEnabled: false, scanIntervalMinutes: 1 });
      await monitor.scanNow();
      await monitor.scanNow();

      expect(analysis.listPackages()).toEqual([expect.objectContaining({ displayName: 'manual.tgz', status: 'pending' })]);
      expect(enqueue).not.toHaveBeenCalled();
    } finally {
      monitor.close();
      repository.close();
    }
  });

  it('忽略尚在下载的临时扩展名', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'analysis-monitor-temp-'));
    directories.push(directory);
    await writeFile(join(directory, 'device.tgz.crdownload'), 'partial');
    const repository = new WorkspaceRepository(join(directory, 'analysis-center.db'));
    const analysis = new AnalysisCenterService(repository);
    const monitor = new MonitorDirectoryService(repository, analysis);

    repository.saveMonitorSettings({ directory, enabled: true, autoAnalyzeEnabled: true, scanIntervalMinutes: 3 });
    await monitor.scanNow();
    await monitor.scanNow();
    expect(analysis.listPackages()).toEqual([]);

    monitor.close();
    repository.close();
  });

  it('周期扫描只处理启用监控后新增并完成两次稳定采样的文件', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'analysis-monitor-startup-'));
    directories.push(directory);
    const repository = new WorkspaceRepository(join(directory, 'analysis-center.db'));
    const analysis = new AnalysisCenterService(repository);
    const monitor = new MonitorDirectoryService(repository, analysis);

    try {
      repository.saveMonitorSettings({ directory, enabled: true, autoAnalyzeEnabled: true, scanIntervalMinutes: 1 });
      repository.saveMonitorScanIntervalMinutes(1);
      vi.useFakeTimers();
      const scanNow = vi.spyOn(monitor, 'scanNow');
      await monitor.start();
      await writeFile(join(directory, 'startup.tgz'), 'diagnostic archive');
      expect(scanNow).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(60_000);
      await scanNow.mock.results[0]?.value;
      expect(analysis.listPackages()).toEqual([]);
      await vi.advanceTimersByTimeAsync(60_000);
      await scanNow.mock.results[1]?.value;
      expect(analysis.listPackages()).toHaveLength(1);
    } finally {
      monitor.close();
      repository.close();
      vi.useRealTimers();
    }
  });

  it('按保存的分钟间隔执行下一次稳定扫描', async () => {
    vi.useFakeTimers();
    const directory = await mkdtemp(join(tmpdir(), 'analysis-monitor-interval-'));
    directories.push(directory);
    const repository = new WorkspaceRepository(join(directory, 'analysis-center.db'));
    const analysis = new AnalysisCenterService(repository);
    const monitor = new MonitorDirectoryService(repository, analysis);

    try {
      repository.saveMonitorSettings({ directory, enabled: true, autoAnalyzeEnabled: true, scanIntervalMinutes: 1 });
      repository.saveMonitorScanIntervalMinutes(1);
      const scanNow = vi.spyOn(monitor, 'scanNow');
      await monitor.start();
      await writeFile(join(directory, 'interval.tgz'), 'diagnostic archive');

      await vi.advanceTimersByTimeAsync(59_999);
      expect(scanNow).not.toHaveBeenCalled();
      expect(analysis.listPackages()).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      await scanNow.mock.results[0]?.value;
      expect(analysis.listPackages()).toHaveLength(0);
    } finally {
      monitor.close();
      repository.close();
      vi.useRealTimers();
    }
  });

  it('重配或停用监控时不会让正在完成的旧扫描重新排程', async () => {
    vi.useFakeTimers();
    const directory = await mkdtemp(join(tmpdir(), 'analysis-monitor-reconfigure-'));
    directories.push(directory);
    const repository = new WorkspaceRepository(join(directory, 'analysis-center.db'));
    const analysis = new AnalysisCenterService(repository);
    const monitor = new MonitorDirectoryService(repository, analysis);
    let finishScan: (() => void) | undefined;
    const pendingScan = new Promise<void>((resolve) => { finishScan = resolve; });

    try {
      repository.saveMonitorSettings({ directory, enabled: true, autoAnalyzeEnabled: true, scanIntervalMinutes: 1 });
      await monitor.start();
      vi.spyOn(monitor, 'scanNow').mockImplementation(() => pendingScan);

      vi.advanceTimersByTime(60_000);
      repository.saveMonitorSettings({ directory, enabled: false, autoAnalyzeEnabled: true, scanIntervalMinutes: 1 });
      await monitor.reconfigure();
      finishScan?.();
      await Promise.resolve();

      expect(monitor.getStatus()).toEqual({ state: 'disabled' });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      monitor.close();
      repository.close();
      vi.useRealTimers();
    }
  });

  it('关闭监控后不会让已进入导入阶段的旧扫描登记诊断包', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'analysis-monitor-close-inflight-'));
    directories.push(directory);
    const sourcePath = join(directory, 'close.tgz');
    await writeFile(sourcePath, 'diagnostic archive');
    const repository = new WorkspaceRepository(join(directory, 'analysis-center.db'));
    const analysis = new AnalysisCenterService(repository);
    const monitor = new MonitorDirectoryService(repository, analysis);
    repository.saveMonitorSettings({ directory, enabled: true, autoAnalyzeEnabled: true, scanIntervalMinutes: 1 });
    await monitor.scanNow();

    let beginImport: (() => void) | undefined;
    let releaseImport: (() => void) | undefined;
    const importStarted = new Promise<void>((resolve) => { beginImport = resolve; });
    const importReleased = new Promise<void>((resolve) => { releaseImport = resolve; });
    const importPackage = vi.spyOn(analysis, 'importPackage').mockImplementation(async (_path, canContinue) => {
      beginImport?.();
      await importReleased;
      if (!canContinue()) throw new Error('监控目录配置已更新，已取消旧扫描');
      throw new Error('测试应在关闭监控前取消旧扫描');
    });

    try {
      const scanning = monitor.scanNow();
      await importStarted;
      monitor.close();
      releaseImport?.();
      await expect(scanning).resolves.toBeUndefined();
      expect(importPackage.mock.calls[0]?.[1]()).toBe(false);
      expect(analysis.listPackages()).toEqual([]);
    } finally {
      monitor.close();
      repository.close();
    }
  });

  it('重配目录后不会让旧扫描继续导入原目录文件', async () => {
    const root = await mkdtemp(join(tmpdir(), 'analysis-monitor-reconfigure-inflight-'));
    directories.push(root);
    const oldDirectory = join(root, 'old');
    const newDirectory = join(root, 'new');
    await Promise.all([mkdir(oldDirectory), mkdir(newDirectory)]);
    const sourcePath = join(oldDirectory, 'old.tgz');
    await writeFile(sourcePath, 'diagnostic archive');
    const repository = new WorkspaceRepository(join(root, 'analysis-center.db'));
    const analysis = new AnalysisCenterService(repository);
    const monitor = new MonitorDirectoryService(repository, analysis);
    repository.saveMonitorSettings({ directory: oldDirectory, enabled: true, autoAnalyzeEnabled: true, scanIntervalMinutes: 1 });
    await monitor.scanNow();

    let beginImport: (() => void) | undefined;
    let releaseImport: (() => void) | undefined;
    const importStarted = new Promise<void>((resolve) => { beginImport = resolve; });
    const importReleased = new Promise<void>((resolve) => { releaseImport = resolve; });
    const importPackage = vi.spyOn(analysis, 'importPackage').mockImplementation(async (_path, canContinue) => {
      beginImport?.();
      await importReleased;
      if (!canContinue()) throw new Error('监控目录配置已更新，已取消旧扫描');
      throw new Error('测试应在重配目录前取消旧扫描');
    });

    try {
      const scanning = monitor.scanNow();
      await importStarted;
      repository.saveMonitorSettings({ directory: newDirectory, enabled: false, autoAnalyzeEnabled: true, scanIntervalMinutes: 1 });
      await monitor.reconfigure();
      releaseImport?.();
      await expect(scanning).resolves.toBeUndefined();
      expect(importPackage.mock.calls[0]?.[1]()).toBe(false);
      expect(analysis.listPackages()).toEqual([]);
    } finally {
      monitor.close();
      repository.close();
    }
  });

  it('监控目录不可访问时暂停并提供可读状态，而不是抛出未处理错误', async () => {
    const root = await mkdtemp(join(tmpdir(), 'analysis-monitor-missing-'));
    directories.push(root);
    const directory = join(root, 'missing');
    const repository = new WorkspaceRepository(join(root, 'analysis-center.db'));
    const analysis = new AnalysisCenterService(repository);
    const monitor = new MonitorDirectoryService(repository, analysis);

    try {
      repository.saveMonitorSettings({ directory, enabled: true, autoAnalyzeEnabled: true, scanIntervalMinutes: 1 });
      await monitor.start();
      expect(monitor.getStatus()).toEqual(expect.objectContaining({ state: 'paused', warning: expect.stringContaining('无法访问') }));
    } finally {
      monitor.close();
      repository.close();
    }
  });
});
