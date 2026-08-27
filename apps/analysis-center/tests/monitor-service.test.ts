import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
    const monitor = new MonitorDirectoryService(repository, analysis, 1);

    repository.saveMonitorSettings({ directory, enabled: true });
    await monitor.scanNow();
    expect(analysis.listPackages()).toEqual([]);
    await monitor.scanNow();
    expect(analysis.listPackages().map((item) => item.sourcePath)).toEqual([sourcePath]);
    await monitor.scanNow();
    expect(analysis.listPackages()).toHaveLength(1);

    monitor.close();
    repository.close();
  });

  it('忽略尚在下载的临时扩展名', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'analysis-monitor-temp-'));
    directories.push(directory);
    await writeFile(join(directory, 'device.tgz.crdownload'), 'partial');
    const repository = new WorkspaceRepository(join(directory, 'analysis-center.db'));
    const analysis = new AnalysisCenterService(repository);
    const monitor = new MonitorDirectoryService(repository, analysis, 1);

    repository.saveMonitorSettings({ directory, enabled: true });
    await monitor.scanNow();
    await monitor.scanNow();
    expect(analysis.listPackages()).toEqual([]);

    monitor.close();
    repository.close();
  });

  it('启动扫描会自行完成第二次稳定采样', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'analysis-monitor-startup-'));
    directories.push(directory);
    await writeFile(join(directory, 'startup.tgz'), 'diagnostic archive');
    const repository = new WorkspaceRepository(join(directory, 'analysis-center.db'));
    const analysis = new AnalysisCenterService(repository);
    const monitor = new MonitorDirectoryService(repository, analysis, 5);

    repository.saveMonitorSettings({ directory, enabled: true });
    await monitor.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(analysis.listPackages()).toHaveLength(1);

    monitor.close();
    repository.close();
  });
});
