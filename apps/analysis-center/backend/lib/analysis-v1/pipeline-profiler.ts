import { performance } from 'node:perf_hooks';
import type { V1SourceType } from './source-classifier';

export const PIPELINE_STAGE_NAMES = [
  'input.recognition',
  'archive.extract',
  'source.read',
  'parser.total',
  'rules.event.total',
  'finding.aggregate',
  'diagnosis.compose',
  'recommendation.compose',
  'report.render',
  'persistence'
] as const;

export type PipelineStageName = (typeof PIPELINE_STAGE_NAMES)[number];

export const PIPELINE_COUNTER_NAMES = [
  'fileInventoryPasses',
  'directoriesVisited',
  'filesDiscovered',
  'filesIgnored',
  'filesRead',
  'bytesRead',
  'decodedBytes',
  'structuredFilesParsed',
  'linesProcessed',
  'candidateLines',
  'ruleInvocations',
  'ruleMatches',
  'eventsCreated',
  'findingsCreated',
  'evidenceRetained',
  'diagnosesCreated',
  'recommendationsCreated',
  'duplicateEvents',
  'duplicateEvidence',
  'findingEvidenceReferences',
  'uniqueFindingEvidenceReferences'
] as const;

export type PipelineCounterName = (typeof PIPELINE_COUNTER_NAMES)[number];

export interface PipelineStageMetric { durationMs: number; invocations: number; }
export interface PipelineFileMetric {
  alias: string;
  sourceType: V1SourceType;
  bytesRead: number;
  decodedBytes: number;
  linesProcessed: number;
  readDurationMs: number;
  parserDurationMs: number;
  ruleDurationMs: number;
  eventsCreated: number;
  evidenceRetained: number;
}
export interface PipelineRuleMetric { ruleId: string; invocations: number; matches: number; durationMs: number; }
export interface PipelineProfile {
  schemaVersion: 1;
  stages: Record<PipelineStageName, PipelineStageMetric>;
  counters: Record<PipelineCounterName, number>;
  files: PipelineFileMetric[];
  rules: PipelineRuleMetric[];
  timerReads: number;
}

type FileMetricPatch = Partial<Omit<PipelineFileMetric, 'alias' | 'sourceType'>>;

/**
 * 开发者显式启用的 Pipeline 性能采集器。
 *
 * 采集器只在内存中累计阶段、计数器和明细；文件真实路径只作为运行期关联键，快照始终输出
 * 匿名别名。正式分析不创建本类，因此不会写性能文件，也不会进入逐规则计时分支。
 */
export class PipelineProfiler {
  private readonly stages = new Map<PipelineStageName, PipelineStageMetric>();
  private readonly counters = new Map<PipelineCounterName, number>();
  private readonly files = new Map<string, PipelineFileMetric>();
  private readonly rules = new Map<string, PipelineRuleMetric>();
  private readonly sourceCounts = new Map<V1SourceType, number>();
  private timerReadCount = 0;

  public constructor(private readonly clock: () => number = () => performance.now()) {
    for (const name of PIPELINE_STAGE_NAMES) this.stages.set(name, { durationMs: 0, invocations: 0 });
    for (const name of PIPELINE_COUNTER_NAMES) this.counters.set(name, 0);
  }

  public measure<T>(stage: PipelineStageName, operation: () => T): T {
    const startedAt = this.now();
    try { return operation(); }
    finally { this.addStageDuration(stage, this.now() - startedAt); }
  }

  public async measureAsync<T>(stage: PipelineStageName, operation: () => Promise<T>): Promise<T> {
    const startedAt = this.now();
    try { return await operation(); }
    finally { this.addStageDuration(stage, this.now() - startedAt); }
  }

  /** 在调用点标记开始时间，用于同一次文件遍历内拆分互斥阶段。 */
  public mark(): number {
    return this.now();
  }

  /** 计算标记后的耗时；时钟异常回拨时按零处理，避免污染聚合报告。 */
  public elapsed(startedAt: number): number {
    return Math.max(0, this.now() - startedAt);
  }

  public addStageDuration(stage: PipelineStageName, durationMs: number): void {
    this.recordElapsed(stage, durationMs);
  }

  /** 供已在调用点完成计时的同步代码写入阶段耗时，避免为了采集再执行一次操作。 */
  public recordElapsed(stage: PipelineStageName, durationMs: number): void {
    const metric = this.stages.get(stage)!;
    metric.durationMs += Math.max(0, durationMs);
    metric.invocations += 1;
  }

  public increment(counter: PipelineCounterName, amount = 1): void {
    this.counters.set(counter, this.counters.get(counter)! + amount);
  }

  public recordFile(fileKey: string, sourceType: V1SourceType, metrics: Pick<PipelineFileMetric, 'bytesRead' | 'decodedBytes'> & Partial<Pick<PipelineFileMetric, 'readDurationMs'>>): void {
    const nextIndex = (this.sourceCounts.get(sourceType) ?? 0) + 1;
    this.sourceCounts.set(sourceType, nextIndex);
    this.files.set(fileKey, {
      alias: `${sourceType}-${String(nextIndex).padStart(2, '0')}`,
      sourceType,
      bytesRead: metrics.bytesRead,
      decodedBytes: metrics.decodedBytes,
      linesProcessed: 0,
      readDurationMs: metrics.readDurationMs ?? 0,
      parserDurationMs: 0,
      ruleDurationMs: 0,
      eventsCreated: 0,
      evidenceRetained: 0
    });
  }

  public hasFile(fileKey: string): boolean {
    return this.files.has(fileKey);
  }

  public addFileMetrics(fileKey: string, patch: FileMetricPatch): void {
    const metric = this.files.get(fileKey);
    if (!metric) throw new Error('性能采集器找不到对应的日志文件指标。');
    for (const [name, amount] of Object.entries(patch) as Array<[keyof FileMetricPatch, number | undefined]>) {
      if (amount !== undefined) metric[name] += amount;
    }
  }

  public recordRule(ruleId: string, invocations: number, matched: boolean, durationMs: number): void {
    const metric = this.rules.get(ruleId) ?? { ruleId, invocations: 0, matches: 0, durationMs: 0 };
    metric.invocations += invocations;
    metric.matches += matched ? 1 : 0;
    metric.durationMs += durationMs;
    this.rules.set(ruleId, metric);
  }

  public snapshot(): PipelineProfile {
    return {
      schemaVersion: 1,
      stages: Object.fromEntries(PIPELINE_STAGE_NAMES.map((name) => [name, { ...this.stages.get(name)! }])) as Record<PipelineStageName, PipelineStageMetric>,
      counters: Object.fromEntries(PIPELINE_COUNTER_NAMES.map((name) => [name, this.counters.get(name)!])) as Record<PipelineCounterName, number>,
      files: [...this.files.values()].map((metric) => ({ ...metric })),
      rules: [...this.rules.values()].map((metric) => ({ ...metric })),
      timerReads: this.timerReadCount
    };
  }

  private now(): number {
    this.timerReadCount += 1;
    return this.clock();
  }
}
