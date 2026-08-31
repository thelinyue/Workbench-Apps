import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import { runV1ArchiveAnalysis } from '../analysis/archive-analysis';
import { WorkspaceRepository } from '../data/workspace-repository';
import { isDiagnosticPackagePath } from '../domain/diagnostic-package';
import { AnalysisTaskService, type AnalysisWorker } from '../services/analysis-task-service';
import type { AnalysisResult } from './pipeline';
import { PIPELINE_COUNTER_NAMES, PIPELINE_STAGE_NAMES, PipelineProfiler, type PipelineFileMetric, type PipelineProfile, type PipelineRuleMetric, type PipelineStageName } from './pipeline-profiler';
import { renderPipelinePerformanceMarkdown, type DurationStatistics, type PipelinePerformanceReport, type PipelineTopFileReport, type PipelineTopRuleReport } from './pipeline-performance-report';

export type NormalizedAnalysisResult = Omit<AnalysisResult, 'id' | 'metadata'> & {
  metadata: Omit<AnalysisResult['metadata'], 'startTime' | 'completeTime' | 'duration'>;
};

export interface PipelineBenchmarkArguments {
  inputPath: string;
  outputDirectory?: string;
}

export interface PipelineBenchmarkRun {
  totalDurationMs: number;
  profile: PipelineProfile;
  result: AnalysisResult;
}

export interface PipelineBenchmarkReportContext {
  archiveSizeBytes: number;
  totalRunCount: number;
  uniqueExtractDirectoryCount: number;
  uniqueDatabaseCount: number;
}

export interface PipelineBenchmarkReportPaths {
  jsonPath: string;
  markdownPath: string;
}

