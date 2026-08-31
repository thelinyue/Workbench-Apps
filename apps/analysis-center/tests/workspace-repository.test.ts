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

  it('默认每分钟扫描并开启自动分析，只接受 1 到 3 分钟', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'workbench-settings-'));
    directories.push(dataDirectory);
    const repository = new WorkspaceRepository(join(dataDirectory, 'workbench.db'));

    try {
      expect(repository.getMonitorSettings()).toEqual({ directory: undefined, enabled: false, autoAnalyzeEnabled: true, scanIntervalMinutes: 1 });
      repository.saveMonitorSettings({ directory: 'D:/Inbox', enabled: true, autoAnalyzeEnabled: false, scanIntervalMinutes: 3 });
      expect(repository.getMonitorSettings()).toEqual({ directory: 'D:/Inbox', enabled: true, autoAnalyzeEnabled: false, scanIntervalMinutes: 3 });
      expect(() => repository.saveMonitorScanIntervalMinutes(0)).toThrow('自动扫描间隔至少为 1 分钟');
      expect(() => repository.saveMonitorScanIntervalMinutes(4)).toThrow('自动扫描间隔最多为 3 分钟');
    } finally {
      repository.close();
    }
  });

  it('旧数据库缺少新增列和设置时自动迁移，并把旧 5 分钟设置限制为 3 分钟', async () => {
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
      expect(repository.getMonitorSettings()).toMatchObject({ autoAnalyzeEnabled: true, scanIntervalMinutes: 3 });
      expect(repository.listPackages()[0]).toMatchObject({ sourceSizeBytes: undefined });
      expect(repository.listTasks()[0]).toMatchObject({ stage: 'identify-package', runtimeTimings: undefined });
    } finally {
      repository.close();
    }
  });
});
