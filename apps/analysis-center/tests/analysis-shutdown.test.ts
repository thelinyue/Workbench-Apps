import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { DiagnosticPackage } from '../backend/lib/domain/diagnostic-package';
import type { AnalysisTaskRecord, WorkspaceRepository } from '../backend/lib/data/workspace-repository';
import { AnalysisTaskService, type AnalysisWorker } from '../backend/lib/services/analysis-task-service';
import { createAnalysisBackendShutdown } from '../backend/lib/services/analysis-backend-shutdown';

describe('分析中心关闭', () => {
  it('将全部 queued/running 任务、分析记录和诊断包持久化为 cancelled，并保持幂等', async () => {
    const repository = new FakeRepository(
      [packageRecord('package-queued', 'queued', ['task-queued']), packageRecord('package-running', 'running', ['task-running'])],
      [taskRecord('task-queued', 'package-queued', 'queued'), taskRecord('task-running', 'package-running', 'running')]
    );
    const service = new AnalysisTaskService(repository as unknown as WorkspaceRepository);

    const first = service.close();
    const second = service.close();

    expect(first).toBe(second);
    await first;
    expect(repository.tasks.map((task) => [task.id, task.status])).toEqual([
      ['task-queued', 'cancelled'],
      ['task-running', 'cancelled']
    ]);
    expect(repository.analysisRecords).toEqual([
      expect.objectContaining({ taskId: 'task-queued', status: 'cancelled' }),
      expect.objectContaining({ taskId: 'task-running', status: 'cancelled' })
    ]);
    expect(repository.packages.map((item) => [item.id, item.status])).toEqual([
      ['package-queued', 'cancelled'],
      ['package-running', 'cancelled']
    ]);
  });

  it('关闭开始后拒绝新的 enqueue', async () => {
    const repository = new FakeRepository([packageRecord('package-1', 'pending', [])], []);
    const service = new AnalysisTaskService(repository as unknown as WorkspaceRepository);

    const closing = service.close();

    await expect(service.enqueue('package-1')).rejects.toThrow('分析任务服务正在关闭，不能添加新任务');
    await closing;
  });

  it('请求终止活动 Worker 并等待 terminate 和队列 drain 后才完成 close', async () => {
    const repository = new FakeRepository([packageRecord('package-1', 'pending', [])], []);
    const termination = deferred<number>();
    const worker = new FakeAnalysisWorker(termination.promise);
    const events: string[] = [];
    const service = new AnalysisTaskService(repository as unknown as WorkspaceRepository, { createWorker: () => worker });
    service.on('changed', () => events.push('changed'));
    await service.enqueue('package-1');

    let closeSettled = false;
    const closing = service.close();
    void closing.then(() => { closeSettled = true; events.push('close'); });
    await Promise.resolve();

    expect(worker.terminateCalls).toBe(1);
    expect(closeSettled).toBe(false);
    termination.resolve(0);
    await closing;
    expect(events.at(-1)).toBe('close');
    expect(repository.tasks[0]).toEqual(expect.objectContaining({ status: 'cancelled' }));
  });

  it('读取活动任务同步失败后仍等待 Worker terminate 与队列 drain，最后聚合中文错误', async () => {
    const repository = new FakeRepository([packageRecord('package-1', 'pending', [])], []);
    const termination = deferred<number>();
    const worker = new FakeAnalysisWorker(termination.promise);
    const events: string[] = [];
    const service = new AnalysisTaskService(repository as unknown as WorkspaceRepository, { createWorker: () => worker });
    service.on('changed', () => events.push('changed'));
    await service.enqueue('package-1');
    repository.nextListTasksError = new Error('无法读取任务表');

    let closeSettled = false;
    const closing = service.close();
    void closing.then(
      () => { closeSettled = true; events.push('close-resolved'); },
      () => { closeSettled = true; events.push('close-rejected'); }
    );
    await Promise.resolve();

    expect(worker.terminateCalls).toBe(1);
    expect(closeSettled).toBe(false);
    termination.resolve(0);
    await expect(closing).rejects.toThrow('读取活动分析任务失败：无法读取任务表');
    expect(events.at(-1)).toBe('close-rejected');
  });

  it('backend 先停监控，再等待 task close，最后解绑监听并关闭仓储', async () => {
    const taskDrain = deferred<void>();
    const events: string[] = [];
    const shutdown = createAnalysisBackendShutdown({
      monitor: { close: () => { events.push('monitor'); } },
      tasks: { close: async () => { events.push('tasks'); await taskDrain.promise; events.push('drained'); } },
      detachListeners: () => { events.push('detach'); },
      repository: { close: () => { events.push('repository'); } }
    });

    const first = shutdown();
    const second = shutdown();
    expect(first).toBe(second);
    expect(events).toEqual(['monitor', 'tasks']);

    taskDrain.resolve();
    await first;
    expect(events).toEqual(['monitor', 'tasks', 'drained', 'detach', 'repository']);
  });

  it('task close 失败也只在其结算后解绑并关闭仓储，同时向 Worker 暴露中文错误', async () => {
    const events: string[] = [];
    const shutdown = createAnalysisBackendShutdown({
      monitor: { close: () => { events.push('monitor'); } },
      tasks: { close: async () => { events.push('tasks'); throw new Error('取消状态写入失败'); } },
      detachListeners: () => { events.push('detach'); },
      repository: { close: () => { events.push('repository'); } }
    });

    await expect(shutdown()).rejects.toThrow('分析中心关闭失败：取消状态写入失败');
    expect(events).toEqual(['monitor', 'tasks', 'detach', 'repository']);
  });
});