/** 解析开发者基准参数；错误消息不拼接参数值，避免终端日志再次泄露输入路径。 */
export function parseBenchmarkArguments(args: string[]): PipelineBenchmarkArguments {
  let inputPath: string | undefined;
  let outputDirectory: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (name !== '--input' && name !== '--output') throw new Error('不支持的性能基准参数');
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} 缺少${name === '--input' ? '诊断包路径' : '报告目录'}`);
    if (name === '--input') {
      if (inputPath !== undefined) throw new Error('--input 不能重复指定');
      inputPath = value;
    } else {
      if (outputDirectory !== undefined) throw new Error('--output 不能重复指定');
      outputDirectory = value;
    }
    index += 1;
  }
  if (!inputPath) throw new Error('必须通过 --input 指定真实诊断包');
  return { inputPath, ...(outputDirectory ? { outputDirectory } : {}) };
}

/** 以固定文件名写出可提交基线；两个文件都只消费已经脱敏的报告模型。 */
export async function writePipelineBenchmarkReports(report: PipelinePerformanceReport, outputDirectory: string): Promise<PipelineBenchmarkReportPaths> {
  const jsonPath = join(outputDirectory, 'analysis-center-pipeline-baseline-2026-08-30.json');
  const markdownPath = join(outputDirectory, 'analysis-center-pipeline-baseline-2026-08-30.md');
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(markdownPath, renderPipelinePerformanceMarkdown(report), 'utf8');
  return { jsonPath, markdownPath };
}

/**
 * 基准只移除每次运行天然变化的 ID 和时间元数据。
 * Evidence、Finding、Diagnosis、Recommendation 与所有处理计数原样参与深度比较。
 */
export function normalizeAnalysisResult(result: AnalysisResult): NormalizedAnalysisResult {
  const { id: runtimeId, metadata, ...stableResult } = result;
  const { startTime, completeTime, duration, ...stableMetadata } = metadata;
  void runtimeId;
  void startTime;
  void completeTime;
  void duration;
  return { ...stableResult, metadata: stableMetadata };
}

/** 将五次测量折叠为只含匿名指标和内部安全枚举的可提交报告。 */
export function buildPipelinePerformanceReport(runs: PipelineBenchmarkRun[], context: PipelineBenchmarkReportContext): PipelinePerformanceReport {
  if (runs.length !== 5) throw new Error('性能报告必须包含 5 次测量结果');
  const referenceResult = normalizeAnalysisResult(runs[0]!.result);
  if (runs.some((run) => !isDeepStrictEqual(normalizeAnalysisResult(run.result), referenceResult))) throw new Error('性能基准的诊断结果不完全等价');
  const referenceCounters = runs[0]!.profile.counters;
  if (runs.some((run) => PIPELINE_COUNTER_NAMES.some((name) => run.profile.counters[name] !== referenceCounters[name]))) throw new Error('性能基准的 Pipeline 计数器不一致');

  const totalDuration = durationStatistics(runs.map((run) => run.totalDurationMs));
  const stages = PIPELINE_STAGE_NAMES.map((name) => {
    const duration = durationStatistics(runs.map((run) => run.profile.stages[name].durationMs));
    return { name, duration, shareOfTotalP50Percent: ratio(duration.p50Ms, totalDuration.p50Ms) };
  });
  const topStages = [...stages]
    .sort((left, right) => right.duration.p50Ms - left.duration.p50Ms || PIPELINE_STAGE_NAMES.indexOf(left.name) - PIPELINE_STAGE_NAMES.indexOf(right.name))
    .slice(0, 3)
    .map((stage, index) => ({ rank: index + 1, stage: stage.name, p50Ms: stage.duration.p50Ms, shareOfTotalP50Percent: stage.shareOfTotalP50Percent, ...stageGuidance(stage.name) }));
  const topFiles = aggregateFiles(runs);
  const topRules = aggregateRules(runs);
  const counters = { ...referenceCounters };
  const firstResult = runs[0]!.result;
  const diagnosisIds = firstResult.diagnoses.map((diagnosis, index) => safeDiagnosisId(diagnosis.id) ?? `diagnosis-${pad(index + 1)}`);
  const recommendations = firstResult.recommendations.map((recommendation, index) => ({
    id: safeRecommendationId(recommendation.id) ?? `recommendation-${pad(index + 1)}`,
    type: recommendation.type,
    risk: recommendation.risk
  }));
  const structuredTextScanDetected = runs[0]!.profile.files.some((file) => file.sourceType === 'sysinfo' && (file.linesProcessed > 0 || file.ruleDurationMs > 0));
  const freshPerRun = context.totalRunCount === 6
    && context.uniqueExtractDirectoryCount === context.totalRunCount
    && context.uniqueDatabaseCount === context.totalRunCount;

  return {
    schemaVersion: 1,
    sampleId: 'real-zip-20260830',
    benchmarkDate: '2026-08-30',
    mode: 'main-process-pipeline-with-production-persistence',
    workerStartupIncluded: false,
    warmupRuns: 1,
    measuredRuns: 5,
    runtime: { nodeVersion: process.versions.node, platform: process.platform, architecture: process.arch },
    input: { archiveSizeBytes: context.archiveSizeBytes, archiveEntries: counters.filesDiscovered },
    isolation: { totalRunCount: context.totalRunCount, uniqueExtractDirectoryCount: context.uniqueExtractDirectoryCount, uniqueDatabaseCount: context.uniqueDatabaseCount, freshPerRun },
    semanticEquivalence: { equivalent: true, ignoredRuntimeFields: ['AnalysisResult.id', 'metadata.startTime', 'metadata.completeTime', 'metadata.duration'] },
    totalDuration,
    stages,
    counters,
    investigation: {
      fileInventoryPasses: counters.fileInventoryPasses,
      repeatedFileScanDetected: counters.fileInventoryPasses > 1,
      regexInvocationsPerCandidateLine: ratio(counters.ruleInvocations, counters.candidateLines, 3),
      duplicateEvents: counters.duplicateEvents,
      duplicateEvidence: counters.duplicateEvidence,
      findingEvidenceReferences: counters.findingEvidenceReferences,
      uniqueFindingEvidenceReferences: counters.uniqueFindingEvidenceReferences,
      duplicateFindingEvidenceReferences: Math.max(0, counters.findingEvidenceReferences - counters.uniqueFindingEvidenceReferences),
      structuredFilesParsed: counters.structuredFilesParsed,
      structuredTextScanDetected
    },
    diagnostics: { diagnosisIds, recommendations },
    topStages,
    topFiles,
    topRules
  };
}

/**
 * 用真实诊断包串行执行固定的一次预热和五次测量。
 * 这里使用同进程 AnalysisWorker 适配器复用生产任务与持久化代码，不启动 worker_threads。
 */
export async function runPipelineBenchmark(inputPath: string): Promise<PipelinePerformanceReport> {
  const archive = await stat(inputPath).catch(() => undefined);
  if (!archive?.isFile() || !isDiagnosticPackagePath(inputPath)) throw new Error('性能基准输入不存在、不是文件或不是受支持的诊断包');
  const runs: PipelineBenchmarkRun[] = [];
  const extractDirectories = new Set<string>();
  const databasePaths = new Set<string>();
  for (let index = 0; index < 6; index += 1) {
    runs.push(await executeBenchmarkRun(inputPath, archive.size, (extractDirectory, databasePath) => {
      extractDirectories.add(extractDirectory);
      databasePaths.add(databasePath);
    }));
  }
  const reference = normalizeAnalysisResult(runs[0]!.result);
  if (runs.some((run) => !isDeepStrictEqual(normalizeAnalysisResult(run.result), reference))) throw new Error('预热和测量运行的诊断结果不完全等价');
  return buildPipelinePerformanceReport(runs.slice(1), {
    archiveSizeBytes: archive.size,
    totalRunCount: runs.length,
    uniqueExtractDirectoryCount: extractDirectories.size,
    uniqueDatabaseCount: databasePaths.size
  });
}

async function executeBenchmarkRun(inputPath: string, archiveSizeBytes: number, onPrepared: (extractDirectory: string, databasePath: string) => void): Promise<PipelineBenchmarkRun> {
  const runDirectory = await mkdtemp(join(tmpdir(), 'analysis-pipeline-benchmark-run-'));
  const extractDirectory = join(runDirectory, 'extract');
  const databasePath = join(runDirectory, 'analysis-center.db');
  onPrepared(extractDirectory, databasePath);
  const repository = new WorkspaceRepository(databasePath);
  const packageId = 'benchmark-package';
  repository.upsertPackage({
    id: packageId,
    sourcePath: inputPath,
    extractPath: extractDirectory,
    displayName: 'real-zip-20260830',
    sourceSizeBytes: archiveSizeBytes,
    detectedAt: '2026-08-30T00:00:00.000Z',
    status: 'pending',
    taskIds: [],
    caseId: 'benchmark-case'
  });
  let completedProfile: PipelineProfile | undefined;
  let resolveTerminal!: (profile: PipelineProfile) => void;
  let rejectTerminal!: (error: Error) => void;
  const terminal = new Promise<PipelineProfile>((resolve, reject) => { resolveTerminal = resolve; rejectTerminal = reject; });
  const service = new AnalysisTaskService(repository, {
    createWorker: (_url, options) => new MainProcessAnalysisWorker(options.workerData),
    performanceProfiling: { onCompleted: (profile) => { completedProfile = profile; } }
  });
  const onChanged = () => {
    const task = repository.listTasks().find((item) => item.packageId === packageId);
    if (task?.status === 'succeeded' && completedProfile) resolveTerminal(completedProfile);
    else if (task && ['failed', 'cancelled'].includes(task.status)) rejectTerminal(new Error('性能基准分析未成功完成'));
  };
  service.on('changed', onChanged);
  const startedAt = performance.now();
  try {
    await service.enqueue(packageId);
    const profile = await terminal;
    const totalDurationMs = performance.now() - startedAt;
    const result = repository.getAnalysisResult(packageId);
    if (!result) throw new Error('性能基准没有读取到已持久化的诊断结果');
    return { totalDurationMs, profile, result };
  } finally {
    service.off('changed', onChanged);
    try { await service.close(); }
    finally {
      repository.close();
      await rm(runDirectory, { recursive: true, force: true });
    }
  }
}

type MainProcessWorkerInput = { sourcePath: string; extractDirectory: string; performanceProfiling?: boolean };

/** 基准专用同进程适配器；消息协议与生产 Worker 相同，但不创建任何子线程。 */
class MainProcessAnalysisWorker extends EventEmitter implements AnalysisWorker {
  private terminated = false;

  public constructor(private readonly input: MainProcessWorkerInput) {
    super();
    queueMicrotask(() => { void this.run(); });
  }

  public terminate(): Promise<number> {
    this.terminated = true;
    return Promise.resolve(0);
  }

  private async run(): Promise<void> {
    try {
      const profiler = this.input.performanceProfiling ? new PipelineProfiler() : undefined;
      const output = await runV1ArchiveAnalysis({
        sourcePath: this.input.sourcePath,
        extractDirectory: this.input.extractDirectory,
        profiler,
        onProgress: (progress) => { if (!this.terminated) this.emit('message', { type: 'progress', ...progress }); }
      });
      if (!this.terminated) this.emit('message', { type: 'completed', succeeded: true, browserPath: output.browserPath, analysisResult: output.result, performanceProfile: output.performanceProfile });
    } catch {
      if (!this.terminated) this.emit('message', { type: 'completed', succeeded: false, errorMessage: '同进程性能基准分析失败' });
    }
  }
}

function aggregateFiles(runs: PipelineBenchmarkRun[]): PipelineTopFileReport[] {
  const firstFiles = runs[0]!.profile.files;
  return firstFiles.map((file) => {
    const metrics = runs.map((run) => findFile(run.profile.files, file.alias));
    return {
      originalAlias: file.alias,
      sourceType: file.sourceType,
      duration: durationStatistics(metrics.map(fileDuration)),
      bytesRead: file.bytesRead,
      decodedBytes: file.decodedBytes,
      linesProcessed: file.linesProcessed,
      eventsCreated: file.eventsCreated,
      evidenceRetained: file.evidenceRetained
    };
  }).sort((left, right) => right.duration.p50Ms - left.duration.p50Ms || left.originalAlias.localeCompare(right.originalAlias))
    .slice(0, 10)
    .map(({ originalAlias, ...file }, index) => ({ ...file, alias: safeFileAlias(originalAlias) ?? `file-${pad(index + 1)}` }));
}

function aggregateRules(runs: PipelineBenchmarkRun[]): PipelineTopRuleReport[] {
  const firstRules = runs[0]!.profile.rules;
  return firstRules.map((rule) => {
    const metrics = runs.map((run) => findRule(run.profile.rules, rule.ruleId));
    return { originalRuleId: rule.ruleId, duration: durationStatistics(metrics.map((metric) => metric.durationMs)), invocations: rule.invocations, matches: rule.matches };
  }).sort((left, right) => right.duration.p50Ms - left.duration.p50Ms || left.originalRuleId.localeCompare(right.originalRuleId))
    .slice(0, 10)
    .map(({ originalRuleId, ...rule }, index) => ({ ...rule, ruleId: safeRuleId(originalRuleId) ?? `rule-${pad(index + 1)}` }));
}

function findFile(files: PipelineFileMetric[], alias: string): PipelineFileMetric {
  const metric = files.find((file) => file.alias === alias);
  if (!metric) throw new Error('性能基准的匿名文件指标不一致');
  return metric;
}

function findRule(rules: PipelineRuleMetric[], ruleId: string): PipelineRuleMetric {
  const metric = rules.find((rule) => rule.ruleId === ruleId);
  if (!metric) throw new Error('性能基准的规则指标不一致');
  return metric;
}

function fileDuration(file: PipelineFileMetric): number { return file.readDurationMs + file.parserDurationMs + file.ruleDurationMs; }

function durationStatistics(values: number[]): DurationStatistics {
  const sorted = values.map(roundMilliseconds).sort((left, right) => left - right);
  return { minMs: sorted[0]!, p50Ms: sorted[Math.floor(sorted.length / 2)]!, maxMs: sorted.at(-1)! };
}

function ratio(numerator: number, denominator: number, digits = 2): number {
  if (denominator === 0) return 0;
  return Number(((numerator / denominator) * (digits === 2 ? 100 : 1)).toFixed(digits));
}

function roundMilliseconds(value: number): number { return Number(value.toFixed(3)); }
function pad(value: number): string { return String(value).padStart(2, '0'); }
function safeFileAlias(value: string): string | undefined { return /^(kernel|sysinfo|mdstat|ugvolume)-\d{2,}$/.test(value) ? value : undefined; }
function safeRuleId(value: string): string | undefined { return /^(storage|raid|system|filesystem)\.[a-z0-9._-]+$/.test(value) ? value : undefined; }
function safeDiagnosisId(value: string): string | undefined { return /^(storage|raid|system|filesystem)\.[a-z0-9._-]+$/.test(value) ? value : undefined; }
function safeRecommendationId(value: string): string | undefined { const id = value.split(':', 1)[0]; return /^recommendation\.(smart|raid)$/.test(id) ? id : undefined; }

function stageGuidance(stage: PipelineStageName): { focus: string; optimizationDirection: string; accuracyGuard: string } {
  return ({
    'input.recognition': { focus: '归档识别与单次文件清单遍历', optimizationDirection: '检查目录遍历、分类和完整性校验的重复工作', accuracyGuard: '未知文件必须计数后忽略，不能回退为通用文本扫描' },
    'archive.extract': { focus: '诊断包解压与成员落盘', optimizationDirection: '评估解压 I/O、压缩格式和临时目录写入成本', accuracyGuard: '不得跳过归档成员或复用含旧文件的解压目录' },
    'source.read': { focus: '受支持来源读取与 gzip 解码', optimizationDirection: '检查重复读取、缓冲复制和解码成本', accuracyGuard: '不得减少受支持日志覆盖或截断 Evidence 来源' },
    'parser.total': { focus: '结构化 Parser 与文本行解析', optimizationDirection: '检查 Parser 热点和不必要的中间对象', accuracyGuard: '结构化文件必须由对应 Parser 完整处理' },
    'rules.event.total': { focus: 'Event Rule Regex 扫描', optimizationDirection: '检查候选行比例、全规则调用和重复命中', accuracyGuard: '不得减少规则覆盖、命中 Event 或关联 Evidence' },
    'finding.aggregate': { focus: 'Finding 与 Evidence 引用聚合', optimizationDirection: '检查重复 Event/Evidence 和聚合键开销', accuracyGuard: '只能合并语义等价项，不能丢弃独立 Evidence' },
    'diagnosis.compose': { focus: 'Finding 到 Diagnosis 的关联', optimizationDirection: '检查重复拓扑查找和诊断关联遍历', accuracyGuard: 'Diagnosis、置信度、顺序和资源关联必须完全等价' },
    'recommendation.compose': { focus: 'Recommendation 物化与排序', optimizationDirection: '检查重复建议去重和排序成本', accuracyGuard: '建议 ID、类型、风险和顺序必须完全等价' },
    'report.render': { focus: 'HTML 报告渲染与写入', optimizationDirection: '检查模板拼接和文件写入成本', accuracyGuard: '用户与工程师报告内容不得减少' },
    persistence: { focus: '成功结果 SQLite 持久化', optimizationDirection: '检查 JSON 序列化、事务和历史裁剪成本', accuracyGuard: '结果、任务、报告索引和事务语义必须保持不变' }
  } satisfies Record<PipelineStageName, { focus: string; optimizationDirection: string; accuracyGuard: string }>)[stage];
}
