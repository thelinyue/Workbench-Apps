import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnalysisResult } from '../backend/lib/analysis-v1/pipeline';
import { WorkspaceRepository } from '../backend/lib/data/workspace-repository';
import type { DiagnosticPackage } from '../backend/lib/domain/diagnostic-package';
import { AnalysisTaskService, type AnalysisWorker } from '../backend/lib/services/analysis-task-service';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe('分析任务单线程执行', () => {
  it('失败后不重试并继续下一个任务，同时持久化阶段并发送成功和失败通知', async () => {
    const root = await mkdtemp(join(tmpdir(), 'analysis-task-execution-'));
    directories.push(root);
    const repository = new WorkspaceRepository(join(root, 'analysis-center.db'));
    repository.upsertPackage(packageRecord('package-fails'));
    repository.upsertPackage(packageRecord('package-succeeds'));
    const workers: FakeAnalysisWorker[] = [];
    const notifications: unknown[] = [];
    const service = new AnalysisTaskService(repository, {
      createWorker: () => { const worker = new FakeAnalysisWorker(); workers.push(worker); return worker; },
      notify: (notification) => notifications.push(notification)
    });

    try {
      await service.enqueue('package-fails');
      await service.enqueue('package-succeeds');
      await vi.waitFor(() => expect(workers).toHaveLength(1));

      workers[0]!.emit('message', { type: 'completed', succeeded: false, errorMessage: '无法解压诊断包：归档损坏' });
      await vi.waitFor(() => expect(workers).toHaveLength(2));
      expect(repository.getPackage('package-fails')?.status).toBe('failed');
      expect(repository.getPackage('package-succeeds')?.status).toBe('running');

      workers[1]!.emit('message', { type: 'progress', progress: 60, stage: 'analyze-storage', message: '正在分析存储状态' });
      await vi.waitFor(() => expect(repository.listTasks().find((task) => task.packageId === 'package-succeeds')).toMatchObject({ stage: 'analyze-storage', progress: 60 }));
      workers[1]!.emit('message', { type: 'completed', succeeded: true, browserPath: join(root, 'result.html'), analysisResult: successfulResult });
      await vi.waitFor(() => expect(repository.getPackage('package-succeeds')?.status).toBe('report-ready'));

      expect(workers).toHaveLength(2);
      expect(notifications).toEqual([
        {
          title: '分析失败',
          body: 'package-fails.tgz：分析引擎执行失败：无法解压诊断包：归档损坏',
          windowKey: 'main',
          activationPayload: { kind: 'failure', packageId: 'package-fails' }
        },
        {
          title: '分析完成',
          body: 'package-succeeds.tgz：未发现明确异常',
          windowKey: 'main',
          activationPayload: { kind: 'result', packageId: 'package-succeeds' }
        }
      ]);
    } finally {
      await service.close();
      repository.close();
    }
  });
});

class FakeAnalysisWorker extends EventEmitter implements AnalysisWorker {
  public terminate(): Promise<number> { return Promise.resolve(0); }
}

function packageRecord(id: string): DiagnosticPackage {
  return {
    id,
    sourcePath: `D:/Inbox/${id}.tgz`,
    extractPath: `D:/data/${id}`,
    displayName: `${id}.tgz`,
    sourceSizeBytes: 1024,
    detectedAt: '2026-08-28T00:00:00.000Z',
    status: 'pending',
    taskIds: [],
    caseId: `case-${id}`
  };
}

const successfulResult: AnalysisResult = {
  schemaVersion: 1,
  id: 'analysis-success',
  status: 'completed',
  summary: { criticalCount: 0, warningCount: 0, infoCount: 0, complete: true },
  diagnoses: [],
  findings: [],
  evidence: [],
  deviceAssessments: [],
  recommendations: [],
  metadata: {
    source: 'package-succeeds.tgz',
    startTime: '2026-08-28T00:00:00.000Z',
    completeTime: '2026-08-28T00:00:01.000Z',
    duration: 1000,
    processedFiles: 1,
    processedLines: 1,
    processedEvents: 0,
    analyzerVersion: '1.0.0',
    rulePackVersion: '1.0.0',
    missingData: []
  }
};
