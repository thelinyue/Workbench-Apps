import type { PipelineCounterName, PipelineStageName } from './pipeline-profiler';
import type { V1SourceType } from './source-classifier';

export interface DurationStatistics { minMs: number; p50Ms: number; maxMs: number; }
export interface PipelineStageReport { name: PipelineStageName; duration: DurationStatistics; shareOfTotalP50Percent: number; }
export interface PipelineTopStageReport { rank: number; stage: PipelineStageName; p50Ms: number; shareOfTotalP50Percent: number; focus: string; optimizationDirection: string; accuracyGuard: string; }
export interface PipelineTopFileReport { alias: string; sourceType: V1SourceType; duration: DurationStatistics; bytesRead: number; decodedBytes: number; linesProcessed: number; eventsCreated: number; evidenceRetained: number; }
export interface PipelineTopRuleReport { ruleId: string; duration: DurationStatistics; invocations: number; matches: number; }

export interface PipelinePerformanceReport {
  schemaVersion: 1;
  sampleId: 'real-zip-20260830';
  benchmarkDate: '2026-08-30';
  mode: 'main-process-pipeline-with-production-persistence';
  workerStartupIncluded: false;
  warmupRuns: 1;
  measuredRuns: 5;
  runtime: { nodeVersion: string; platform: NodeJS.Platform; architecture: string };
  input: { archiveSizeBytes: number; archiveEntries: number };
  isolation: { totalRunCount: number; uniqueExtractDirectoryCount: number; uniqueDatabaseCount: number; freshPerRun: boolean };
  semanticEquivalence: { equivalent: true; ignoredRuntimeFields: ['AnalysisResult.id', 'metadata.startTime', 'metadata.completeTime', 'metadata.duration'] };
  totalDuration: DurationStatistics;
  stages: PipelineStageReport[];
  counters: Record<PipelineCounterName, number>;
  investigation: {
    fileInventoryPasses: number;
    repeatedFileScanDetected: boolean;
    regexInvocationsPerCandidateLine: number;
    duplicateEvents: number;
    duplicateEvidence: number;
    findingEvidenceReferences: number;
    uniqueFindingEvidenceReferences: number;
    duplicateFindingEvidenceReferences: number;
    structuredFilesParsed: number;
    structuredTextScanDetected: boolean;
  };
  diagnostics: { diagnosisIds: string[]; recommendations: Array<{ id: string; type: 'inspection' | 'verification' | 'repair'; risk: 'safe' | 'confirmation-required' | 'high-risk' }> };
  topStages: PipelineTopStageReport[];
  topFiles: PipelineTopFileReport[];
  topRules: PipelineTopRuleReport[];
}

