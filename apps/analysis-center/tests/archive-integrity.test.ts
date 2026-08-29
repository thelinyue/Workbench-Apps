import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tar from 'tar';
import { afterEach, describe, expect, it } from 'vitest';
import { runV1ArchiveAnalysis } from '../backend/lib/analysis/archive-analysis';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe('诊断包完整性预检', () => {
  it('截断的 tgz 在分析前提示文件不完整或已损坏', async () => {
    const root = await mkdtemp(join(tmpdir(), 'analysis-archive-integrity-'));
    directories.push(root);
    const archivePath = join(root, 'device.tgz');
    await writeFile(join(root, 'placeholder.log'), 'placeholder');
    await tar.c({ gzip: true, cwd: root, file: archivePath }, ['placeholder.log']);
    const archive = await readFile(archivePath);
    await writeFile(archivePath, archive.subarray(0, archive.length - 8));

    await expect(runV1ArchiveAnalysis({ sourcePath: archivePath, extractDirectory: join(root, 'device') }))
      .rejects.toThrow('诊断包文件不完整或已损坏，请重新导出或重新下载后再导入。');
  });
});
