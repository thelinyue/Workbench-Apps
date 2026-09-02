import { parentPort, workerData } from 'node:worker_threads';
import { createAnalysisRuntimeTimings, runV1ArchiveAnalysis } from './archive-analysis';
import { PipelineProfiler } from '../analysis-v1/pipeline-profiler';
import type { AnalysisRulePackage } from '../services/analysis-rules-service';

interface AnalysisWorkerInput {
  sourcePath: string;
  extractDirectory: string;
  rulePackage?: AnalysisRulePackage;
  performanceProfiling?: boolean;
}

/**
 * 分析中心私有 Worker。
 *
 * 归档解压和日志扫描可能消耗大量 CPU 与磁盘 I/O，必须从 Electron 主线程移出；Worker 只接收
 * 经主进程构造的路径和内置规则，不向渲染层暴露任何可执行能力。轻量阶段耗时在成功和失败
 * 消息中都会返回，确保慢任务和校验异常能够由 backend 统一记录。
 */
void (async () => {
  const runtimeTimings = createAnalysisRuntimeTimings();
  try {
    const input = workerData as AnalysisWorkerInput;
    const profiler = input.performanceProfiling ? new PipelineProfiler() : undefined;
    const result = await runV1ArchiveAnalysis({ sourcePath: input.sourcePath, extractDirectory: input.extractDirectory, rulePackage: input.rulePackage, profiler, runtimeTimings, onProgress: (progress) => parentPort?.postMessage({ type: 'progress', ...progress }) });
    parentPort?.postMessage({ type: 'completed', succeeded: true, browserPath: result.browserPath, analysisResult: result.result, runtimeTimings, ...(result.performanceProfile ? { performanceProfile: result.performanceProfile } : {}) });
  } catch (error) {
    parentPort?.postMessage({ type: 'completed', succeeded: false, errorMessage: error instanceof Error ? error.message : String(error), runtimeTimings });
  }
})();
