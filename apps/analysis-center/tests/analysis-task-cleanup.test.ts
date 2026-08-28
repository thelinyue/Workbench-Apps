import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceRepository, type AnalysisTaskRecord } from '../backend/lib/data/workspace-repository';
import { AnalysisTaskService, selectNextQueuedTask } from '../backend/lib/services/analysis-task-service';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function savePackage(repository: WorkspaceRepository, taskIds: string[]) {
  repository.upsertPackage({
    id: 'package-1',
    sourcePath: 'D:/Inbox/core-048.tgz',
    extractPath: 'D:/Inbox/core-048',
    reportPath: 'D:/Inbox/core-048/Report/index.html',
    displayName: 'core-048.tgz',
    detectedAt: '2026-08-25T10:25:00.000Z',
    status: 'report-ready',
    taskIds,
    caseId: 'case-1'
  });
}

function saveTask(repository: WorkspaceRepository, id: string, status: AnalysisTaskRecord['status'], startedAt?: string): void {
  repository.upsertTask({
    id,
    packageId: 'package-1',
    scope: 'comprehensive',
    status,
    createdAt: `2026-08-25T10:25:${id.slice(-2)}.000Z`,
    startedAt,
    progress: status === 'succeeded' || status === 'failed' ? 100 : 0,
    stage: status === 'succeeded' ? 'form-conclusion' : 'identify-package',
    message: status
  });
}

function saveAnalysisRecord(repository: WorkspaceRepository, taskId: string, status: AnalysisTaskRecord['status']): void {
  repository.upsertAnalysisRecord({
    id: taskId,
    packageId: 'package-1',
    taskId,
    status,
    createdAt: '2026-08-25T10:25:00.000Z',
    updatedAt: '2026-08-25T10:25:01.000Z'
  });
}

describe('分析任务清理', () => {
  it('队列按创建先后 FIFO 选择下一项，与界面的前方任务数一致', () => {
    const task = (id: string, createdAt: string): AnalysisTaskRecord => ({ id, packageId: id, scope: 'comprehensive', status: 'queued', createdAt, progress: 0, stage: 'identify-package', message: '等待综合分析' });
    const next = selectNextQueuedTask([
      task('task-c', '2026-08-27T10:03:00.000Z'),
      task('task-b', '2026-08-27T10:02:00.000Z'),
      { ...task('task-a', '2026-08-27T10:01:00.000Z'), status: 'running' }
    ]);

    expect(next?.id).toBe('task-b');
  });

  it('持久化任务实际开始时间，供重新打开分析中心后继续显示运行耗时', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workbench-task-started-at-'));
    directories.push(root);
    const repository = new WorkspaceRepository(join(root, 'workbench.db'));
    savePackage(repository, ['task-01']);
    saveTask(repository, 'task-01', 'running', '2026-08-25T10:26:00.000Z');

    expect(repository.listTasks()[0]).toEqual(expect.objectContaining({ startedAt: '2026-08-25T10:26:00.000Z' }));
    repository.close();
  });

  it('清理单个终态任务时保留诊断包和报告索引，并移除关联引用', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workbench-task-cleanup-'));
    directories.push(root);
    const repository = new WorkspaceRepository(join(root, 'workbench.db'));
    savePackage(repository, ['task-01', 'task-02']);
    saveTask(repository, 'task-01', 'succeeded');
    saveTask(repository, 'task-02', 'queued');
    saveAnalysisRecord(repository, 'task-01', 'succeeded');
    repository.upsertReport('package-1', 'D:/Inbox/core-048/Report/index.html');
    const service = new AnalysisTaskService(repository);

    service.clear('task-01');

    expect(repository.listTasks().map((task) => task.id)).toEqual(['task-02']);
    expect(repository.listPackages()[0]).toEqual(expect.objectContaining({ taskIds: ['task-02'], reportPath: 'D:/Inbox/core-048/Report/index.html' }));
    expect(repository.countLifecycleRecords(['package-1'])).toEqual({ caseCount: 0, analysisRecordCount: 0, reportRecordCount: 1 });
    repository.close();
  });

  it('禁止清理运行中或排队任务', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workbench-task-cleanup-active-'));
    directories.push(root);
    const repository = new WorkspaceRepository(join(root, 'workbench.db'));
    savePackage(repository, ['task-01']);
    saveTask(repository, 'task-01', 'running');
    const service = new AnalysisTaskService(repository);

    expect(() => service.clear('task-01')).toThrow('运行中或排队中的任务不能清理，请先取消任务');
    expect(repository.listTasks()).toHaveLength(1);
    repository.close();
  });

  it('一键清理所有终态任务并保留运行中和排队任务', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workbench-task-cleanup-bulk-'));
    directories.push(root);
    const repository = new WorkspaceRepository(join(root, 'workbench.db'));
    savePackage(repository, ['task-01', 'task-02', 'task-03', 'task-04']);
    saveTask(repository, 'task-01', 'succeeded');
    saveTask(repository, 'task-02', 'failed');
    saveTask(repository, 'task-03', 'cancelled');
    saveTask(repository, 'task-04', 'queued');
    saveAnalysisRecord(repository, 'task-01', 'succeeded');
    saveAnalysisRecord(repository, 'task-02', 'failed');
    saveAnalysisRecord(repository, 'task-03', 'cancelled');
    const service = new AnalysisTaskService(repository);

    expect(service.clearCompleted()).toBe(3);

    expect(repository.listTasks().map((task) => task.id)).toEqual(['task-04']);
    expect(repository.listPackages()[0].taskIds).toEqual(['task-04']);
    expect(repository.countLifecycleRecords(['package-1']).analysisRecordCount).toBe(0);
    repository.close();
  });
});