class FakeAnalysisWorker extends EventEmitter implements AnalysisWorker {
  public terminateCalls = 0;
  public constructor(private readonly termination: Promise<number>) { super(); }
  public terminate(): Promise<number> { this.terminateCalls += 1; return this.termination; }
}

class FakeRepository {
  public readonly analysisRecords: Array<Record<string, unknown>> = [];
  public nextListTasksError: Error | undefined;
  public constructor(public packages: DiagnosticPackage[], public tasks: AnalysisTaskRecord[]) {}

  public listPackages(): DiagnosticPackage[] { return this.packages.map((item) => ({ ...item })); }
  public getPackage(id: string): DiagnosticPackage | undefined { return this.packages.find((item) => item.id === id); }
  public upsertPackage(item: DiagnosticPackage): void { this.packages = upsert(this.packages, item); }
  public listTasks(): AnalysisTaskRecord[] {
    if (this.nextListTasksError) {
      const error = this.nextListTasksError;
      this.nextListTasksError = undefined;
      throw error;
    }
    return this.tasks.map((item) => ({ ...item }));
  }
  public getTask(id: string): AnalysisTaskRecord | undefined { return this.tasks.find((item) => item.id === id); }
  public upsertTask(item: AnalysisTaskRecord): void { this.tasks = upsert(this.tasks, item); }
  public upsertAnalysisRecord(item: Record<string, unknown>): void { this.analysisRecords.push(item); }
  public saveAnalysisResult(): void { throw new Error('测试不应完成分析'); }
  public upsertReport(): void { throw new Error('测试不应生成报告'); }
  public saveAnalysisFailure(): void { throw new Error('测试不应记录失败'); }
  public deleteCompletedTask(): boolean { return false; }
  public deleteAllCompletedTasks(): number { return 0; }
}

function packageRecord(id: string, status: DiagnosticPackage['status'], taskIds: string[]): DiagnosticPackage {
  return { id, sourcePath: `D:/Inbox/${id}.zip`, extractPath: `D:/data/${id}`, displayName: `${id}.zip`, detectedAt: '2026-08-28T00:00:00.000Z', status, taskIds, caseId: `case-${id}` };
}

function taskRecord(id: string, packageId: string, status: AnalysisTaskRecord['status']): AnalysisTaskRecord {
  return { id, packageId, scope: 'comprehensive', status, createdAt: '2026-08-28T00:00:00.000Z', progress: status === 'running' ? 50 : 0, message: status };
}

function upsert<T extends { id: string }>(items: T[], item: T): T[] {
  return [...items.filter((candidate) => candidate.id !== item.id), item];
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((accept) => { resolve = accept; }), resolve };
}