/** Markdown 只消费已经脱敏的 report model，不接触 AnalysisResult、路径、日志或 HTML。 */
export function renderPipelinePerformanceMarkdown(report: PipelinePerformanceReport): string {
  const lines = [
    '# 分析中心 Pipeline 性能基线（2026-08-30）',
    '',
    '> 开发者基准：主进程内 Pipeline + 生产成功持久化；不包含发布版 Worker 启动开销。',
    '',
    '## 基准协议',
    '',
    '| 项目 | 值 |',
    '|---|---:|',
    `| 样本 ID | ${cell(report.sampleId)} |`,
    `| 归档大小 | ${integer(report.input.archiveSizeBytes)} bytes |`,
    `| 归档文件数 | ${integer(report.input.archiveEntries)} |`,
    `| 预热 / 测量 | ${report.warmupRuns} / ${report.measuredRuns} |`,
    `| 独立解压目录 / SQLite | ${report.isolation.uniqueExtractDirectoryCount} / ${report.isolation.uniqueDatabaseCount} |`,
    `| 语义等价 | ${report.semanticEquivalence.equivalent ? '通过' : '失败'} |`,
    '',
    '## 总耗时',
    '',
    '| min | P50 | max |',
    '|---:|---:|---:|',
    `| ${milliseconds(report.totalDuration.minMs)} | ${milliseconds(report.totalDuration.p50Ms)} | ${milliseconds(report.totalDuration.maxMs)} |`,
    '',
    '## 分阶段耗时',
    '',
    '| 阶段 | min | P50 | max | P50 占总耗时 |',
    '|---|---:|---:|---:|---:|',
    ...report.stages.map((stage) => `| ${cell(stage.name)} | ${milliseconds(stage.duration.minMs)} | ${milliseconds(stage.duration.p50Ms)} | ${milliseconds(stage.duration.maxMs)} | ${percent(stage.shareOfTotalP50Percent)} |`),
    '',
    '## 耗时 Top 3',
    '',
    '| 排名 | 阶段 | P50 | 定位 | 后续优化方向 | 准确性保护 |',
    '|---:|---|---:|---|---|---|',
    ...report.topStages.map((stage) => `| ${stage.rank} | ${cell(stage.stage)} | ${milliseconds(stage.p50Ms)} | ${cell(stage.focus)} | ${cell(stage.optimizationDirection)} | ${cell(stage.accuracyGuard)} |`),
    '',
    '## 优先排查结论',
    '',
    '| 检查项 | 结果 |',
    '|---|---:|',
    `| 文件清单遍历次数 | ${report.investigation.fileInventoryPasses} |`,
    `| 重复文件扫描 | ${report.investigation.repeatedFileScanDetected ? '检测到' : '未检测到'} |`,
    `| 每候选行 Regex 调用 | ${decimal(report.investigation.regexInvocationsPerCandidateLine)} |`,
    `| 重复 Event / Evidence | ${report.investigation.duplicateEvents} / ${report.investigation.duplicateEvidence} |`,
    `| Finding Evidence 引用 / 唯一引用 | ${report.investigation.findingEvidenceReferences} / ${report.investigation.uniqueFindingEvidenceReferences} |`,
    `| 结构化文件文本扫描 | ${report.investigation.structuredTextScanDetected ? '检测到' : '未检测到'} |`,
    '',
    '## 核心计数',
    '',
    '| 指标 | 数量 |',
    '|---|---:|',
    ...Object.entries(report.counters).map(([name, value]) => `| ${cell(name)} | ${integer(value)} |`),
    '',
    '## Top 10 文件',
    '',
    '| 匿名文件 | 来源 | P50 | 读取字节 | 解码字节 | 行数 | Event | Evidence |',
    '|---|---|---:|---:|---:|---:|---:|---:|',
    ...report.topFiles.map((file) => `| ${cell(file.alias)} | ${cell(file.sourceType)} | ${milliseconds(file.duration.p50Ms)} | ${integer(file.bytesRead)} | ${integer(file.decodedBytes)} | ${integer(file.linesProcessed)} | ${integer(file.eventsCreated)} | ${integer(file.evidenceRetained)} |`),
    '',
    '## Top 10 规则',
    '',
    '| Rule ID | P50 | 调用 | 命中 |',
    '|---|---:|---:|---:|',
    ...report.topRules.map((rule) => `| ${cell(rule.ruleId)} | ${milliseconds(rule.duration.p50Ms)} | ${integer(rule.invocations)} | ${integer(rule.matches)} |`),
    '',
    '## 准确性保护',
    '',
    `5 次测量结果在仅忽略 ${report.semanticEquivalence.ignoredRuntimeFields.map(cell).join('、')} 后完全相等。性能优化不得减少规则覆盖、日志覆盖、诊断准确率或 Evidence。`,
    '',
    '本报告不包含输入路径、真实文件名、原始日志、Evidence 内容、序列号、资源、诊断文案、HTML、错误消息或临时目录。',
    ''
  ];
  return lines.join('\n');
}

function cell(value: string): string { return value.replaceAll('\\', '\\\\').replaceAll('|', '\\|').replaceAll('`', '\\`').replace(/[\r\n]+/g, ' '); }
function integer(value: number): string { return Math.round(value).toLocaleString('en-US'); }
function decimal(value: number): string { return value.toFixed(3); }
function milliseconds(value: number): string { return `${value.toFixed(3)} ms`; }
function percent(value: number): string { return `${value.toFixed(2)}%`; }
