import type { DiagnosticPackageFormat } from '../domain/diagnostic-package';
import type { AnalysisResult } from '../analysis-v1/pipeline';
import { renderTgzReport } from './tgz-analysis-report';
import { renderZipReport } from './zip-analysis-report';

/** 根据归档入口已经确认的格式选择报告，未知值必须失败，不能静默套用另一种诊断包模板。 */
export function renderAnalysisReport(format: DiagnosticPackageFormat, result: AnalysisResult): string {
  switch (format) {
    case 'tgz': return renderTgzReport(result);
    case 'zip': return renderZipReport(result);
    default: throw new Error(`不支持的分析报告格式：${String(format)}`);
  }
}
