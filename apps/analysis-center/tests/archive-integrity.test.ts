import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import * as tar from 'tar';
import { afterEach, describe, expect, it } from 'vitest';
import { runV1ArchiveAnalysis } from '../backend/lib/analysis/archive-analysis';
import { createDiagnosticArchiveGunzip } from '../backend/lib/analysis/tgz-stream';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe('诊断包完整性预检', () => {
  it('使用大块 gzip 输出，避免 Electron Worker 为 16 KB 小块频繁调度', async () => {
    const chunkSizes: number[] = [];
    const sink = async function* (source: AsyncIterable<Buffer>) {
      for await (const chunk of source) chunkSizes.push(chunk.length);
    };

    await pipeline(
      Readable.from([gzipSync(Buffer.alloc(2 * 1024 * 1024, 'a'))]),
      createDiagnosticArchiveGunzip(),
      sink
    );

    expect(Math.max(...chunkSizes)).toBeGreaterThan(16 * 1024);
  });

  it('截断的 tgz 在分析前提示文件不完整或已损坏', async () => {
    const root = await mkdtemp(join(tmpdir(), 'analysis-archive-integrity-'));
    directories.push(root);
    const archivePath = join(root, 'device.tgz');
    await writeFile(join(root, 'placeholder.log'), 'placeholder');
    await tar.c({ gzip: true, cwd: root, file: archivePath }, ['placeholder.log']);
    const archive = await readFile(archivePath);
    await writeFile(archivePath, archive.subarray(0, archive.length - 8));
    const runtimeTimings = {
      archiveValidationMs: 0,
      archiveExtractionMs: 0,
      sourceInventoryMs: 0,
      sourceReadMs: 0,
      pipelineAnalysisMs: 0,
      reportRenderMs: 0,
      totalMs: 0
    };

    await expect(runV1ArchiveAnalysis({ sourcePath: archivePath, extractDirectory: join(root, 'device'), runtimeTimings }))
      .rejects.toThrow('诊断包文件不完整或已损坏，请重新导出或重新下载后再导入。');
    expect(runtimeTimings.archiveValidationMs).toBeGreaterThan(0);
    expect(runtimeTimings.totalMs).toBeGreaterThanOrEqual(runtimeTimings.archiveValidationMs);
    expect(Object.values(runtimeTimings).every((duration) => duration >= 0)).toBe(true);
  });
});
