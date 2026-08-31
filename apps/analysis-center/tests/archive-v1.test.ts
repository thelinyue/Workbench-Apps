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
  await writeFile(join(root, 'syslog'), 'UPS ups0@localhost on battery');
  const archivePath = join(root, 'fixture.tgz');
  await tar.c({ gzip: true, file: archivePath, cwd: root }, ['kern.log', 'mdstat.log', 'sysinfo.json', 'syslog']);

  const progress: Array<{ progress: number; stage: string; message: string }> = [];
  const result = await runV1ArchiveAnalysis({ sourcePath: archivePath, extractDirectory: join(root, 'extracted'), onProgress: (update) => progress.push(update) });

  expect(result.result.diagnoses[0]).toMatchObject({ id: 'format-rule.tgz.summary', title: 'TGZ 规则发现异常' });
  expect(result.browserPath).toContain('analysis-result.html');
  const html = await readFile(result.browserPath, 'utf8');
  expect(html).toContain('TGZ 专用规则检测到');
  expect(html).toContain('规则包：tgz@2026.08.26');
  expect(html).toContain('UPS 已切换至电池供电，说明外部输入曾出现异常');
  expect(html).toContain('white-space:pre-line');
  expect(progress.map((item) => item.message)).toEqual(expect.arrayContaining([
    '正在读取日志（4/4）'
  ]));
  expect(progress.every((item, index) => index === 0 || item.progress >= progress[index - 1].progress)).toBe(true);
  expect([...new Set(progress.map((item) => item.stage))]).toEqual([
    'identify-package',
    'parse-system-events',
    'analyze-storage',
    'aggregate-anomalies',
    'form-conclusion'
  ]);
  expect(result.runtimeTimings).toMatchObject({
    archiveValidationMs: expect.any(Number),
    archiveExtractionMs: expect.any(Number),
    sourceInventoryMs: expect.any(Number),
    sourceReadMs: expect.any(Number),
    pipelineAnalysisMs: expect.any(Number),
    reportRenderMs: expect.any(Number),
    totalMs: expect.any(Number)
  });
  expect(Object.values(result.runtimeTimings).every((duration) => duration >= 0)).toBe(true);
  expect(result.runtimeTimings.archiveValidationMs).toBeGreaterThan(0);
  expect(result.runtimeTimings.totalMs).toBeGreaterThanOrEqual(result.runtimeTimings.archiveValidationMs);
});

it('V1 分析保留 gzip 轮转日志但不读取其内容，并保留既有非 gzip 文件', async () => {
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

  expect(result.result.metadata.processedFiles).toBe(5);
  expect(result.result.metadata.rulePackVersion).toBe('tgz@2026.08.26');
  expect(result.result.findings).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'format-rule.tgz.sysinfo.json', title: '硬盘信息' })
  ]));
  await expect(access(join(extractDirectory, 'kern.log.1.gz'))).resolves.toBeUndefined();
  await expect(access(archivePath)).resolves.toBeUndefined();
  await expect(readFile(existingPath, 'utf8')).resolves.toBe('keep');
});

it('V1 分析识别真实 ZIP 的设备前缀日志，并忽略未知 xlog', async () => {
  const root = await mkdtemp(join(tmpdir(), 'analysis-v1-prefixed-zip-'));
  directories.push(root);
  const archivePath = join(root, 'nas_server_log_fixture.zip');
  await createZip(archivePath, [
    { name: 'DEVICE_20260830192714_syslog', content: '2026-08-30T19:27:14+08:00 UPS ups0@localhost on battery' },
    { name: 'DEVICE_20260830193155_dmsg.log.gz', content: gzipSync('2026-08-30T19:31:55+08:00 nvme nvme0: Device not ready; aborting reset') },
    { name: 'ai_engine_crash.xlog.gz', content: gzipSync('2026-08-30T19:32:00+08:00 kernel: Buffer I/O error on dev sdz') }
  ]);

  const output = await runV1ArchiveAnalysis({ sourcePath: archivePath, extractDirectory: join(root, 'extracted'), profiler: new PipelineProfiler() });

  expect(output.result.metadata.processedFiles).toBe(3);
  expect(output.result.metadata.analyzerVersion).toBe('1.2.0');
  expect(output.result.metadata.rulePackVersion).toBe('zip@2026.08.26');
  expect(output.result.findings).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'format-rule.zip.zip_syslog', title: 'UPS 已切换至电池供电' }),
    expect.objectContaining({ type: 'format-rule.zip.zip_dmsg', title: 'NVMe 设备未就绪，重置已中止' })
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
  expect(output.performanceProfile?.files.map((file) => file.alias)).toEqual(['format-rule-01', 'format-rule-02']);
  expect(JSON.stringify(output.performanceProfile)).not.toContain('DEVICE');
  expect(output.performanceProfile?.stages['archive.extract'].invocations).toBe(1);
  expect(output.performanceProfile?.stages['source.read'].invocations).toBe(1);
  expect(output.performanceProfile?.stages['diagnosis.compose'].invocations).toBe(1);
  expect(output.performanceProfile?.stages['report.render'].invocations).toBe(1);

  const ordinaryOutput = await runV1ArchiveAnalysis({ sourcePath: archivePath, extractDirectory: join(root, 'ordinary-extracted') });
  expect(ordinaryOutput.performanceProfile).toBeUndefined();
  expect(normalizeRuntimeFields(ordinaryOutput.result)).toEqual(normalizeRuntimeFields(output.result));
});

