import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as tar from 'tar';
import { runV1ArchiveAnalysis } from './backend/lib/analysis/archive-analysis';
import rulePack from './backend/lib/analysis-v1/event-rule-pack.json';

const TARGET_BYTES = 100 * 1024 * 1024;
const RUNS = 3;
const root = await mkdtemp(join(tmpdir(), 'analysis-center-benchmark-'));

/** 生成临时 100 MB ASCII 日志，避免基准受多字节字符和外部测试夹具影响。 */
async function createArchive(): Promise<string> {
  const sourceDirectory = join(root, 'source');
  await mkdir(sourceDirectory);
  const line = `2026-08-27T10:00:00+08:00 kernel: normal heartbeat trace=${'x'.repeat(910)}\n`;
  const content = `2026-08-27T10:00:00+08:00 kernel: blk_update_request: I/O error, dev sdc, sector 1\n${line.repeat(Math.ceil(TARGET_BYTES / Buffer.byteLength(line))).slice(0, TARGET_BYTES)}`;
  await Promise.all([
    writeFile(join(sourceDirectory, 'kern.log'), content, 'utf8'),
    writeFile(join(sourceDirectory, 'mdstat.log'), 'md0 : active raid1 sdc2[1](F) sdb2[0]\n      100 blocks [2/1] [U_]', 'utf8'),
    writeFile(join(sourceDirectory, 'sysinfo.json'), JSON.stringify({ disk: { devices: [{ disk_info: { dev_name: '/dev/sdc' }, smart_info: { report: [{ id: 197, name: 'Current_Pending_Sector', raw: 2 }] } }] } }), 'utf8')
  ]);
  const archivePath = join(root, 'benchmark.tgz');
  await tar.c({ gzip: true, cwd: sourceDirectory, file: archivePath }, ['kern.log', 'mdstat.log', 'sysinfo.json']);
  return archivePath;
}

/** 保留优化前的解析热路径作为基准对照，只测规则扫描，不参与任何诊断结果生成。 */
function measureLegacyKernelScan(content: string): number {
  const startedAt = performance.now();
  for (const line of content.split(/\r?\n/)) {
    const emittedTypes = new Set<string>();
    for (const rule of rulePack.eventRules) {
      if (!rule.sources.includes('kernel')) continue;
      const match = new RegExp(rule.regex, 'i').exec(line);
      if (match) emittedTypes.add(rule.type);
    }
  }
  return performance.now() - startedAt;
}

try {
  const archivePath = await createArchive();
  const totals: number[] = [];
  const parseSpeedups: number[] = [];
  const totalSpeedups: number[] = [];
  const sourceContent = await readFile(join(root, 'source', 'kern.log'), 'utf8');
  for (let run = 1; run <= RUNS; run += 1) {
    const startedAt = performance.now();
    const stages = new Map<string, number>();
    await runV1ArchiveAnalysis({
      sourcePath: archivePath,
      extractDirectory: join(root, `extracted-${run}`),
      onProgress: ({ message }) => {
        const stage = message === '正在识别系统与存储日志' ? '读取' : message === '正在解析统一事件' ? '解析' : message === '正在关联诊断结论' ? '关联' : message === '诊断结果已完成' ? '报告' : undefined;
        if (stage && !stages.has(stage)) stages.set(stage, performance.now());
      }
    });
    const endedAt = performance.now();
    const readAt = stages.get('读取') ?? startedAt;
    const parseAt = stages.get('解析') ?? readAt;
    const correlateAt = stages.get('关联') ?? parseAt;
    const optimizedParse = correlateAt - parseAt;
    const legacyParse = measureLegacyKernelScan(sourceContent);
    const speedup = ((legacyParse - optimizedParse) / legacyParse) * 100;
    const total = endedAt - startedAt;
    const estimatedLegacyTotal = total - optimizedParse + legacyParse;
    const totalSpeedup = ((estimatedLegacyTotal - total) / estimatedLegacyTotal) * 100;
    console.log(`第 ${run} 次：读取 ${(parseAt - readAt).toFixed(0)} ms，解析 ${optimizedParse.toFixed(0)} ms，旧解析 ${legacyParse.toFixed(0)} ms，解析提速 ${speedup.toFixed(1)}%，报告 ${(endedAt - correlateAt).toFixed(0)} ms，总计 ${total.toFixed(0)} ms，估算旧总计 ${estimatedLegacyTotal.toFixed(0)} ms，总提速 ${totalSpeedup.toFixed(1)}%`);
    totals.push(total);
    parseSpeedups.push(speedup);
    totalSpeedups.push(totalSpeedup);
  }
  totals.sort((left, right) => left - right);
  parseSpeedups.sort((left, right) => left - right);
  totalSpeedups.sort((left, right) => left - right);
  console.log(`100 MB 诊断包三次中位数：${totals[1].toFixed(0)} ms`);
  console.log(`解析热路径三次中位提速：${parseSpeedups[1].toFixed(1)}%`);
  console.log(`估算总耗时三次中位提速：${totalSpeedups[1].toFixed(1)}%`);
} finally {
  await rm(root, { recursive: true, force: true });
}
