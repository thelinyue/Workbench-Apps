import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import yazl from 'yazl';
import { afterEach, describe, expect, it } from 'vitest';
import type { AnalysisResult } from '../backend/lib/analysis-v1/pipeline';
import { PipelineProfiler } from '../backend/lib/analysis-v1/pipeline-profiler';
import { buildPipelinePerformanceReport, normalizeAnalysisResult, parseBenchmarkArguments, runPipelineBenchmark, writePipelineBenchmarkReports, type PipelineBenchmarkRun } from '../backend/lib/analysis-v1/pipeline-benchmark';
import { renderPipelinePerformanceMarkdown } from '../backend/lib/analysis-v1/pipeline-performance-report';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe('Pipeline 真实包性能基准', () => {
  it('真实 ZIP 串行执行一次预热和五次独立测量', async () => {
    const sentinel = 'REAL_INPUT_SENTINEL_C41B2E';
    const root = await mkdtemp(join(tmpdir(), 'analysis-pipeline-benchmark-'));
    directories.push(root);
    const archivePath = join(root, `nas_server_log_${sentinel}.zip`);
    await createZip(archivePath, [
      { name: 'DEVICE_20260830192714_syslog', content: `2026-08-30T19:27:14+08:00 UPS ups0@localhost on battery ${sentinel}` },
      { name: `private_${sentinel}.xlog.gz`, content: gzipSync(`2026-08-30T19:28:00+08:00 kernel: Buffer I/O error on dev sdz ${sentinel}`) }
    ]);

    const report = await runPipelineBenchmark(archivePath);
    const serialized = `${JSON.stringify(report)}\n${renderPipelinePerformanceMarkdown(report)}`;

    expect(report).toMatchObject({
      warmupRuns: 1,
      measuredRuns: 5,
      workerStartupIncluded: false,
      semanticEquivalence: { equivalent: true },
      isolation: { totalRunCount: 6, uniqueExtractDirectoryCount: 6, uniqueDatabaseCount: 6, freshPerRun: true }
    });
    expect(report.counters).toMatchObject({ filesDiscovered: 2, filesIgnored: 1, filesRead: 1, linesProcessed: 1, eventsCreated: 1, findingsCreated: 1, evidenceRetained: 1 });
    expect(report.stages.find((stage) => stage.name === 'persistence')?.duration.p50Ms).toBeGreaterThanOrEqual(0);
    expect(report.topFiles[0]).toMatchObject({ alias: 'format-rule-01', sourceType: 'format-rule', linesProcessed: 1, eventsCreated: 1, evidenceRetained: 1 });
    expect(serialized).not.toContain(sentinel);
    expect(serialized).not.toContain(archivePath);
  });

  it('聚合五次测量并只输出匿名指标和安全结构化字段', () => {
    const sentinel = 'PRIVATE_SENTINEL_7D3A9C';
    const totals = [50, 10, 30, 20, 40];
    const runs = totals.map((totalDurationMs, index): PipelineBenchmarkRun => ({
      totalDurationMs,
      profile: performanceProfile(index, sentinel),
      result: sensitiveAnalysisResult(sentinel, index)
    }));

    const report = buildPipelinePerformanceReport(runs, {
      archiveSizeBytes: 41_154_086,
      totalRunCount: 6,
      uniqueExtractDirectoryCount: 6,
      uniqueDatabaseCount: 6
    });
    const json = JSON.stringify(report, null, 2);
    const markdown = renderPipelinePerformanceMarkdown(report);

    expect(report.totalDuration).toEqual({ minMs: 10, p50Ms: 30, maxMs: 50 });
    expect(report.stages.find((stage) => stage.name === 'archive.extract')?.duration).toEqual({ minMs: 50, p50Ms: 52, maxMs: 54 });
    expect(report.topStages.map((stage) => stage.stage)).toEqual(['archive.extract', 'parser.total', 'rules.event.total']);
    expect(report.topFiles).toHaveLength(10);
    expect(report.topRules).toHaveLength(10);
    expect(report.topRules[0]?.ruleId).toBe('rule-01');
    expect(report.diagnostics.diagnosisIds).toEqual(['diagnosis-01']);
    expect(report.diagnostics.recommendations).toEqual([{ id: 'recommendation.smart', type: 'inspection', risk: 'safe' }]);
    expect(report.investigation).toMatchObject({
      fileInventoryPasses: 1,
      repeatedFileScanDetected: false,
      duplicateEvents: 0,
      duplicateEvidence: 0,
      structuredTextScanDetected: false
    });
    expect(report.isolation).toEqual({ totalRunCount: 6, uniqueExtractDirectoryCount: 6, uniqueDatabaseCount: 6, freshPerRun: true });
    expect(json).not.toContain(sentinel);
    expect(markdown).not.toContain(sentinel);
    expect(markdown).toContain('耗时 Top 3');
    expect(markdown).toContain('准确性保护');
  });

  it('要求显式输入并拒绝缺值或未知参数', () => {
    expect(parseBenchmarkArguments(['--input', 'C:/private/input.zip', '--output', 'D:/reports'])).toEqual({
      inputPath: 'C:/private/input.zip',
      outputDirectory: 'D:/reports'
    });
    expect(() => parseBenchmarkArguments([])).toThrow('必须通过 --input 指定真实诊断包');
    expect(() => parseBenchmarkArguments(['--input'])).toThrow('--input 缺少诊断包路径');
    expect(() => parseBenchmarkArguments(['--unknown', 'value'])).toThrow('不支持的性能基准参数');
  });

  it('用固定文件名写出 JSON 和 Markdown 基线报告', async () => {
    const sentinel = 'REPORT_SENTINEL_2A4E91';
    const root = await mkdtemp(join(tmpdir(), 'analysis-pipeline-report-'));
    directories.push(root);
    const runs = [0, 1, 2, 3, 4].map((runIndex): PipelineBenchmarkRun => ({
      totalDurationMs: 100 + runIndex,
      profile: performanceProfile(runIndex, sentinel),
      result: sensitiveAnalysisResult(sentinel, runIndex)
    }));
    const report = buildPipelinePerformanceReport(runs, {
      archiveSizeBytes: 41_154_086,
      totalRunCount: 6,
      uniqueExtractDirectoryCount: 6,
      uniqueDatabaseCount: 6
    });

    const paths = await writePipelineBenchmarkReports(report, root);
    const json = await readFile(paths.jsonPath, 'utf8');
    const markdown = await readFile(paths.markdownPath, 'utf8');

    expect(paths).toEqual({
      jsonPath: join(root, 'analysis-center-pipeline-baseline-2026-08-30.json'),
      markdownPath: join(root, 'analysis-center-pipeline-baseline-2026-08-30.md')
    });
    expect(JSON.parse(json)).toEqual(report);
    expect(markdown).toContain('# 分析中心 Pipeline 性能基线（2026-08-30）');
    expect(`${json}\n${markdown}`).not.toContain(sentinel);
  });

  it('语义比较只忽略结果 ID 和三项运行时间字段', () => {
    const left = analysisResult({ id: 'analysis-1', startTime: '2026-08-30T00:00:00.000Z', completeTime: '2026-08-30T00:00:01.000Z', duration: 1000 });
    const right = analysisResult({ id: 'analysis-2', startTime: '2026-08-30T01:00:00.000Z', completeTime: '2026-08-30T01:00:03.000Z', duration: 3000 });

    expect(normalizeAnalysisResult(left)).toEqual(normalizeAnalysisResult(right));

    right.evidence[0]!.rawMessage = 'changed evidence';
    expect(normalizeAnalysisResult(left)).not.toEqual(normalizeAnalysisResult(right));
  });
});

