import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tar from 'tar';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceRepository } from '../backend/lib/data/workspace-repository';
import type { DiagnosticPackage } from '../backend/lib/domain/diagnostic-package';
import { AnalysisTaskService, type AnalysisWorker } from '../backend/lib/services/analysis-task-service';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe('分析任务归档校验', () => {
  it('截断的 tgz 交给 Worker 校验并持久化中文失败原因', async () => {
    const root = await mkdtemp(join(tmpdir(), 'analysis-task-preflight-'));
    directories.push(root);
    const archivePath = join(root, 'device.tgz');
    await writeFile(join(root, 'placeholder.log'), 'placeholder');
    await tar.c({ gzip: true, cwd: root, file: archivePath }, ['placeholder.log']);
    const archive = await readFile(archivePath);
    await writeFile(archivePath, archive.subarray(0, archive.length - 8));

    const repository = new WorkspaceRepository(join(root, 'analysis-center.db'));
    const item: DiagnosticPackage = {
      id: 'package-1', sourcePath: archivePath, extractPath: join(root, 'device'), displayName: 'device.tgz',
      detectedAt: new Date().toISOString(), status: 'pending', taskIds: [], caseId: 'case-1'
    };
    repository.upsertPackage(item);
    const worker = new FakeAnalysisWorker();
    let workerCount = 0;
    const service = new AnalysisTaskService(repository, { createWorker: () => { workerCount += 1; return worker; } });

    try {
      await service.enqueue(item.id);
      await vi.waitFor(() => expect(workerCount).toBe(1));
      worker.emit('message', { type: 'completed', succeeded: false, errorMessage: '诊断包文件不完整或已损坏，请重新导出或重新下载后再导入。' });

      await vi.waitFor(() => expect(repository.listTasks()).toEqual([
        expect.objectContaining({
          packageId: item.id,
          status: 'failed',
          errorMessage: '分析引擎执行失败：诊断包文件不完整或已损坏，请重新导出或重新下载后再导入。'
        })
      ]));
      const [failedTask] = repository.listTasks();
      expect(repository.getAnalysisFailure(failedTask!.id)).toMatchObject({ stage: '校验诊断包' });
    } finally {
      await service.close();
      repository.close();
    }
  });
});

class FakeAnalysisWorker extends EventEmitter implements AnalysisWorker {
  public terminate(): Promise<number> { return Promise.resolve(0); }
}
