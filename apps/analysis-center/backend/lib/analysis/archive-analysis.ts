import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import * as tar from 'tar';
import extractZip from 'extract-zip';
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

export type AnalysisScope = 'comprehensive' | 'storage';

export interface ArchiveAnalysisRequest {
  sourcePath: string;
  extractDirectory: string;
  rules: AnalyzerRuleCatalog;
  scope?: AnalysisScope;
  onProgress?: (progress: { progress: number; message: string }) => void;
}

export interface ArchiveAnalysisResult {
  analysis: AnalysisResult;
  structured: StructuredAnalysis;
  reportPath: string;
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

  await rm(request.extractDirectory, { recursive: true, force: true });
  await mkdir(request.extractDirectory, { recursive: true });

  try {
    request.onProgress?.({ progress: 12, message: '正在解压诊断包' });
    if (archiveFormat === 'tgz') {
      await tar.x({ file: request.sourcePath, cwd: request.extractDirectory, gzip: true, strict: true });
    } else {
      await extractZip(request.sourcePath, { dir: request.extractDirectory });
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