function analysisResult(runtime: { id: string; startTime: string; completeTime: string; duration: number }): AnalysisResult {
  return {
    schemaVersion: 1,
    id: runtime.id,
    status: 'partial',
    summary: { criticalCount: 0, warningCount: 0, infoCount: 0, complete: false },
    diagnoses: [],
    findings: [],
    evidence: [{ id: 'evidence-1', timestampPrecision: 'unknown', timestampConfidence: 'low', sourceFile: 'kernel-01', eventType: 'storage.io_error', rawMessage: 'original evidence' }],
    deviceAssessments: [],
    recommendations: [],
    metadata: {
      source: 'fixture.zip',
      startTime: runtime.startTime,
      completeTime: runtime.completeTime,
      duration: runtime.duration,
      processedFiles: 1,
      processedLines: 1,
      processedEvents: 1,
      analyzerVersion: '1.1.0',
      rulePackVersion: '1.5.0',
      missingData: ['sysinfo', 'mdstat']
    }
  };
}

function performanceProfile(runIndex: number, sentinel: string) {
  const profiler = new PipelineProfiler();
  profiler.recordElapsed('archive.extract', 50 + runIndex);
  profiler.recordElapsed('parser.total', 30 + runIndex);
  profiler.recordElapsed('rules.event.total', 20 + runIndex);
  profiler.recordElapsed('source.read', 10 + runIndex);
  profiler.recordElapsed('input.recognition', 5 + runIndex);
  profiler.recordElapsed('finding.aggregate', 4 + runIndex);
  profiler.recordElapsed('diagnosis.compose', 3 + runIndex);
  profiler.recordElapsed('recommendation.compose', 2 + runIndex);
  profiler.recordElapsed('report.render', 1 + runIndex);
  profiler.recordElapsed('persistence', 0.5 + runIndex);
  profiler.increment('fileInventoryPasses');
  profiler.increment('directoriesVisited', 2);
  profiler.increment('filesDiscovered', 14);
  profiler.increment('filesIgnored', 2);
  profiler.increment('filesRead', 12);
  profiler.increment('bytesRead', 12_000);
  profiler.increment('decodedBytes', 24_000);
  profiler.increment('linesProcessed', 120);
  profiler.increment('candidateLines', 20);
  profiler.increment('ruleInvocations', 200);
  profiler.increment('ruleMatches', 4);
  profiler.increment('eventsCreated', 3);
  profiler.increment('findingsCreated', 2);
  profiler.increment('evidenceRetained', 3);
  profiler.increment('diagnosesCreated', 1);
  profiler.increment('recommendationsCreated', 1);
  profiler.increment('findingEvidenceReferences', 3);
  profiler.increment('uniqueFindingEvidenceReferences', 3);
  for (let index = 0; index < 12; index += 1) {
    const fileKey = `C:/private/${sentinel}/kernel-${index}.log`;
    profiler.recordFile(fileKey, 'kernel', { bytesRead: 1000, decodedBytes: 2000, readDurationMs: 12 - index + runIndex });
    profiler.addFileMetrics(fileKey, { linesProcessed: 10, parserDurationMs: 12 - index, ruleDurationMs: 6 - index / 10, eventsCreated: index === 0 ? 3 : 0, evidenceRetained: index === 0 ? 3 : 0 });
    profiler.recordRule(index === 11 ? sentinel : `storage.rule.${String(index).padStart(2, '0')}`, 10, index < 2, index + 1 + runIndex);
  }
  return profiler.snapshot();
}

