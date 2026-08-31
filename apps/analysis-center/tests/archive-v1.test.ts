import { createWriteStream } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import * as tar from 'tar';
import yazl from 'yazl';
import { afterEach, expect, it } from 'vitest';
import { runV1ArchiveAnalysis } from '../backend/lib/analysis/archive-analysis';
import { PipelineProfiler } from '../backend/lib/analysis-v1/pipeline-profiler';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

it('归档分析返回 V1 AnalysisResult，而不是旧关键词报告模型', async () => {
  const root = await mkdtemp(join(tmpdir(), 'analysis-v1-archive-'));
  directories.push(root);
  await writeFile(join(root, 'kern.log'), '2026-08-26T03:12:01+08:00 kernel: blk_update_request: I/O error, dev sdc, sector 1');
  await writeFile(join(root, 'mdstat.log'), 'md0 : active raid1 sdc2[1](F) sdb2[0]\n      100 blocks [2/1] [U_]');
  await writeFile(join(root, 'sysinfo.json'), JSON.stringify({ disk: { devices: [{ disk_info: { dev_name: '/dev/sdc', label: 'Hard Drive 3', serial: 'SERIAL-003', used_for: 'Storage Pool 3' }, smart_info: { report: [{ id: 197, name: 'Current_Pending_Sector', raw: 2 }] } }] } }));
  const archivePath = join(root, 'fixture.tgz');
  await tar.c({ gzip: true, file: archivePath, cwd: root }, ['kern.log', 'mdstat.log', 'sysinfo.json']);

  const progress: Array<{ progress: number; stage: string; message: string }> = [];
  const result = await runV1ArchiveAnalysis({ sourcePath: archivePath, extractDirectory: join(root, 'extracted'), onProgress: (update) => progress.push(update) });

  expect(result.result.diagnoses[0]).toMatchObject({ id: 'storage.device.suspected_failure', primaryResource: '/dev/sdc' });
  expect(result.browserPath).toContain('analysis-result.html');
  const html = await readFile(result.browserPath, 'utf8');
  expect(html).toContain('硬盘 3（序列号：SERIAL-003）：检测到多次读写错误（I/O Error）；硬盘健康信息存在异常。');
  expect(html).toContain('white-space:pre-line');
  expect(html).toContain('RAID 阵列已降级');
  expect(html).toContain('技术事件：raid.degraded');
  expect(html).not.toContain('技术事件：storage.io_error');
  expect(html).toContain('建议：');
  expect(progress.map((item) => item.message)).toEqual(expect.arrayContaining([
    '正在读取日志（3/3）',
    '正在解析日志（3/3）'
  ]));
  expect(progress.every((item, index) => index === 0 || item.progress >= progress[index - 1].progress)).toBe(true);
  expect([...new Set(progress.map((item) => item.stage))]).toEqual([
    'identify-package',
    'parse-system-events',
    'analyze-storage',
    'aggregate-anomalies',
    'form-conclusion'
  ]);
});

it('V1 分析会解压并读取 gzip 轮转内核日志', async () => {
  const root = await mkdtemp(join(tmpdir(), 'analysis-v1-gzip-'));
  directories.push(root);
  const kernelLog = [
    '2026-08-19T12:28:41.100000+08:00 host kernel: ata2.00: failed command: READ FPDMA QUEUED',
    '2026-08-19T12:28:41.110000+08:00 host kernel: ata2.00: error: { UNC }',
    '2026-08-19T12:28:41.120000+08:00 host kernel: critical medium error, dev sda, sector 32000008'
  ].join('\n');
  await writeFile(join(root, 'kern.log.1.gz'), gzipSync(kernelLog));
  await writeFile(join(root, 'mdstat.log'), 'md1 : active raid5 sdb2[0] sdd2[3] sdc2[2]\n      100 blocks [4/3] [U_UU]');
  await writeFile(join(root, 'sysinfo.json'), JSON.stringify({ disk: { devices: [{
    disk_info: { dev_name: '/dev/sda', label: 'Hard Drive 2', slot: 'ata2', used_for: 'Unused' },
    smart_info: { report: [] }
  }] } }));
  const archivePath = join(root, 'fixture.tgz.temp');
  await tar.c({ gzip: true, file: archivePath, cwd: root }, ['kern.log.1.gz', 'mdstat.log', 'sysinfo.json']);
  const extractDirectory = join(root, 'extracted');
  await mkdir(extractDirectory);
  const existingPath = join(extractDirectory, 'existing-user-file.txt');
  const existingKernelLogPath = join(extractDirectory, 'kern.log');
  await writeFile(existingPath, 'keep');
  await writeFile(existingKernelLogPath, '2026-08-26T03:13:01+08:00 kernel: Buffer I/O error on dev sdz');

  const result = await runV1ArchiveAnalysis({ sourcePath: archivePath, extractDirectory });

  expect(result.result.metadata.processedFiles).toBe(4);
  expect(result.result.diagnoses[0]).toMatchObject({ id: 'storage.device.media_failure', primaryResource: '/dev/sda' });
  expect(result.result.findings).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'storage.io_error', affectedResources: expect.arrayContaining(['/dev/sdz']) })]));
  await expect(access(archivePath)).resolves.toBeUndefined();
  await expect(readFile(existingPath, 'utf8')).resolves.toBe('keep');
});

