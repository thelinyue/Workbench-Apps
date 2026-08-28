import { describe, expect, it, vi } from 'vitest';
import { createPackageImportWorkflow, importPackageFiles, type PackageImportWorkflow } from '../renderer/package-file-import';

describe('文件选择导入', () => {
  it('单个诊断包导入失败后仍导入后续文件，并保留每个失败消息', async () => {
    const importPackage = vi.fn(async (sourcePath: string) => {
      if (sourcePath === 'D:/inbox/broken.tgz') throw new Error('损坏的诊断包');
    });

    const result = await importPackageFiles(
      ['D:/inbox/broken.tgz', 'D:/inbox/valid.tgz'],
      importPackage
    );

    expect(importPackage).toHaveBeenNthCalledWith(1, 'D:/inbox/broken.tgz');
    expect(importPackage).toHaveBeenNthCalledWith(2, 'D:/inbox/valid.tgz');
    expect(result).toEqual({ importedCount: 1, failures: ['broken.tgz：损坏的诊断包'] });
  });

  it('两个拖入文件各自发出 packages.changed 时仍只在批次结束刷新一次', async () => {
    const refresh = vi.fn(async () => undefined);
    const reportFailures = vi.fn();
    let workflow!: PackageImportWorkflow;
    const host = {
      resolveDroppedFiles: vi.fn(async () => ['D:/inbox/one.tgz', 'D:/inbox/two.tgz']),
      invoke: vi.fn(async (method: string) => {
        if (method === 'packages.import') {
          await workflow.handleHostEvent({ appId: 'analysis-center', event: 'packages.changed', payload: {} });
        }
        return undefined;
      })
    };
    workflow = createPackageImportWorkflow({ host, refresh, reportFailures });

    await workflow.importDroppedFiles([{ name: 'one.tgz' } as File, { name: 'two.tgz' } as File]);

    expect(host.resolveDroppedFiles).toHaveBeenCalledOnce();
    expect(host.invoke).toHaveBeenNthCalledWith(1, 'packages.import', { sourcePath: 'D:/inbox/one.tgz' });
    expect(host.invoke).toHaveBeenNthCalledWith(2, 'packages.import', { sourcePath: 'D:/inbox/two.tgz' });
    expect(refresh).toHaveBeenCalledOnce();
    expect(reportFailures).not.toHaveBeenCalled();
  });

  it('导入期间的非 packages.changed 事件立即请求刷新，批次结束后仍执行最终刷新', async () => {
    const refresh = vi.fn(async () => undefined);
    let workflow!: PackageImportWorkflow;
    const host = {
      resolveDroppedFiles: vi.fn(async () => ['D:/inbox/one.tgz']),
      invoke: vi.fn(async (method: string) => {
        if (method === 'packages.import') {
          await workflow.handleHostEvent({ appId: 'analysis-center', event: 'tasks.changed', payload: {} });
        }
        return undefined;
      })
    };
    workflow = createPackageImportWorkflow({ host, refresh, reportFailures: vi.fn() });

    await workflow.importDroppedFiles([{ name: 'one.tgz' } as File]);

    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('最终刷新期间到达的新事件会排队再次刷新，且刷新不会并发', async () => {
    let releaseFirstRefresh!: () => void;
    const firstRefreshReleased = new Promise<void>((resolve) => { releaseFirstRefresh = resolve; });
    let markFirstRefreshStarted!: () => void;
    const firstRefreshStarted = new Promise<void>((resolve) => { markFirstRefreshStarted = resolve; });
    let activeRefreshes = 0;
    let maximumConcurrentRefreshes = 0;
    let refreshCount = 0;
    const refresh = vi.fn(async () => {
      refreshCount += 1;
      activeRefreshes += 1;
      maximumConcurrentRefreshes = Math.max(maximumConcurrentRefreshes, activeRefreshes);
      if (refreshCount === 1) {
        markFirstRefreshStarted();
        await firstRefreshReleased;
      }
      activeRefreshes -= 1;
    });
    const host = {
      resolveDroppedFiles: vi.fn(async () => ['D:/inbox/one.tgz']),
      invoke: vi.fn(async () => undefined)
    };
    const workflow = createPackageImportWorkflow({ host, refresh, reportFailures: vi.fn() });

    const importPromise = workflow.importDroppedFiles([{ name: 'one.tgz' } as File]);
    await firstRefreshStarted;
    const eventPromise = workflow.handleHostEvent({ appId: 'analysis-center', event: 'tasks.changed', payload: {} });
    releaseFirstRefresh();
    await Promise.all([importPromise, eventPromise]);

    expect(refresh).toHaveBeenCalledTimes(2);
    expect(maximumConcurrentRefreshes).toBe(1);
  });

  it('批次外事件会请求刷新', async () => {
    const refresh = vi.fn(async () => undefined);
    const host = {
      resolveDroppedFiles: vi.fn(async () => []),
      invoke: vi.fn(async () => undefined)
    };
    const workflow = createPackageImportWorkflow({ host, refresh, reportFailures: vi.fn() });

    await workflow.handleHostEvent({ appId: 'analysis-center', event: 'packages.changed', payload: {} });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('文件选择与拖入文件共用同一批次导入协调器', async () => {
    const host = {
      resolveDroppedFiles: vi.fn(async () => ['D:/drop/drop.tgz']),
      invoke: vi.fn(async (method: string) => method === 'host.chooseFiles' ? ['D:/picker/picker.tgz'] : undefined)
    };
    const refresh = vi.fn(async () => undefined);
    const workflow = createPackageImportWorkflow({ host, refresh, reportFailures: vi.fn() });

    await workflow.importSelectedFiles();
    await workflow.importDroppedFiles([{ name: 'drop.tgz' } as File]);

    expect(host.invoke).toHaveBeenCalledWith('host.chooseFiles');
    expect(host.invoke).toHaveBeenCalledWith('packages.import', { sourcePath: 'D:/picker/picker.tgz' });
    expect(host.invoke).toHaveBeenCalledWith('packages.import', { sourcePath: 'D:/drop/drop.tgz' });
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
