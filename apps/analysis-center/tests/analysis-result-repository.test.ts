import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { WorkspaceRepository } from '../backend/lib/data/workspace-repository';
import type { AnalysisResult } from '../backend/lib/analysis-v1/pipeline';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

it('保存并读取带 schemaVersion 的 V1 AnalysisResult', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'analysis-result-db-'));
  directories.push(directory);
  const repository = new WorkspaceRepository(join(directory, 'analysis-center.db'));
  repository.upsertPackage({ id: 'package-1', sourcePath: 'fixture.tgz', extractPath: join(directory, 'extract'), displayName: 'fixture.tgz', detectedAt: '2026-08-26T00:00:00Z', status: 'report-ready', taskIds: ['task-1'], caseId: 'case-1' });
  repository.upsertTask({ id: 'task-1', packageId: 'package-1', scope: 'comprehensive', status: 'succeeded', createdAt: '2026-08-26T00:00:00Z', progress: 100, stage: 'form-conclusion', message: '诊断结果已完成' });
  const result = { schemaVersion: 1, id: 'result-1', status: 'completed', summary: { criticalCount: 0, warningCount: 0, infoCount: 0, complete: true }, diagnoses: [], findings: [], evidence: [], deviceAssessments: [], recommendations: [], metadata: { source: 'fixture.tgz', startTime: '2026-08-26T00:00:00Z', completeTime: '2026-08-26T00:00:01Z', duration: 1, processedFiles: 1, processedLines: 1, processedEvents: 0, analyzerVersion: '1.0.0', rulePackVersion: '1.0.0', missingData: [] } } satisfies AnalysisResult;
  repository.saveAnalysisResult('package-1', 'task-1', result);
  expect(repository.getAnalysisResult('package-1')).toEqual(result);
  repository.close();
});

it('最近结果列表只返回首条诊断摘要，不传输完整分析结果', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'analysis-result-summary-'));
  directories.push(directory);
  const repository = new WorkspaceRepository(join(directory, 'analysis-center.db'));
  repository.upsertPackage({ id: 'package-1', sourcePath: 'fixture.tgz', extractPath: join(directory, 'extract'), displayName: 'fixture.tgz', detectedAt: '2026-08-26T00:00:00Z', status: 'report-ready', taskIds: ['task-1'], caseId: 'case-1' });
  repository.upsertTask({ id: 'task-1', packageId: 'package-1', scope: 'comprehensive', status: 'succeeded', createdAt: '2026-08-26T00:00:00Z', progress: 100, stage: 'form-conclusion', message: '诊断结果已完成' });
  repository.saveAnalysisResult('package-1', 'task-1', {
    schemaVersion: 1,
    id: 'result-1',
    status: 'completed',
    summary: { criticalCount: 1, warningCount: 0, infoCount: 0, complete: true },
    diagnoses: [{ id: 'diagnosis-1', category: 'storage', severity: 'critical', confidence: 'confirmed', title: '硬盘存在介质风险', summary: '需要尽快核验。', affectedResources: ['/dev/sda'], findingIds: ['finding-1'], recommendationIds: [] }],
    findings: [{ id: 'finding-1', type: 'storage.media_error', category: 'storage', severity: 'critical', confidence: 'confirmed', title: '介质错误', summary: '大量日志证据。', affectedResources: ['/dev/sda'], evidenceIds: ['evidence-1'], occurrenceCount: 1000 }],
    evidence: [{ id: 'evidence-1', timestampPrecision: 'exact', timestampConfidence: 'confirmed', sourceFile: 'kernel.log', lineNumber: 100, eventType: 'storage.media_error', rawMessage: 'x'.repeat(100_000) }],
    deviceAssessments: [],
    recommendations: [],
    metadata: { source: 'fixture.tgz', startTime: '2026-08-26T00:00:00Z', completeTime: '2026-08-26T00:00:01Z', duration: 1, processedFiles: 1, processedLines: 1000, processedEvents: 1000, analyzerVersion: '1.0.0', rulePackVersion: '1.0.0', missingData: [] }
  });

  try {
    expect(repository.listRecentAnalysisSummaries()).toEqual([{
      packageId: 'package-1',
      result: { diagnoses: [{ title: '硬盘存在介质风险', severity: 'critical' }] }
    }]);
    expect(repository.getAnalysisResult('package-1')?.evidence[0]?.rawMessage).toHaveLength(100_000);
  } finally {
    repository.close();
  }
});

it('只保留最新 20 条 V1 诊断结果', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'analysis-result-limit-'));
  directories.push(directory);
  const repository = new WorkspaceRepository(join(directory, 'analysis-center.db'));
  for (let index = 0; index < 21; index += 1) {
    const packageId = `package-${index}`;
    const taskId = `task-${index}`;
    repository.upsertPackage({ id: packageId, sourcePath: `fixture-${index}.tgz`, extractPath: join(directory, `extract-${index}`), displayName: `fixture-${index}.tgz`, detectedAt: `2026-08-26T00:00:${String(index).padStart(2, '0')}Z`, status: 'report-ready', taskIds: [taskId], caseId: `case-${index}` });
    repository.upsertTask({ id: taskId, packageId, scope: 'comprehensive', status: 'succeeded', createdAt: `2026-08-26T00:00:${String(index).padStart(2, '0')}Z`, progress: 100, stage: 'form-conclusion', message: '诊断结果已完成' });
    repository.saveAnalysisResult(packageId, taskId, { schemaVersion: 1, id: `result-${index}`, status: 'completed', summary: { criticalCount: 0, warningCount: 0, infoCount: 0, complete: true }, diagnoses: [], findings: [], evidence: [], deviceAssessments: [], recommendations: [], metadata: { source: `fixture-${index}.tgz`, startTime: '2026-08-26T00:00:00Z', completeTime: '2026-08-26T00:00:01Z', duration: 1, processedFiles: 1, processedLines: 1, processedEvents: 0, analyzerVersion: '1.0.0', rulePackVersion: '1.0.0', missingData: [] } });
  }
  expect(repository.listRecentAnalysisSummaries(100)).toHaveLength(20);
  expect(repository.getAnalysisResult('package-0')).toBeUndefined();
  expect(repository.getAnalysisResult('package-20')).toBeDefined();
  repository.close();
});