it('V1 分析识别真实 ZIP 的设备前缀日志，并忽略未知 xlog', async () => {
  const root = await mkdtemp(join(tmpdir(), 'analysis-v1-prefixed-zip-'));
  directories.push(root);
  const archivePath = join(root, 'nas_server_log_fixture.zip');
  await createZip(archivePath, [
    { name: 'DEVICE_20260830192714_syslog', content: '2026-08-30T19:27:14+08:00 kernel: Buffer I/O error on dev sdc' },
    { name: 'DEVICE_20260830193155_dmsg.log.gz', content: gzipSync('2026-08-30T19:31:55+08:00 kernel: Buffer I/O error on dev sdd') },
    { name: 'ai_engine_crash.xlog.gz', content: gzipSync('2026-08-30T19:32:00+08:00 kernel: Buffer I/O error on dev sdz') }
  ]);

  const output = await runV1ArchiveAnalysis({ sourcePath: archivePath, extractDirectory: join(root, 'extracted'), profiler: new PipelineProfiler() });

  expect(output.result.metadata.processedFiles).toBe(2);
  expect(output.result.metadata.analyzerVersion).toBe('1.1.0');
  expect(output.result.findings).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'storage.io_error', affectedResources: ['/dev/sdc'] }),
    expect.objectContaining({ type: 'storage.io_error', affectedResources: ['/dev/sdd'] })
  ]));
  expect(output.result.findings).not.toEqual(expect.arrayContaining([
    expect.objectContaining({ affectedResources: expect.arrayContaining(['/dev/sdz']) })
  ]));
  expect(output.performanceProfile?.counters).toMatchObject({
    fileInventoryPasses: 1,
    filesDiscovered: 3,
    filesIgnored: 1,
    filesRead: 2,
    linesProcessed: 2,
    eventsCreated: 2,
    findingsCreated: 2,
    evidenceRetained: 2
  });
  expect(output.performanceProfile?.files.map((file) => file.alias)).toEqual(['kernel-01', 'kernel-02']);
  expect(JSON.stringify(output.performanceProfile)).not.toContain('DEVICE');
  expect(output.performanceProfile?.stages['archive.extract'].invocations).toBe(1);
  expect(output.performanceProfile?.stages['source.read'].invocations).toBe(1);
  expect(output.performanceProfile?.stages['parser.total'].invocations).toBeGreaterThan(0);
  expect(output.performanceProfile?.stages['rules.event.total'].invocations).toBeGreaterThan(0);
  expect(output.performanceProfile?.stages['finding.aggregate'].invocations).toBe(1);
  expect(output.performanceProfile?.stages['diagnosis.compose'].invocations).toBe(1);
  expect(output.performanceProfile?.stages['recommendation.compose'].invocations).toBe(1);
  expect(output.performanceProfile?.stages['report.render'].invocations).toBe(1);

  const ordinaryOutput = await runV1ArchiveAnalysis({ sourcePath: archivePath, extractDirectory: join(root, 'ordinary-extracted') });
  expect(ordinaryOutput.performanceProfile).toBeUndefined();
  expect(normalizeRuntimeFields(ordinaryOutput.result)).toEqual(normalizeRuntimeFields(output.result));
});

it('V1 分析在解压目标不是目录时返回中文错误', async () => {
  const root = await mkdtemp(join(tmpdir(), 'analysis-v1-invalid-extract-'));
  directories.push(root);
  const archivePath = join(root, 'fixture.tgz');
  await writeFile(join(root, 'placeholder.log'), 'placeholder');
  await tar.c({ gzip: true, file: archivePath, cwd: root }, ['placeholder.log']);
  const extractPath = join(root, 'device');
  await writeFile(extractPath, 'not-a-directory');

  await expect(runV1ArchiveAnalysis({ sourcePath: archivePath, extractDirectory: extractPath })).rejects.toThrow('无法准备诊断包解压目录');
});

async function createZip(archivePath: string, files: Array<{ name: string; content: string | Buffer }>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const zip = new yazl.ZipFile();
    zip.outputStream.pipe(createWriteStream(archivePath)).on('close', resolve).on('error', reject);
    for (const file of files) zip.addBuffer(Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content), file.name);
    zip.end();
  });
}

function normalizeRuntimeFields(result: Awaited<ReturnType<typeof runV1ArchiveAnalysis>>['result']) {
  return {
    ...result,
    id: '<runtime>',
    metadata: {
      ...result.metadata,
      startTime: '<runtime>',
      completeTime: '<runtime>',
      duration: 0
    }
  };
}