function sensitiveAnalysisResult(sentinel: string, runIndex: number): AnalysisResult {
  return {
    schemaVersion: 1,
    id: `analysis-${runIndex}`,
    status: 'partial',
    summary: { criticalCount: 1, warningCount: 0, infoCount: 0, primaryDiagnosisId: sentinel, complete: false },
    diagnoses: [{ id: sentinel, category: 'storage', severity: 'critical', confidence: 'high', title: sentinel, summary: sentinel, primaryResource: `/dev/${sentinel}`, affectedResources: [`/dev/${sentinel}`], findingIds: ['finding-1'], recommendationIds: [`recommendation.smart:/dev/${sentinel}`], userConclusion: sentinel, engineerConclusion: sentinel }],
    findings: [{ id: 'finding-1', type: 'storage.io_error', category: 'storage', severity: 'critical', confidence: 'high', title: sentinel, summary: sentinel, affectedResources: [`/dev/${sentinel}`], evidenceIds: ['evidence-1'], occurrenceCount: 1 }],
    evidence: [{ id: 'evidence-1', timestampPrecision: 'unknown', timestampConfidence: 'low', sourceFile: `C:/private/${sentinel}.log`, eventType: 'storage.io_error', resource: `/dev/${sentinel}`, rawMessage: sentinel }],
    deviceAssessments: [{ resource: `/dev/${sentinel}`, model: sentinel, serial: sentinel, smartRiskAttributes: [], ioErrorCount: 1 }],
    recommendations: [{ id: `recommendation.smart:/dev/${sentinel}`, priority: 1, type: 'inspection', title: sentinel, reason: sentinel, risk: 'safe' }],
    metadata: { source: `C:/private/${sentinel}.zip`, startTime: `2026-08-30T00:00:0${runIndex}.000Z`, completeTime: `2026-08-30T00:00:1${runIndex}.000Z`, duration: runIndex, processedFiles: 12, processedLines: 120, processedEvents: 3, analyzerVersion: '1.1.0', rulePackVersion: '1.5.0', missingData: ['sysinfo', 'mdstat'] },
    ...( { errorMessage: sentinel, html: `<p>${sentinel}</p>` } as Record<string, unknown> )
  } as AnalysisResult;
}

async function createZip(archivePath: string, files: Array<{ name: string; content: string | Buffer }>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const zip = new yazl.ZipFile();
    zip.outputStream.pipe(createWriteStream(archivePath)).on('close', resolve).on('error', reject);
    for (const file of files) zip.addBuffer(Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content), file.name);
    zip.end();
  });
}
