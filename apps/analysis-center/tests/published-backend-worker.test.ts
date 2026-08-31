import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { Worker } from 'node:worker_threads';
import extractZip from 'extract-zip';
import * as tar from 'tar';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

const executeFile = promisify(execFile);
const directories: string[] = [];
const applicationRoot = dirname(fileURLToPath(new URL('../manifest.json', import.meta.url)));
const repositoryRoot = dirname(dirname(applicationRoot));

beforeAll(async () => {
  await executeFile(process.execPath, ['tools/build-analysis-center.mjs'], { cwd: repositoryRoot });
}, 20_000);

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('发布版分析 Worker', () => {
  it('存储分析可从 ESM backend 启动 Worker 并生成 V1 诊断结果', async () => {
    const root = await mkdtemp(join(tmpdir(), 'analysis-center-published-worker-'));
    directories.push(root);
    const manifest = JSON.parse(await readFile(join(applicationRoot, 'manifest.json'), 'utf8')) as { version: string };
    const packageRoot = join(root, 'package');
    await extractZip(join(applicationRoot, 'dist', `analysis-center-v${manifest.version}.zip`), { dir: packageRoot });
    const packageEntries = await readdir(packageRoot, { recursive: true });
    expect(packageEntries.some((entry) => entry.split(/[\\/]/).includes('node_modules'))).toBe(false);
    const publishedWorker = await readFile(join(packageRoot, 'backend', 'analysis-worker.js'), 'utf8');
    expect(publishedWorker).not.toMatch(/(?:from|import)\s*["']tar["']/);
    expect(publishedWorker).not.toMatch(/require\(\s*["']tar["']\s*\)/);
    const sourceDirectory = join(root, 'source');
    const archivePath = join(root, 'device.tgz');
    const dataDirectory = join(root, 'data');
    await mkdir(sourceDirectory);
    await writeFile(join(sourceDirectory, 'kern'), 'nvme I/O Error: controller failed\n', 'utf8');
    await tar.c({ gzip: true, cwd: sourceDirectory, file: archivePath }, ['kern']);

    const runnerPath = join(root, 'run-published-analysis.mjs');
    await writeFile(runnerPath, createPublishedRunner({
      backendEntryUrl: pathToFileURL(join(packageRoot, 'backend', 'entry.js')).href,
      archivePath,
      dataDirectory
    }), 'utf8');
    const { stdout } = await executeFile(process.execPath, [runnerPath]);
    const result = JSON.parse(stdout) as { task: { scope: string; status: string; message: string }; reportPath?: string; diagnosis?: { schemaVersion: number } };
    const task = result.task;
    expect(task).toMatchObject({ scope: 'storage', status: 'succeeded', message: '诊断结果已完成' });
    expect(result.diagnosis).toEqual({ schemaVersion: 1 });
    await expect(import('node:fs/promises').then(({ access }) => access(result.reportPath!))).resolves.toBeUndefined();
  }, 20_000);

  it('成功和校验失败消息都携带非负的轻量阶段耗时', async () => {
    const root = await mkdtemp(join(tmpdir(), 'analysis-center-published-timings-'));
    directories.push(root);
    const manifest = JSON.parse(await readFile(join(applicationRoot, 'manifest.json'), 'utf8')) as { version: string };
    const packageRoot = join(root, 'package');
    await extractZip(join(applicationRoot, 'dist', `analysis-center-v${manifest.version}.zip`), { dir: packageRoot });
    const sourceDirectory = join(root, 'source');
    const archivePath = join(root, 'device.tgz');
    await mkdir(sourceDirectory);
    await writeFile(join(sourceDirectory, 'kern'), 'nvme I/O Error: controller failed\n', 'utf8');
    await tar.c({ gzip: true, cwd: sourceDirectory, file: archivePath }, ['kern']);
    const workerPath = join(packageRoot, 'backend', 'analysis-worker.js');

    const succeeded = await runPublishedWorker(workerPath, archivePath, join(root, 'success-extract'));
    expect(succeeded.succeeded).toBe(true);
    expectRuntimeTimings(succeeded.runtimeTimings);

    const archive = await readFile(archivePath);
    const brokenArchivePath = join(root, 'broken.tgz');
    await writeFile(brokenArchivePath, archive.subarray(0, archive.length - 8));
    const failed = await runPublishedWorker(workerPath, brokenArchivePath, join(root, 'failure-extract'));
    expect(failed).toMatchObject({ succeeded: false, errorMessage: '诊断包文件不完整或已损坏，请重新导出或重新下载后再导入。' });
    expectRuntimeTimings(failed.runtimeTimings);
    expect(failed.runtimeTimings?.archiveValidationMs).toBeGreaterThan(0);
  }, 20_000);
});

interface PublishedWorkerCompletedMessage {
  type?: 'completed';
  succeeded?: boolean;
  errorMessage?: string;
  runtimeTimings?: Record<string, number>;
}

async function runPublishedWorker(workerPath: string, sourcePath: string, extractDirectory: string): Promise<PublishedWorkerCompletedMessage> {
  const worker = new Worker(pathToFileURL(workerPath), { workerData: { sourcePath, extractDirectory } });
  return new Promise((resolve, reject) => {
    worker.on('message', (message: PublishedWorkerCompletedMessage) => {
      if (message.type === 'completed') resolve(message);
    });
    worker.once('error', reject);
    worker.once('exit', (code) => { if (code !== 0) reject(new Error(`发布版分析 Worker 异常退出：${code}`)); });
  });
}

function expectRuntimeTimings(timings: Record<string, number> | undefined): void {
  expect(timings).toMatchObject({
    archiveValidationMs: expect.any(Number),
    archiveExtractionMs: expect.any(Number),
    sourceInventoryMs: expect.any(Number),
    sourceReadMs: expect.any(Number),
    pipelineAnalysisMs: expect.any(Number),
    reportRenderMs: expect.any(Number),
    totalMs: expect.any(Number)
  });
  expect(Object.values(timings ?? {}).every((duration) => duration >= 0)).toBe(true);
}

function createPublishedRunner(input: { backendEntryUrl: string; archivePath: string; dataDirectory: string }): string {
  return `import { createAppBackend } from ${JSON.stringify(input.backendEntryUrl)};

const backend = createAppBackend({ appId: 'analysis-center', dataDirectory: ${JSON.stringify(input.dataDirectory)}, manifest: {}, emit: () => undefined });
const diagnosticPackage = await backend.invoke('packages.import', { sourcePath: ${JSON.stringify(input.archivePath)} });
await backend.invoke('analysis.start', { packageId: diagnosticPackage.id, scope: 'storage' });
const deadline = Date.now() + 10_000;
let task;
while (Date.now() < deadline) {
  [task] = await backend.invoke('tasks.list', null);
  if (task?.status === 'succeeded' || task?.status === 'failed') break;
  await new Promise((resolve) => setTimeout(resolve, 25));
}
const [diagnosticPackageResult] = await backend.invoke('packages.list', null);
const diagnosis = await backend.invoke('results.get', { packageId: diagnosticPackage.id });
await backend.close();
if (!task) throw new Error('等待发布版存储分析任务完成超时');
process.stdout.write(JSON.stringify({ task, reportPath: diagnosticPackageResult.reportPath, diagnosis: diagnosis ? { schemaVersion: diagnosis.schemaVersion } : undefined }));
`;
}