it('ZIP 仅包含 dmsg gzip 日志时使用 ZIP 规则并正常完成分析', async () => {
  const root = await mkdtemp(join(tmpdir(), 'analysis-v1-zip-dmsg-only-'));
  directories.push(root);
  const archivePath = join(root, 'nas_server_log_dmsg_only.zip');
  await createZip(archivePath, [
    { name: 'DEVICE_20260830193155_dmsg.log.gz', content: gzipSync('nvme nvme0: Device not ready; aborting reset\n') }
  ]);

  const output = await runV1ArchiveAnalysis({ sourcePath: archivePath, extractDirectory: join(root, 'extracted') });

  expect(output.result.status).toBe('completed');
  expect(output.result.metadata.rulePackVersion).toBe('zip@2026.08.26');
  expect(output.result.findings).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'format-rule.zip.zip_dmsg', title: 'NVMe 设备未就绪，重置已中止' })
  ]));
  expect(output.result.evidence[0]).toMatchObject({
    sourceFile: 'DEVICE_20260830193155_dmsg.log.gz',
    rawMessage: 'nvme nvme0: Device not ready; aborting reset'
  });
});

it('TGZ 使用 TGZ 规则，ZIP 专用文件名不会被 TGZ 规则接受', async () => {
  const root = await mkdtemp(join(tmpdir(), 'analysis-v1-format-isolation-'));
  directories.push(root);
  const archivePath = join(root, 'fixture.tgz');
  await writeFile(join(root, 'syslog'), 'UPS ups0@localhost on battery\n', 'utf8');
  await tar.c({ gzip: true, file: archivePath, cwd: root }, ['syslog']);

  const output = await runV1ArchiveAnalysis({ sourcePath: archivePath, extractDirectory: join(root, 'tgz-extracted') });
  expect(output.result.metadata.rulePackVersion).toBe('tgz@2026.08.26');
  expect(output.result.findings).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'format-rule.tgz.syslog', title: 'UPS 已切换至电池供电，说明外部输入曾出现异常' })
  ]));

  const zipPath = join(root, 'nas_server_log_wrong-name.zip');
  await createZip(zipPath, [{ name: 'syslog', content: 'UPS ups0@localhost on battery\n' }]);
  await expect(runV1ArchiveAnalysis({ sourcePath: zipPath, extractDirectory: join(root, 'zip-extracted') }))
    .rejects.toThrow('无法识别日志包：未找到受支持的系统或存储日志');
});

it('V1 分析拒绝 ZIP 中的符号链接条目', async () => {
  const root = await mkdtemp(join(tmpdir(), 'analysis-v1-zip-symlink-'));
  directories.push(root);
  const archivePath = join(root, 'nas_server_log_symlink.zip');
  await createZip(archivePath, [
    { name: 'outside-link', content: '../outside', mode: 0o120777 }
  ]);

  await expect(runV1ArchiveAnalysis({ sourcePath: archivePath, extractDirectory: join(root, 'extracted') }))
    .rejects.toThrow('ZIP 诊断包包含不安全的符号链接条目');
});

it('V1 来源清单保持原有 UTF-16 文件名顺序以稳定 Evidence ID', async () => {
  const root = await mkdtemp(join(tmpdir(), 'analysis-v1-source-order-'));
  directories.push(root);
  const archivePath = join(root, 'source-order.zip');
  await createZip(archivePath, [
    { name: 'a_syslog', content: '2026-08-30T19:27:14+08:00 UPS ups0@localhost on battery' },
    { name: 'B_syslog', content: '2026-08-30T19:27:15+08:00 UPS ups0@localhost on battery' }
  ]);

  const output = await runV1ArchiveAnalysis({ sourcePath: archivePath, extractDirectory: join(root, 'extracted') });

  expect(output.result.evidence.map((item) => item.sourceFile)).toEqual(['a_syslog', 'B_syslog']);
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

async function createZip(archivePath: string, files: Array<{ name: string; content: string | Buffer; mode?: number }>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const zip = new yazl.ZipFile();
    zip.outputStream.pipe(createWriteStream(archivePath)).on('close', resolve).on('error', reject);
    for (const file of files) zip.addBuffer(Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content), file.name, file.mode === undefined ? undefined : { mode: file.mode });
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
