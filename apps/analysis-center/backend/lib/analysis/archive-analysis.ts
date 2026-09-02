import { createReadStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';
import extractZip from 'extract-zip';
import { assertDiagnosticArchiveIntegrity } from './archive-integrity';
import { createDiagnosticArchiveGunzip } from './tgz-stream';
import { getDiagnosticPackageFormat } from '../domain/diagnostic-package';
import {
  analyzeExtractedDirectory,
  analyzeExtractedDirectoryWithStats,
  type AnalysisResult,
  type AnalyzerRuleCatalog
} from './log-analyzer';
import { escapeHtml, renderReportTemplate, reportCss, reportScript } from './report-template';
import bootstrapCss from './static/bootstrap.min.css?raw';
import bootstrapScript from './static/bootstrap.bundle.min.js?raw';
import { analyzeStructuredExtract, type StructuredAnalysis } from './structured-analysis';
import { buildV1ResultFromFormatRules } from '../analysis-v1/format-rule-adapter';
import { analyzeV1Sources, type AnalysisResult as V1AnalysisResult } from '../analysis-v1/pipeline';
import { classifyV1Source } from '../analysis-v1/source-classifier';
import { type PipelineProfile, PipelineProfiler } from '../analysis-v1/pipeline-profiler';
import { builtInAnalyzerRules } from './built-in-rules';
import { toAnalyzerRuleCatalog, type AnalysisRulePackage } from '../services/analysis-rules-service';
import type { AnalysisTaskStage } from '../data/workspace-repository';
import { renderAnalysisReport } from '../reports/analysis-report';

export type AnalysisScope = 'comprehensive' | 'storage';

export interface ArchiveAnalysisRequest {
  sourcePath: string;
  extractDirectory: string;
  rules: AnalyzerRuleCatalog;
  scope?: AnalysisScope;
  onProgress?: (progress: { progress: number; stage?: AnalysisTaskStage; message: string }) => void;
}

export interface ArchiveAnalysisResult {
  analysis: AnalysisResult;
  structured: StructuredAnalysis;
  reportPath: string;
}

export interface V1ArchiveAnalysisResult {
  result: V1AnalysisResult;
  browserPath: string;
  runtimeTimings: AnalysisRuntimeTimings;
  performanceProfile?: PipelineProfile;
}

/**
 * 发布运行时的低开销阶段耗时，只在主要边界读取时钟；逐文件和逐规则明细仍由开发 profiler 负责。
 */
export interface AnalysisRuntimeTimings {
  archiveValidationMs: number;
  archiveExtractionMs: number;
  sourceInventoryMs: number;
  sourceReadMs: number;
  pipelineAnalysisMs: number;
  reportRenderMs: number;
  totalMs: number;
}

export function createAnalysisRuntimeTimings(): AnalysisRuntimeTimings {
  return {
    archiveValidationMs: 0,
    archiveExtractionMs: 0,
    sourceInventoryMs: 0,
    sourceReadMs: 0,
    pipelineAnalysisMs: 0,
    reportRenderMs: 0,
    totalMs: 0
  };
}

/**
 * 活动归档入口只执行当前归档格式对应的关键词规则，再将命中结果适配成 V1 AnalysisResult。
 * 公共 Event Rule 和旧的全量报告入口都不参与这里的规则选择，确保两种格式严格隔离。
 */
export async function runV1ArchiveAnalysis(request: Pick<ArchiveAnalysisRequest, 'sourcePath' | 'extractDirectory' | 'onProgress'> & { rulePackage?: AnalysisRulePackage; profiler?: PipelineProfiler; runtimeTimings?: AnalysisRuntimeTimings }): Promise<V1ArchiveAnalysisResult> {
  const profiler = request.profiler;
  const runtimeTimings = request.runtimeTimings ?? createAnalysisRuntimeTimings();
  const totalStartedAt = performance.now();
  try {
    const activeRules = request.rulePackage ? toAnalyzerRuleCatalog(request.rulePackage) : builtInAnalyzerRules;
    const recognizeInput = async () => {
      const format = getDiagnosticPackageFormat(request.sourcePath);
      if (!format) throw new Error('仅支持 .tgz、.tgz.temp 或 .zip 格式的诊断包');
      request.onProgress?.({ progress: 5, stage: 'identify-package', message: '正在验证诊断包' });
      if (format === 'tgz') await measureRuntimeAsync(runtimeTimings, 'archiveValidationMs', () => assertDiagnosticArchiveIntegrity(request.sourcePath));
      return format;
    };
    const archiveFormat = profiler
      ? await profiler.measureAsync('input.recognition', recognizeInput)
      : await recognizeInput();
    const extractArchive = async () => {
      await prepareExtractDirectory(request.extractDirectory);
      try {
        request.onProgress?.({ progress: 15, stage: 'identify-package', message: '正在解压诊断包' });
        if (archiveFormat === 'tgz') {
          await pipeline(
            createReadStream(request.sourcePath),
            createDiagnosticArchiveGunzip(),
            tar.x({ cwd: request.extractDirectory, strict: true })
          );
        }
        else await extractDiagnosticZip(request.sourcePath, request.extractDirectory);
      } catch (error) {
        throw new Error(`无法解压诊断包：${error instanceof Error ? error.message : String(error)}`);
      }
    };
    await measureRuntimeAsync(runtimeTimings, 'archiveExtractionMs', () => profiler
      ? profiler.measureAsync('archive.extract', extractArchive)
      : extractArchive());
    request.onProgress?.({ progress: 35, stage: 'parse-system-events', message: '正在识别系统与存储日志' });
    const scan = await measureRuntimeAsync(runtimeTimings, 'sourceReadMs', () => {
      const scanOperation = () => analyzeExtractedDirectoryWithStats(
        request.extractDirectory,
        activeRules[archiveFormat],
        ({ processedFiles, totalFiles }) => request.onProgress?.({ progress: 35 + Math.round((processedFiles / Math.max(totalFiles, 1)) * 20), stage: 'parse-system-events', message: `正在读取日志（${processedFiles}/${totalFiles}）` })
      );
      return profiler ? profiler.measureAsync('source.read', scanOperation) : scanOperation();
    });
    if (scan.matchedFiles === 0) throw new Error('无法识别日志包：未找到受支持的系统或存储日志');
    request.onProgress?.({ progress: 55, stage: 'analyze-storage', message: '正在分析存储状态' });
    const structuredSources = archiveFormat === 'tgz'
      ? await measureRuntimeAsync(runtimeTimings, 'sourceInventoryMs', () => collectV1Sources(request.extractDirectory))
      : undefined;
    const composed = measureRuntime(runtimeTimings, 'pipelineAnalysisMs', () => {
      const compose = () => {
        const formatResult = buildV1ResultFromFormatRules({ sourceName: basename(request.sourcePath), format: archiveFormat, ruleVersion: activeRules[archiveFormat].version, scan });
        if (archiveFormat === 'zip') return { result: formatResult, formatResult };

        // TGZ 同时保留格式规则和结构化诊断：前者只提供补充证据，后者决定主诊断与设备结论。
        const structuredResult = analyzeV1Sources({
          sourceName: basename(request.sourcePath),
          files: structuredSources ?? {},
          ...(request.rulePackage ? {
            eventRules: request.rulePackage.v1.eventRules,
            findingRules: request.rulePackage.v1.findingRules,
            diagnosisRules: request.rulePackage.v1.diagnosisRules,
            recommendations: request.rulePackage.v1.recommendations,
            rulePackVersion: request.rulePackage.version
          } : {}),
          profiler,
          onProgress: ({ processedFiles, totalFiles }) => request.onProgress?.({
            progress: 55 + Math.round((processedFiles / Math.max(totalFiles, 1)) * 30),
            stage: 'analyze-storage',
            message: `正在分析存储状态（${processedFiles}/${totalFiles}）`
          })
        });
        return { result: mergeTgzResults(structuredResult, formatResult), formatResult };
      };
      // 结构化分析自身会记录 diagnosis.compose；ZIP 保持原有的格式规则计时阶段。
      return profiler && archiveFormat === 'zip' ? profiler.measure('diagnosis.compose', compose) : compose();
    });
    recordFormatScanProfile(profiler, archiveFormat, scan, composed.formatResult, archiveFormat === 'zip');
    const result = composed.result;
    request.onProgress?.({ progress: 85, stage: 'aggregate-anomalies', message: '正在聚合异常并关联诊断结论' });
    const browserPath = join(request.extractDirectory, 'analysis-result.html');
    // 归档识别结果是报告模板选择的唯一来源，禁止从文件名、规则版本或 Finding ID 反推格式。
    const renderReport = () => writeFile(browserPath, renderAnalysisReport(archiveFormat, result), 'utf8');
    await measureRuntimeAsync(runtimeTimings, 'reportRenderMs', () => profiler
      ? profiler.measureAsync('report.render', renderReport)
      : renderReport());
    request.onProgress?.({ progress: 98, stage: 'form-conclusion', message: '正在形成诊断结论' });
    return profiler
      ? { result, browserPath, runtimeTimings, performanceProfile: profiler.snapshot() }
      : { result, browserPath, runtimeTimings };
  } finally {
    runtimeTimings.totalMs += elapsedSince(totalStartedAt);
  }
}

type RuntimeStageName = Exclude<keyof AnalysisRuntimeTimings, 'totalMs'>;

async function measureRuntimeAsync<T>(timings: AnalysisRuntimeTimings, stage: RuntimeStageName, operation: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();
  try { return await operation(); }
  finally { timings[stage] += elapsedSince(startedAt); }
}

function measureRuntime<T>(timings: AnalysisRuntimeTimings, stage: RuntimeStageName, operation: () => T): T {
  const startedAt = performance.now();
  try { return operation(); }
  finally { timings[stage] += elapsedSince(startedAt); }
}

function elapsedSince(startedAt: number): number {
  return Math.max(0, performance.now() - startedAt);
}

/** 让开发性能快照保留格式扫描的真实文件和规则指标，但不伪造公共 V1 Parser 阶段。 */
function recordFormatScanProfile(profiler: PipelineProfiler | undefined, format: 'tgz' | 'zip', scan: Awaited<ReturnType<typeof analyzeExtractedDirectoryWithStats>>, result: V1AnalysisResult, includeDiagnosisMetrics = true): void {
  if (!profiler) return;
  const processedEvents = scan.analysis.files.reduce((count, file) => count + file.issues.length, 0);
  profiler.increment('fileInventoryPasses');
  profiler.increment('filesDiscovered', scan.processedFiles);
  profiler.increment('filesRead', scan.matchedFiles);
  profiler.increment('filesIgnored', scan.processedFiles - scan.matchedFiles);
  profiler.increment('linesProcessed', scan.processedLines);
  profiler.increment('candidateLines', scan.processedLines);
  profiler.increment('ruleInvocations', processedEvents);
  profiler.increment('ruleMatches', processedEvents);
  profiler.increment('eventsCreated', processedEvents);
  profiler.increment('findingsCreated', result.findings.length);
  profiler.increment('evidenceRetained', result.evidence.length);
  if (includeDiagnosisMetrics) {
    profiler.increment('diagnosesCreated', result.diagnoses.length);
    profiler.increment('recommendationsCreated', result.recommendations.length);
  }
  profiler.increment('findingEvidenceReferences', result.findings.reduce((count, finding) => count + finding.evidenceIds.length, 0));
  profiler.increment('uniqueFindingEvidenceReferences', new Set(result.findings.flatMap((finding) => finding.evidenceIds)).size);
  for (const file of scan.fileStats ?? []) {
    if (!profiler.hasFile(file.file)) profiler.recordFile(file.file, 'format-rule', { bytesRead: file.bytesRead, decodedBytes: file.decodedBytes });
    profiler.addFileMetrics(file.file, { linesProcessed: file.linesProcessed, eventsCreated: file.issueCount, evidenceRetained: file.issueCount });
    profiler.recordRule(`format-rule.${format}.${file.ruleName}`, file.issueCount, file.issueCount > 0, 0);
  }
}

/**
 * TGZ 解压目录中只读取结构化引擎认可的来源，避免将格式规则专用日志或报告产物当作诊断输入。
 * 返回相对路径是为了保留原始日志来源，确保诊断证据可以回溯到归档内的文件。
 */
async function collectV1Sources(extractDirectory: string): Promise<Record<string, string>> {
  try {
    const files = await listExtractedFiles(extractDirectory);
    const sources = await Promise.all(files
      .map((filePath) => relative(extractDirectory, filePath).replaceAll('\\', '/'))
      .filter((sourceFile) => classifyV1Source(sourceFile))
      .map(async (sourceFile) => {
        try {
          return [sourceFile, await readFile(join(extractDirectory, sourceFile), 'utf8')] as const;
        } catch (error) {
          throw new Error(`读取结构化日志失败：${sourceFile}；原因：${error instanceof Error ? error.message : String(error)}`);
        }
      }));
    return Object.fromEntries(sources);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('读取结构化日志失败：')) throw error;
    throw new Error(`收集结构化日志失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function listExtractedFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const filePath = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listExtractedFiles(filePath));
    else if (entry.isFile()) files.push(filePath);
  }
  return files.sort((left, right) => left.localeCompare(right));
}

/**
 * 合并 TGZ 的两种分析结果。结构化结果的 Diagnosis、设备身份和建议保持原样；格式规则的
 * Finding/Evidence 追加到结果尾部，并为新 Evidence 分配稳定且不冲突的 ID。
 */
function mergeTgzResults(structured: V1AnalysisResult, formatRules: V1AnalysisResult): V1AnalysisResult {
  const usedEvidenceIds = new Set(structured.evidence.map((item) => item.id));
  const evidenceIdMap = new Map<string, string>();
  let nextEvidenceNumber = structured.evidence.length + 1;
  const formatEvidence = formatRules.evidence.map((item) => {
    let id = `evidence-${nextEvidenceNumber++}`;
    while (usedEvidenceIds.has(id)) id = `evidence-${nextEvidenceNumber++}`;
    usedEvidenceIds.add(id);
    evidenceIdMap.set(item.id, id);
    return { ...item, id };
  });
  const formatFindings = formatRules.findings.map((finding) => ({
    ...finding,
    evidenceIds: finding.evidenceIds.map((id) => evidenceIdMap.get(id)!).filter((id): id is string => Boolean(id))
  }));
  return {
    ...structured,
    findings: [...structured.findings, ...formatFindings],
    evidence: [...structured.evidence, ...formatEvidence],
    metadata: {
      ...structured.metadata,
      processedFiles: formatRules.metadata.processedFiles,
      processedLines: formatRules.metadata.processedLines,
      processedEvents: structured.metadata.processedEvents + formatRules.metadata.processedEvents,
      rulePackVersion: formatRules.metadata.rulePackVersion
    }
  };
}

/**
 * 分析中心的归档执行入口。
 *
 * 该函数对应旧日志分析插件的“解压 → 规则扫描 → 固定 Report/index.html”协议，
 * 但不再启动独立插件进程：规则与报告生成均在工作台内部完成。
 */
export async function runArchiveAnalysis(request: ArchiveAnalysisRequest): Promise<ArchiveAnalysisResult> {
  const archiveFormat = getDiagnosticPackageFormat(request.sourcePath);
  if (!archiveFormat) {
    throw new Error('仅支持 .tgz、.tgz.temp 或 .zip 格式的诊断包');
  }

  request.onProgress?.({ progress: 5, message: '正在准备诊断包' });

  if (archiveFormat === 'tgz') await assertDiagnosticArchiveIntegrity(request.sourcePath);

  await prepareExtractDirectory(request.extractDirectory);

  try {
    request.onProgress?.({ progress: 12, message: '正在解压诊断包' });
    if (archiveFormat === 'tgz') {
      await tar.x({ file: request.sourcePath, cwd: request.extractDirectory, gzip: true, strict: true });
    } else {
      await extractDiagnosticZip(request.sourcePath, request.extractDirectory);
    }
  } catch (error) {
    throw new Error(`无法解压诊断包：${error instanceof Error ? error.message : String(error)}`);
  }

  request.onProgress?.({ progress: 30, message: '正在扫描日志文件' });
  const analysis = await analyzeExtractedDirectory(request.extractDirectory, request.rules[archiveFormat], ({ processedFiles, totalFiles }) => {
    request.onProgress?.({ progress: 30 + Math.round((processedFiles / Math.max(totalFiles, 1)) * 40), message: `正在扫描日志文件（${processedFiles}/${totalFiles}）` });
  });
  request.onProgress?.({ progress: 70, message: '正在分析系统与存储信息' });
  const structured = await analyzeStructuredExtract(request.extractDirectory, analysis, archiveFormat);
  request.onProgress?.({ progress: 88, message: '正在生成分析报告' });
  const reportDirectory = join(request.extractDirectory, 'Report');
  const reportPath = join(reportDirectory, 'index.html');
  await writeReportArtifacts(reportDirectory, basename(request.sourcePath), analysis, structured, request.scope ?? 'comprehensive', request.rules[archiveFormat].version ?? '内置规则');
  request.onProgress?.({ progress: 98, message: '正在完成报告索引' });

  return { analysis, structured, reportPath };
}

/**
 * 同级解压目录允许复用并合并写入，但不能把普通文件或符号链接当作目录。
 * 这里只准备根目录，不清理既有内容；旧文件继续参与扫描是产品已确认的合并语义。
 */
async function prepareExtractDirectory(extractDirectory: string): Promise<void> {
  try {
    const info = await lstat(extractDirectory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (info?.isSymbolicLink()) throw new Error('解压路径不能是符号链接');
    if (info && !info.isDirectory()) throw new Error('解压路径已存在且不是文件夹');
    if (!info) await mkdir(extractDirectory, { recursive: true });
  } catch (error) {
    throw new Error(`无法准备诊断包解压目录：${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * ZIP 诊断包只允许普通文件和目录。extract-zip 上游会直接创建符号链接，
 * 因此必须在写入磁盘前拒绝该条目，避免归档通过链接指向解压目录之外。
 */
async function extractDiagnosticZip(sourcePath: string, extractDirectory: string): Promise<void> {
  await extractZip(sourcePath, {
    dir: extractDirectory,
    onEntry: (entry) => {
      const unixMode = entry.externalFileAttributes >>> 16;
      if ((unixMode & 0o170000) === 0o120000) {
        throw new Error(`ZIP 诊断包包含不安全的符号链接条目：${entry.fileName}`);
      }
    }
  });
}

/** 保留插件的 Report/static 与 Report/structured 目录约定，所有报告产物均可独立打开。 */
async function writeReportArtifacts(directory: string, sourceName: string, analysis: AnalysisResult, structured: StructuredAnalysis, scope: AnalysisScope, ruleVersion: string): Promise<void> {
  const staticDirectory = join(directory, 'static');
  const structuredDirectory = join(directory, 'structured');
  await mkdir(staticDirectory, { recursive: true });
  await mkdir(structuredDirectory, { recursive: true });
  await Promise.all([
    writeFile(join(staticDirectory, 'bootstrap.min.css'), bootstrapCss, 'utf8'),
    writeFile(join(staticDirectory, 'bootstrap.bundle.min.js'), bootstrapScript, 'utf8'),
    writeFile(join(structuredDirectory, 'analysis.json'), JSON.stringify(analysis, null, 2), 'utf8'),
    writeFile(join(structuredDirectory, 'storage-health.json'), JSON.stringify(structured, null, 2), 'utf8'),
    writeFile(join(structuredDirectory, 'sysinfo.json'), JSON.stringify(structured.sysInfo, null, 2), 'utf8'),
    writeFile(join(structuredDirectory, 'network.json'), JSON.stringify(structured.networks, null, 2), 'utf8'),
    writeFile(join(structuredDirectory, 'lsblk.txt'), structured.blockDevicesRaw, 'utf8'),
    writeFile(join(structuredDirectory, 'lsblk.html'), renderListPage('块设备信息', structured.blockDevices), 'utf8'),
    writeFile(join(directory, 'index.html'), renderReportTemplate({ sourceName, analysis, structured, scope, ruleVersion }), 'utf8')
  ]);
}

function renderListPage(title: string, rows: string[]): string { return `<!doctype html><meta charset="utf-8"><link href="../static/bootstrap.min.css" rel="stylesheet"><style>${reportCss}</style><main class="dashboard"><section class="hero"><h1>${escapeHtml(title)}</h1></section><section class="raw-log-box">${escapeHtml(rows.join('\n') || '未提供数据')}</section></main>`; }
