import { createReadStream } from 'node:fs';
import { lstat, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';
import extractZip from 'extract-zip';
import { assertDiagnosticArchiveIntegrity } from './archive-integrity';
import { createDiagnosticArchiveGunzip } from './tgz-stream';
import { getDiagnosticPackageFormat } from '../domain/diagnostic-package';
import {
  analyzeExtractedDirectory,
  type AnalysisResult,
  type AnalyzerRuleCatalog
} from './log-analyzer';
import { escapeHtml, renderReportTemplate, reportCss, reportScript } from './report-template';
import bootstrapCss from './static/bootstrap.min.css?raw';
import bootstrapScript from './static/bootstrap.bundle.min.js?raw';
import { analyzeStructuredExtract, type StructuredAnalysis } from './structured-analysis';
import { analyzeV1Sources, type AnalysisResult as V1AnalysisResult } from '../analysis-v1/pipeline';
import { type PipelineProfile, PipelineProfiler } from '../analysis-v1/pipeline-profiler';
import { classifyV1Source } from '../analysis-v1/source-classifier';
import { selectImportantFindings } from '../../../shared/finding-presentation';
import type { AnalysisTaskStage } from '../data/workspace-repository';

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
 * V1 归档入口只负责输入准备与单次来源读取；诊断语义完全由 analysis-v1 Pipeline 生成。
 * Legacy 的关键词扫描和旧报告函数保留在下方，不能从这个入口回退调用。
 */
export async function runV1ArchiveAnalysis(request: Pick<ArchiveAnalysisRequest, 'sourcePath' | 'extractDirectory' | 'onProgress'> & { profiler?: PipelineProfiler; runtimeTimings?: AnalysisRuntimeTimings }): Promise<V1ArchiveAnalysisResult> {
  const profiler = request.profiler;
  const runtimeTimings = request.runtimeTimings ?? createAnalysisRuntimeTimings();
  const totalStartedAt = performance.now();
  try {
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
    const files = await collectV1Sources(request.extractDirectory, runtimeTimings, profiler, (processedFiles, totalFiles) => request.onProgress?.({ progress: 35 + Math.round((processedFiles / Math.max(totalFiles, 1)) * 20), stage: 'parse-system-events', message: `正在读取日志（${processedFiles}/${totalFiles}）` }));
    if (!Object.keys(files).length) throw new Error('无法识别日志包：未找到受支持的系统或存储日志');
    request.onProgress?.({ progress: 55, stage: 'analyze-storage', message: '正在分析存储状态' });
    const result = measureRuntime(runtimeTimings, 'pipelineAnalysisMs', () => analyzeV1Sources({ sourceName: basename(request.sourcePath), files, profiler, onProgress: ({ processedFiles, totalFiles, progress }) => request.onProgress?.({ progress: 55 + Math.round(progress * 0.3), stage: 'analyze-storage', message: `正在解析日志（${processedFiles}/${totalFiles}）` }) }));
    request.onProgress?.({ progress: 85, stage: 'aggregate-anomalies', message: '正在聚合异常并关联诊断结论' });
    const browserPath = join(request.extractDirectory, 'analysis-result.html');
    const renderReport = () => writeFile(browserPath, renderV1Html(result), 'utf8');
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

/** 先收集并排序白名单文件，再逐一读取；这样进度稳定且结果不受文件系统枚举顺序影响。 */
async function collectV1Sources(root: string, runtimeTimings: AnalysisRuntimeTimings, profiler?: PipelineProfiler, onProgress?: (processedFiles: number, totalFiles: number) => void): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const candidates: Array<{ path: string; source: NonNullable<ReturnType<typeof classifyV1Source>> }> = [];
  const visit = async (directory: string): Promise<void> => {
    profiler?.increment('directoriesVisited');
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { await visit(path); continue; }
      if (!entry.isFile()) continue;
      profiler?.increment('filesDiscovered');
      const source = classifyV1Source(entry.name);
      if (!source) { profiler?.increment('filesIgnored'); continue; }
      candidates.push({ path, source });
    }
  };
  const inventory = async () => {
    profiler?.increment('fileInventoryPasses');
    await visit(root);
    // 保持原字符串数组的 UTF-16 排序语义，避免性能埋点改变 Evidence ID 和结果顺序。
    candidates.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  };
  await measureRuntimeAsync(runtimeTimings, 'sourceInventoryMs', () => profiler
    ? profiler.measureAsync('input.recognition', inventory)
    : inventory());

  const readCandidates = async () => {
    for (let index = 0; index < candidates.length; index += 1) {
      const { path, source } = candidates[index];
      const startedAt = profiler?.mark();
      try {
        const content = await readFile(path);
        const fileKey = path.slice(root.length + 1).replaceAll('\\', '/');
        files[fileKey] = content.toString('utf8');
        if (profiler) {
          profiler.increment('filesRead');
          profiler.increment('bytesRead', content.byteLength);
          profiler.increment('decodedBytes', content.byteLength);
          profiler.recordFile(fileKey, source, { bytesRead: content.byteLength, decodedBytes: content.byteLength, readDurationMs: startedAt === undefined ? 0 : profiler.elapsed(startedAt) });
        }
      }
      catch (error) {
        profiler?.increment('filesIgnored');
        console.error(`读取 V1 分析日志失败，已跳过：${path}；原因：${error instanceof Error ? error.message : String(error)}`);
      }
      onProgress?.(index + 1, candidates.length);
    }
  };
  await measureRuntimeAsync(runtimeTimings, 'sourceReadMs', () => profiler
    ? profiler.measureAsync('source.read', readCandidates)
    : readCandidates());
  return files;
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

function renderV1Html(result: V1AnalysisResult): string {
  const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const primary = result.diagnoses[0];
  const findings = selectImportantFindings(result.findings, primary?.findingIds).map((item) => {
    const display = item.display;
    const resources = display.affectedResources.length ? `<br>影响对象：${escape(display.affectedResources.join('、'))}` : '';
    return `<li><strong>${escape(display.title)}</strong><br>风险级别：${escape(display.riskLabel)} · ${escape(display.occurrenceText)}${resources}<br>${escape(display.meaning)}<br><strong>建议：</strong>${escape(display.advice)}<br><small>技术事件：${escape(display.technicalEvent)}</small></li>`;
  }).join('') || '<li>未发现明确异常。</li>';
  const recommendations = result.recommendations.map((item) => `<li><strong>${item.priority}. ${escape(item.title)}</strong><br>${escape(item.reason)}</li>`).join('') || '<li>当前没有需要立即执行的建议。</li>';
  const abnormalDevices = result.deviceAssessments.filter((device) => device.smartRiskAttributes.length || device.ioErrorCount > 0);
  const deviceDetails = abnormalDevices.map((device) => `<li><strong>${escape(localizeDeviceLabel(device.label, device.resource))}</strong><br>序列号：${escape(device.serial ?? '日志未提供')} · 用途：${escape(localizeUsage(device.usedFor))}<br><small>型号：${escape(device.model ?? '日志未提供')} · 槽位：${escape(device.slot ?? '日志未提供')} · 设备名：${escape(device.resource)}</small></li>`).join('') || '<li>当前没有可定位的异常硬盘身份信息。</li>';
  const compatibilityNote = result.deviceAssessments.length ? '' : '<p class="note">该历史结果未保存硬盘身份与双结论信息，请重新分析诊断包以查看。</p>';
  return `<!doctype html><meta charset="utf-8"><title>分析中心诊断结果</title><style>body{margin:0;background:#f5f7fa;color:#172033;font:14px "Segoe UI","Microsoft YaHei",sans-serif}main{max-width:980px;margin:32px auto;padding:0 24px}section{margin:16px 0;padding:18px;border:1px solid #d9e1ea;background:#fff}h1{font-size:24px}h2{font-size:16px}li{margin:10px 0;line-height:1.55}.critical{border-left:4px solid #c53b3b}.user{font-size:16px;line-height:1.7;white-space:pre-line}.note{color:#64748b}small{color:#475569}</style><main><h1>分析中心诊断结果</h1><p>来源：${escape(result.metadata.source)} · 规则包：${escape(result.metadata.rulePackVersion)}</p><section class="critical"><h2>给用户的结论</h2><p class="user">${escape(primary?.userConclusion ?? primary?.summary ?? '本次日志范围内没有发现当前规则覆盖的高风险系统或存储故障。')}</p>${compatibilityNote}</section><section><h2>异常硬盘</h2><ul>${deviceDetails}</ul></section><section><h2>给工程师的结论</h2><p>${escape(primary?.engineerConclusion ?? primary?.summary ?? '当前没有可用的工程师结论。')}</p></section><section><h2>建议处理</h2><ol>${recommendations}</ol></section><section><h2>其他重要发现</h2><ul>${findings}</ul></section></main>`;
}

function localizeDeviceLabel(label: string | undefined, resource: string): string { if (!label) return resource; const m2 = label.match(/^M\.2\s+Hard Drive\s+(\d+)$/i); if (m2) return `M.2 硬盘 ${m2[1]}`; const disk = label.match(/^Hard Drive\s+(\d+)$/i); return disk ? `硬盘 ${disk[1]}` : label; }
function localizeUsage(usage: string | undefined): string { return usage?.replace(/^Storage Pool\s+(\d+)$/i, '存储池 $1') ?? '日志未提供'; }

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
