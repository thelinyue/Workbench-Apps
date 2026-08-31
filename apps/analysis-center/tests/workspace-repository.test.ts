import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceRepository } from '../backend/lib/data/workspace-repository';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('工作台 SQLite 数据仓储', () => {
  it('持久化诊断包和任务', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'workbench-data-'));
    directories.push(dataDirectory);
    const databasePath = join(dataDirectory, 'workbench.db');
    const repository = new WorkspaceRepository(databasePath);

    repository.upsertPackage({
      id: 'package-1',
      sourcePath: 'D:/Inbox/core-048.tgz',
      extractPath: 'D:/Inbox/core-048',
      reportPath: undefined,
      displayName: 'core-048.tgz',
      sourceSizeBytes: 1_234_567,
      detectedAt: '2026-08-25T10:25:00.000Z',
      status: 'pending',
      taskIds: [],
      caseId: 'case-1'
    });
    repository.upsertTask({
      id: 'task-1',
      packageId: 'package-1',
      scope: 'comprehensive',
      status: 'queued',
      createdAt: '2026-08-25T10:25:01.000Z',
      progress: 0,
      stage: 'identify-package',
      message: '等待分析',
      runtimeTimings: {
        archiveValidationMs: 100,
        archiveExtractionMs: 200,
        sourceInventoryMs: 300,
        sourceReadMs: 400,
        pipelineAnalysisMs: 500,
        reportRenderMs: 600,
        totalMs: 2_100
      }
    });

    expect(repository.listPackages()).toEqual([expect.objectContaining({ id: 'package-1', sourceSizeBytes: 1_234_567 })]);
    expect(repository.listTasks()).toEqual([expect.objectContaining({
      id: 'task-1',
      packageId: 'package-1',
      stage: 'identify-package',
      runtimeTimings: {
        archiveValidationMs: 100,
        archiveExtractionMs: 200,
        sourceInventoryMs: 300,
        sourceReadMs: 400,
        pipelineAnalysisMs: 500,
        reportRenderMs: 600,
        totalMs: 2_100
      }
    })]);

    repository.close();
  });

  it('返回每个诊断包最近一次成功或失败分析的终态时间', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'workbench-analysis-time-'));
    directories.push(dataDirectory);
    const repository = new WorkspaceRepository(join(dataDirectory, 'workbench.db'));
    const packages = [
      { id: 'package-old', sourcePath: 'D:/old.tgz', extractPath: 'D:/old', displayName: 'old.tgz', detectedAt: '2026-08-28T00:00:00Z', status: 'report-ready' as const, taskIds: ['task-old-1', 'task-old-2'], caseId: 'case-old' },
      { id: 'package-new', sourcePath: 'D:/new.tgz', extractPath: 'D:/new', displayName: 'new.tgz', detectedAt: '2026-08-28T01:00:00Z', status: 'failed' as const, taskIds: ['task-new'], caseId: 'case-new' },
      { id: 'package-empty', sourcePath: 'D:/empty.tgz', extractPath: 'D:/empty', displayName: 'empty.tgz', detectedAt: '2026-08-28T02:00:00Z', status: 'report-ready' as const, taskIds: [], caseId: 'case-empty' }
    ];
    packages.forEach((item) => repository.upsertPackage(item));
    repository.upsertTask({ id: 'task-old-1', packageId: 'package-old', scope: 'comprehensive', status: 'succeeded', createdAt: '2026-08-28T03:00:00Z', progress: 100, stage: 'form-conclusion', message: '诊断结果已完成' });
    repository.upsertTask({ id: 'task-old-2', packageId: 'package-old', scope: 'comprehensive', status: 'failed', createdAt: '2026-08-28T04:00:00Z', progress: 100, stage: 'form-conclusion', message: '分析失败' });
    repository.upsertTask({ id: 'task-new', packageId: 'package-new', scope: 'comprehensive', status: 'failed', createdAt: '2026-08-28T05:00:00Z', progress: 100, stage: 'form-conclusion', message: '分析失败' });
    repository.upsertAnalysisRecord({ id: 'task-old-1', packageId: 'package-old', taskId: 'task-old-1', status: 'succeeded', createdAt: '2026-08-28T03:00:00Z', updatedAt: '2026-08-28T03:01:00Z' });
    repository.upsertAnalysisRecord({ id: 'task-old-2', packageId: 'package-old', taskId: 'task-old-2', status: 'failed', createdAt: '2026-08-28T04:00:00Z', updatedAt: '2026-08-28T04:01:00Z' });
    repository.upsertAnalysisRecord({ id: 'task-new', packageId: 'package-new', taskId: 'task-new', status: 'failed', createdAt: '2026-08-28T05:00:00Z', updatedAt: '2026-08-28T05:01:00Z' });

    try {
      expect(repository.listPackages()).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'package-empty', lastAnalysisAt: undefined }),
        expect.objectContaining({ id: 'package-new', lastAnalysisAt: '2026-08-28T05:01:00Z' }),
        expect.objectContaining({ id: 'package-old', lastAnalysisAt: '2026-08-28T04:01:00Z' })
      ]));
    } finally {
      repository.close();
    }
  });

  it('默认每10秒扫描并开启自动分析，只接受10秒步进的10到60秒', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'workbench-settings-'));
    directories.push(dataDirectory);
    const repository = new WorkspaceRepository(join(dataDirectory, 'workbench.db'));

    try {
      expect(repository.getMonitorSettings()).toEqual({ directory: undefined, enabled: false, autoAnalyzeEnabled: true, scanIntervalSeconds: 10 });
      repository.saveMonitorSettings({ directory: 'D:/Inbox', enabled: true, autoAnalyzeEnabled: false, scanIntervalSeconds: 60 });
      expect(repository.getMonitorSettings()).toEqual({ directory: 'D:/Inbox', enabled: true, autoAnalyzeEnabled: false, scanIntervalSeconds: 60 });
      expect(() => repository.saveMonitorScanIntervalSeconds(0)).toThrow('自动扫描间隔至少为 10 秒');
      expect(() => repository.saveMonitorScanIntervalSeconds(70)).toThrow('自动扫描间隔最多为 60 秒');
      expect(() => repository.saveMonitorScanIntervalSeconds(15)).toThrow('自动扫描间隔必须为 10 秒的整数倍');
    } finally {
      repository.close();
    }
  });

  it('旧数据库的分钟配置不会被当作秒使用，升级后回退为10秒', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'workbench-migration-'));
    directories.push(dataDirectory);
    const databasePath = join(dataDirectory, 'workbench.db');
    const { DatabaseSync } = await import('node:sqlite');
    const oldDatabase = new DatabaseSync(databasePath);
    oldDatabase.exec(`
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO settings (key, value) VALUES ('monitorScanIntervalMinutes', '5');
      CREATE TABLE diagnostic_packages (id TEXT PRIMARY KEY, source_path TEXT NOT NULL, extract_path TEXT NOT NULL, report_path TEXT, display_name TEXT NOT NULL, detected_at TEXT NOT NULL, status TEXT NOT NULL, task_ids TEXT NOT NULL, case_id TEXT NOT NULL);
      CREATE TABLE analysis_tasks (id TEXT PRIMARY KEY, package_id TEXT NOT NULL, scope TEXT NOT NULL DEFAULT 'comprehensive', status TEXT NOT NULL, created_at TEXT NOT NULL, started_at TEXT, progress INTEGER NOT NULL, message TEXT NOT NULL, error_message TEXT);
    `);
    oldDatabase.prepare(`INSERT INTO diagnostic_packages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('package-old', 'D:/old.tgz', 'D:/old', null, 'old.tgz', '2026-08-25T00:00:00Z', 'pending', '[]', 'case-old');
    oldDatabase.prepare(`INSERT INTO analysis_tasks VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('task-old', 'package-old', 'comprehensive', 'queued', '2026-08-25T00:00:01Z', null, 0, '等待分析', null);
    oldDatabase.close();

    const repository = new WorkspaceRepository(databasePath);
    try {
      expect(repository.getMonitorSettings()).toMatchObject({ autoAnalyzeEnabled: true, scanIntervalSeconds: 10 });
      expect(repository.listPackages()[0]).toMatchObject({ sourceSizeBytes: undefined });
      expect(repository.listTasks()[0]).toMatchObject({ stage: 'identify-package', runtimeTimings: undefined });
    } finally {
      repository.close();
    }
  });
});
