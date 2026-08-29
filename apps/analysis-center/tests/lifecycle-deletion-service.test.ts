import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceRepository } from '../backend/lib/data/workspace-repository';
import { LifecycleDeletionService } from '../backend/lib/services/lifecycle-deletion-service';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe('诊断包完整生命周期删除', () => {
  it('永久删除原始包、解压目录、报告、案例索引和关联任务', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workbench-delete-'));
    directories.push(root);
    const sourcePath = join(root, 'device.tgz');
    const extractPath = join(root, 'device');
    const reportPath = join(extractPath, 'Report', 'index.html');
    const existingUserFilePath = join(extractPath, 'existing-user-file.txt');
    await writeFile(sourcePath, 'archive');
    await mkdir(join(extractPath, 'Report'), { recursive: true });
    await writeFile(reportPath, '<html>report</html>');
    await writeFile(existingUserFilePath, '删除整个合并目录时也会删除此文件');
    const repository = new WorkspaceRepository(join(root, 'workbench.db'));
    const diagnosticPackage = { id: 'c225bc60-8cf5-4f0d-993f-1a06a547ab46', sourcePath, extractPath, reportPath, displayName: 'device.tgz', detectedAt: new Date().toISOString(), status: 'report-ready' as const, taskIds: ['123e4567-e89b-42d3-a456-426614174000'], caseId: 'case-1' };
    repository.upsertPackage(diagnosticPackage);
    repository.ensureCase(diagnosticPackage.id, diagnosticPackage.caseId);
    repository.upsertTask({ id: diagnosticPackage.taskIds[0], packageId: diagnosticPackage.id, scope: 'comprehensive', status: 'succeeded', createdAt: new Date().toISOString(), progress: 100, stage: 'form-conclusion', message: '报告已生成' });
    repository.upsertAnalysisRecord({ id: diagnosticPackage.taskIds[0], packageId: diagnosticPackage.id, taskId: diagnosticPackage.taskIds[0], status: 'succeeded', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    repository.upsertReport(diagnosticPackage.id, reportPath);
    const service = new LifecycleDeletionService(repository);

    const preview = await service.preview([diagnosticPackage]);
    await service.delete([diagnosticPackage]);

    expect(preview).toMatchObject({ packageCount: 1, taskCount: 1, caseCount: 1, analysisRecordCount: 1, reportRecordCount: 1, sourcePaths: [sourcePath], extractPaths: [extractPath], reportPaths: [reportPath] });
    await expect(access(sourcePath)).rejects.toThrow();
    await expect(access(extractPath)).rejects.toThrow();
    await expect(access(existingUserFilePath)).rejects.toThrow();
    expect(repository.listPackages()).toEqual([]);
    expect(repository.listTasks()).toEqual([]);
    repository.close();
  });

  it('仅删除记录时保留原始包、解压目录和报告文件', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workbench-record-delete-'));
    directories.push(root);
    const sourcePath = join(root, 'device.tgz');
    const extractPath = join(root, 'device');
    const reportPath = join(extractPath, 'Report', 'index.html');
    await writeFile(sourcePath, 'archive');
    await mkdir(join(extractPath, 'Report'), { recursive: true });
    await writeFile(reportPath, '<html>report</html>');
    const repository = new WorkspaceRepository(join(root, 'workbench.db'));
    const diagnosticPackage = { id: 'record-only', sourcePath, extractPath, reportPath, displayName: 'device.tgz', detectedAt: new Date().toISOString(), status: 'failed' as const, taskIds: ['task-record-only'], caseId: 'case-record-only' };
    repository.upsertPackage(diagnosticPackage);
    repository.ensureCase(diagnosticPackage.id, diagnosticPackage.caseId);
    repository.upsertTask({ id: diagnosticPackage.taskIds[0], packageId: diagnosticPackage.id, scope: 'comprehensive', status: 'failed', createdAt: new Date().toISOString(), progress: 100, stage: 'identify-package', message: '分析失败', errorMessage: '分析失败' });
    repository.upsertAnalysisRecord({ id: diagnosticPackage.taskIds[0], packageId: diagnosticPackage.id, taskId: diagnosticPackage.taskIds[0], status: 'failed', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    repository.saveAnalysisFailure(diagnosticPackage.id, diagnosticPackage.taskIds[0], 'identify-package', '分析失败', { sourcePath });
    repository.upsertReport(diagnosticPackage.id, reportPath);
    const service = new LifecycleDeletionService(repository);

    try {
      await service.deleteRecords([diagnosticPackage]);

      expect(repository.listPackages()).toEqual([]);
      expect(repository.listTasks()).toEqual([]);
      expect(repository.getAnalysisFailure(diagnosticPackage.taskIds[0])).toBeUndefined();
      await expect(access(sourcePath)).resolves.toBeUndefined();
      await expect(access(extractPath)).resolves.toBeUndefined();
      await expect(access(reportPath)).resolves.toBeUndefined();
    } finally {
      repository.close();
    }
  });
});
