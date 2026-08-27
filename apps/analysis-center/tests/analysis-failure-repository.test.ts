import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { WorkspaceRepository } from '../backend/lib/data/workspace-repository';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

it('保存失败阶段、中文错误和输入元数据，不写入结果表', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'analysis-failure-db-'));
  directories.push(directory);
  const repository = new WorkspaceRepository(join(directory, 'analysis-center.db'));
  repository.upsertPackage({ id: 'package-1', sourcePath: 'fixture.tgz', extractPath: join(directory, 'extract'), displayName: 'fixture.tgz', detectedAt: '2026-08-26T00:00:00Z', status: 'failed', taskIds: ['task-1'], caseId: 'case-1' });
  repository.upsertTask({ id: 'task-1', packageId: 'package-1', scope: 'comprehensive', status: 'failed', createdAt: '2026-08-26T00:00:00Z', progress: 100, message: '分析失败', errorMessage: '无法解压诊断包' });

  repository.saveAnalysisFailure('package-1', 'task-1', '解压', '无法解压诊断包', { sourcePath: 'fixture.tgz' });
  expect(repository.getAnalysisFailure('task-1')).toMatchObject({ packageId: 'package-1', stage: '解压', errorMessage: '无法解压诊断包', inputMetadata: { sourcePath: 'fixture.tgz' } });
  expect(repository.getAnalysisResult('package-1')).toBeUndefined();
  repository.close();
});
