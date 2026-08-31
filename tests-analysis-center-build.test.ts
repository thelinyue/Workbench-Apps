import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import yazl from 'yazl';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const directories: string[] = [];

afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe('分析中心 renderer 构建产物', () => {
  it('为 workbench-app 协议生成指向根 assets 目录的相对资源路径', async () => {
    await execFileAsync(process.execPath, ['tools/build-analysis-center.mjs'], { cwd: process.cwd() });
    const html = await readFile('apps/analysis-center/dist/renderer/index.html', 'utf8');

    expect(html).toMatch(/src="\.\.\/assets\/[^\"]+\.js"/);
    expect(html).toMatch(/href="\.\.\/assets\/[^\"]+\.css"/);
    expect(html).not.toContain('src="/assets/');
    expect(html).not.toContain('href="/assets/');
  }, 30_000);
});

describe('分析中心性能基准命令', () => {
  it('从根脚本接收输入和输出参数并生成两种报告', async () => {
    const root = await mkdtemp(join(tmpdir(), 'analysis-benchmark-command-'));
    directories.push(root);
    const archivePath = join(root, 'nas_server_log_fixture.zip');
    const outputDirectory = join(root, 'report');
    await createZip(archivePath, 'DEVICE_20260831170000_syslog', 'kernel: Buffer I/O error on dev sdc');
    const command = process.platform === 'win32'
      ? { file: 'cmd.exe', args: ['/d', '/s', '/c', `npm.cmd run benchmark:analysis-center -- --input ${archivePath} --output ${outputDirectory}`] }
      : { file: 'npm', args: ['run', 'benchmark:analysis-center', '--', '--input', archivePath, '--output', outputDirectory] };

    await execFileAsync(command.file, command.args, { cwd: process.cwd() });

    const json = JSON.parse(await readFile(join(outputDirectory, 'analysis-center-pipeline-baseline-2026-08-30.json'), 'utf8')) as { measuredRuns: number; semanticEquivalence: { equivalent: boolean } };
    const markdown = await readFile(join(outputDirectory, 'analysis-center-pipeline-baseline-2026-08-30.md'), 'utf8');
    expect(json).toMatchObject({ measuredRuns: 5, semanticEquivalence: { equivalent: true } });
    expect(markdown).toContain('分阶段耗时');
  }, 30_000);
});

async function createZip(archivePath: string, name: string, content: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const zip = new yazl.ZipFile();
    zip.outputStream.pipe(createWriteStream(archivePath)).on('close', resolve).on('error', reject);
    zip.addBuffer(Buffer.from(content), name);
    zip.end();
  });
}
