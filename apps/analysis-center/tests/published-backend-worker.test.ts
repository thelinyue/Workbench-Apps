import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import * as tar from 'tar';
import { afterEach, describe, expect, it } from 'vitest';

const executeFile = promisify(execFile);
const directories: string[] = [];
const applicationRoot = dirname(fileURLToPath(new URL('../manifest.json', import.meta.url)));
const repositoryRoot = dirname(dirname(applicationRoot));

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('发布版分析 Worker', () => {
  it('存储分析可从 ESM backend 启动 Worker 并生成 V1 诊断结果', async () => {
    await executeFile(process.execPath, ['tools/build-analysis-center.mjs'], { cwd: repositoryRoot });
    const root = await mkdtemp(join(tmpdir(), 'analysis-center-published-worker-'));
    directories.push(root);
    const sourceDirectory = join(root, 'source');
    const archivePath = join(root, 'device.tgz');
    const dataDirectory = join(root, 'data');
    await mkdir(sourceDirectory);
    await writeFile(join(sourceDirectory, 'kern'), 'nvme I/O Error: controller failed\n', 'utf8');
    await tar.c({ gzip: true, cwd: sourceDirectory, file: archivePath }, ['kern']);

    const runnerPath = join(root, 'run-published-analysis.mjs');
    await writeFile(runnerPath, createPublishedRunner({
      backendEntryUrl: pathToFileURL(join(applicationRoot, 'dist', 'backend', 'entry.js')).href,
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
});

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
