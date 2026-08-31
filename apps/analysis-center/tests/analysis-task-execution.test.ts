import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tar from 'tar';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnalysisResult } from '../backend/lib/analysis-v1/pipeline';
import { PipelineProfiler, type PipelineProfile } from '../backend/lib/analysis-v1/pipeline-profiler';
import { WorkspaceRepository } from '../backend/lib/data/workspace-repository';
import type { DiagnosticPackage } from '../backend/lib/domain/diagnostic-package';
import { AnalysisTaskService, type AnalysisWorker } from '../backend/lib/services/analysis-task-service';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe('分析任务单线程执行', () => {
  it('仅在显式开启时回传完成持久化后的 Pipeline profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'analysis-task-profile-'));
    directories.push(root);
    const repository = new WorkspaceRepository(join(root, 'analysis-center.db'));
    repository.upsertPackage(packageRecord('package-profiled', await createArchive(root, 'package-profiled')));
    const worker = new FakeAnalysisWorker();
    let workerData: Record<string, unknown> | undefined;
    let completedProfile: PipelineProfile | undefined;
    const service = new AnalysisTaskService(repository, {
      createWorker: (_url, options) => {
        workerData = options.workerData;
        return worker;
      },
      performanceProfiling: {
        onCompleted: (profile) => {
          expect(repository.getAnalysisResult('package-profiled')).toEqual(successfulResult);
          completedProfile = profile;
        }
      }
    });

    try {
      await service.enqueue('package-profiled');
      await vi.waitFor(() => expect(workerData).toMatchObject({ performanceProfiling: true }));
      worker.emit('message', {
        type: 'completed',
        succeeded: true,
        browserPath: join(root, 'result.html'),
        analysisResult: successfulResult,
        performanceProfile: new PipelineProfiler().snapshot()
      });

      await vi.waitFor(() => expect(completedProfile).toBeDefined());
      expect(completedProfile?.stages.persistence.invocations).toBe(1);
      expect(completedProfile?.stages.persistence.durationMs).toBeGreaterThanOrEqual(0);
      expect(repository.getAnalysisResult('package-profiled')).toEqual(successfulResult);
      expect(JSON.stringify(repository.getAnalysisResult('package-profiled'))).not.toContain('timerReads');
    } finally {
      await service.close();
      repository.close();
    }
  });

  it('失败后不重试并继续下一个任务，同时持久化阶段并发送成功和失败通知', async () => {
    const root = await mkdtemp(join(tmpdir(), 'analysis-task-execution-'));
    directories.push(root);
    const repository = new WorkspaceRepository(join(root, 'analysis-center.db'));
    repository.upsertPackage(packageRecord('package-fails', await createArchive(root, 'package-fails')));
    repository.upsertPackage(packageRecord('package-succeeds', await createArchive(root, 'package-succeeds')));
    const workers: FakeAnalysisWorker[] = [];
    const workerInputs: Array<Record<string, unknown>> = [];
    const notifications: unknown[] = [];
    const service = new AnalysisTaskService(repository, {
      createWorker: (_url, options) => { const worker = new FakeAnalysisWorker(); workers.push(worker); workerInputs.push(options.workerData); return worker; },
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
      expect(workerInputs.every((input) => !Object.hasOwn(input, 'performanceProfiling'))).toBe(true);
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

  it('仅对达到十秒的成功任务输出一次不含源路径的中文分段耗时', async () => {
    const root = await mkdtemp(join(tmpdir(), 'analysis-task-slow-warning-'));
    directories.push(root);
    const repository = new WorkspaceRepository(join(root, 'analysis-center.db'));
    repository.upsertPackage(packageRecord('package-fast', await createArchive(root, 'package-fast')));
    repository.upsertPackage(packageRecord('package-slow', await createArchive(root, 'package-slow')));
    const workers: FakeAnalysisWorker[] = [];
    const warnings: string[] = [];
    const service = new AnalysisTaskService(repository, {
      createWorker: () => { const worker = new FakeAnalysisWorker(); workers.push(worker); return worker; },
      logger: { warn: (message) => warnings.push(message) }
    });

    try {
      await service.enqueue('package-fast');
      await vi.waitFor(() => expect(workers).toHaveLength(1));
      workers[0]!.emit('message', { type: 'completed', succeeded: true, browserPath: join(root, 'fast.html'), analysisResult: successfulResult, runtimeTimings: runtimeTimings(9_999) });
      await vi.waitFor(() => expect(repository.getPackage('package-fast')?.status).toBe('report-ready'));

      await service.enqueue('package-slow');
      await vi.waitFor(() => expect(workers).toHaveLength(2));
      workers[1]!.emit('message', { type: 'completed', succeeded: true, browserPath: join(root, 'slow.html'), analysisResult: successfulResult, runtimeTimings: runtimeTimings(10_000) });
      await vi.waitFor(() => expect(repository.getPackage('package-slow')?.status).toBe('report-ready'));

      expect(repository.listTasks().find((task) => task.packageId === 'package-slow')?.runtimeTimings).toEqual(runtimeTimings(10_000));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('分析任务耗时异常');
      expect(warnings[0]).toContain('诊断包=package-slow.tgz');
      expect(warnings[0]).toContain('状态=成功');
      expect(warnings[0]).toContain('大小=1024 字节');
      expect(warnings[0]).toContain('总耗时=10000.000 ms');
      expect(warnings[0]).toContain('完整性校验=100.000 ms');
      expect(warnings[0]).not.toContain(root);
    } finally {
      await service.close();
      repository.close();
    }
  });

  it('慢失败任务输出失败状态并保留原有中文失败持久化', async () => {
    const root = await mkdtemp(join(tmpdir(), 'analysis-task-slow-failure-'));
    directories.push(root);
    const repository = new WorkspaceRepository(join(root, 'analysis-center.db'));
    repository.upsertPackage(packageRecord('package-fails-slowly', await createArchive(root, 'package-fails-slowly')));
    const worker = new FakeAnalysisWorker();
    const warnings: string[] = [];
    const service = new AnalysisTaskService(repository, {
      createWorker: () => worker,
      logger: { warn: (message) => warnings.push(message) }
    });

    try {
      await service.enqueue('package-fails-slowly');
      await vi.waitFor(() => expect(repository.getPackage('package-fails-slowly')?.status).toBe('running'));
      worker.emit('message', { type: 'completed', succeeded: false, errorMessage: '无法解压诊断包：归档损坏', runtimeTimings: runtimeTimings(12_000) });
      await vi.waitFor(() => expect(repository.getPackage('package-fails-slowly')?.status).toBe('failed'));

      expect(repository.listTasks()).toEqual([
        expect.objectContaining({
          status: 'failed',
          errorMessage: '分析引擎执行失败：无法解压诊断包：归档损坏',
          runtimeTimings: runtimeTimings(12_000)
        })
      ]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('诊断包=package-fails-slowly.tgz');
      expect(warnings[0]).toContain('状态=失败');
      expect(warnings[0]).not.toContain(root);
    } finally {
      await service.close();
      repository.close();
    }
  });

  it('慢任务日志输出失败不改变成功状态且队列继续执行', async () => {
    const root = await mkdtemp(join(tmpdir(), 'analysis-task-warning-failure-'));
    directories.push(root);
    const repository = new WorkspaceRepository(join(root, 'analysis-center.db'));
    repository.upsertPackage(packageRecord('package-slow', await createArchive(root, 'package-slow')));
    repository.upsertPackage(packageRecord('package-next', await createArchive(root, 'package-next')));
    const workers: FakeAnalysisWorker[] = [];
    const service = new AnalysisTaskService(repository, {
      createWorker: () => { const worker = new FakeAnalysisWorker(); workers.push(worker); return worker; },
      logger: { warn: () => { throw new Error('日志输出不可用'); } }
    });

    try {
      await service.enqueue('package-slow');
      await service.enqueue('package-next');
      await vi.waitFor(() => expect(workers).toHaveLength(1));
      workers[0]!.emit('message', { type: 'completed', succeeded: true, browserPath: join(root, 'slow.html'), analysisResult: successfulResult, runtimeTimings: runtimeTimings(10_000) });

      await vi.waitFor(() => expect(workers).toHaveLength(2));
      expect(repository.getPackage('package-slow')?.status).toBe('report-ready');
      workers[1]!.emit('message', { type: 'completed', succeeded: true, browserPath: join(root, 'next.html'), analysisResult: successfulResult, runtimeTimings: runtimeTimings(9_999) });
      await vi.waitFor(() => expect(repository.getPackage('package-next')?.status).toBe('report-ready'));
    } finally {
      await service.close();
      repository.close();
    }
  });
});

class FakeAnalysisWorker extends EventEmitter implements AnalysisWorker {
  public terminate(): Promise<number> { return Promise.resolve(0); }
}

async function createArchive(root: string, id: string): Promise<string> {
  const sourceDirectory = join(root, `${id}-source`);
  await mkdir(sourceDirectory);
  await writeFile(join(sourceDirectory, 'placeholder.log'), 'placeholder');
  const archivePath = join(root, `${id}.tgz`);
  await tar.c({ gzip: true, cwd: sourceDirectory, file: archivePath }, ['placeholder.log']);
  return archivePath;
}

function packageRecord(id: string, sourcePath: string): DiagnosticPackage {
  return {
    id,
    sourcePath,
    extractPath: `D:/data/${id}`,
    displayName: `${id}.tgz`,
    sourceSizeBytes: 1024,
    detectedAt: '2026-08-28T00:00:00.000Z',
    status: 'pending',
    taskIds: [],
    caseId: `case-${id}`
  };
}

function runtimeTimings(totalMs: number) {
  return {
    archiveValidationMs: 100,
    archiveExtractionMs: 200,
    sourceInventoryMs: 300,
    sourceReadMs: 400,
    pipelineAnalysisMs: 500,
    reportRenderMs: 600,
    totalMs
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
