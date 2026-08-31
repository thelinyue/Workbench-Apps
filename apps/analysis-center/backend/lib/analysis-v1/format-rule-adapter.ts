import type { DiagnosticPackageFormat } from '../domain/diagnostic-package';
import type { AnalyzerScanResult } from '../analysis/log-analyzer';
import type { AnalysisResult, Diagnosis, Evidence, Finding, Recommendation, Severity } from './pipeline';

interface FormatRuleAdapterInput {
  sourceName: string;
  format: DiagnosticPackageFormat;
  ruleVersion?: string;
  scan: AnalyzerScanResult;
}

/**
 * 将旧格式规则的文件级命中转换为当前结果页使用的 V1 数据模型。
 *
 * 这里仅做数据形状转换，不调用公共 Event Rule，也不根据日志内容推断硬盘、RAID 或存储池
 * 关系。规则文件名、关键词和证据上下文都保留在结果中，确保 TGZ 与 ZIP 的识别逻辑互不串用。
 */
export function buildV1ResultFromFormatRules(input: FormatRuleAdapterInput): AnalysisResult {
  const started = new Date();
  const evidence: Evidence[] = [];
  const groups = new Map<string, { finding: Finding; severity: Severity }>();
  let evidenceNumber = 0;
  let processedEvents = 0;

  for (const file of input.scan.analysis.files) {
    const ruleName = file.ruleName ?? file.file.replaceAll('\\', '/').split('/').at(-1) ?? 'unknown';
    const eventType = `format-rule.${input.format}.${ruleName}`;
    for (const issue of file.issues) {
      processedEvents += 1;
      const evidenceId = `evidence-${++evidenceNumber}`;
      const rawMessage = issue.contextLines.find((line) => line.hit)?.text ?? '';
      const hitIndex = issue.contextLines.findIndex((line) => line.hit);
      const contextBefore = hitIndex < 0 ? [] : issue.contextLines.slice(0, hitIndex).map((line) => line.text);
      const contextAfter = hitIndex < 0 ? [] : issue.contextLines.slice(hitIndex + 1).map((line) => line.text);
      evidence.push({
        id: evidenceId,
        ...parseEvidenceTime(rawMessage),
        sourceFile: file.file,
        lineNumber: issue.line,
        eventType,
        rawMessage: rawMessage.slice(0, 4000),
        ...(contextBefore.length ? { contextBefore } : {}),
        ...(contextAfter.length ? { contextAfter } : {})
      });

      const findingId = `${eventType}:${issue.keyword}`;
      const existing = groups.get(findingId);
      if (existing) {
        existing.finding.evidenceIds.push(evidenceId);
        existing.finding.occurrenceCount += 1;
        existing.severity = higherSeverity(existing.severity, issue.severity);
        existing.finding.severity = existing.severity;
        continue;
      }

      groups.set(findingId, {
        severity: issue.severity,
        finding: {
          id: findingId,
          type: eventType,
          category: 'format-rule',
          severity: issue.severity,
          confidence: 'high',
          title: issue.message,
          summary: `${file.category}规则命中“${issue.message}”。`,
          affectedResources: [],
          evidenceIds: [evidenceId],
          occurrenceCount: 1
        }
      });
    }
  }

  const findings = [...groups.values()].map((item) => item.finding);
  const diagnoses = [buildSummaryDiagnosis(input.format, findings, processedEvents)];
  const ended = new Date();
  const severityCounts = countSeverities(diagnoses);
  const primaryDiagnosisId = diagnoses[0]?.id;
  return {
    schemaVersion: 1,
    id: `analysis-${started.getTime()}`,
    status: 'completed',
    summary: {
      criticalCount: severityCounts.critical,
      warningCount: severityCounts.warning,
      infoCount: severityCounts.info,
      ...(primaryDiagnosisId ? { primaryDiagnosisId } : {}),
      complete: true
    },
    diagnoses,
    findings,
    evidence,
    deviceAssessments: [],
    recommendations: [] as Recommendation[],
    metadata: {
      source: input.sourceName,
      startTime: started.toISOString(),
      completeTime: ended.toISOString(),
      duration: Math.max(0, ended.getTime() - started.getTime()),
      processedFiles: input.scan.processedFiles,
      processedLines: input.scan.processedLines,
      processedEvents,
      analyzerVersion: '1.2.0',
      rulePackVersion: `${input.format}@${input.ruleVersion ?? '内置规则'}`,
      missingData: []
    }
  };
}

function buildSummaryDiagnosis(format: DiagnosticPackageFormat, findings: Finding[], processedEvents: number): Diagnosis {
  const label = format === 'tgz' ? 'TGZ' : 'ZIP';
  const severity = findings.reduce<Severity>((highest, finding) => higherSeverity(highest, finding.severity), 'info');
  const hasFindings = findings.length > 0;
  const details = findings.length
    ? findings.slice(0, 10).map((finding) => `${finding.title}（${finding.occurrenceCount} 次）`).join('；')
    : '未命中关键词规则。';
  return {
    id: `format-rule.${format}.summary`,
    category: 'format-rule',
    severity,
    confidence: 'high',
    title: hasFindings ? `${label} 规则发现异常` : `${label} 规则分析完成`,
    summary: `${label} 专用规则命中 ${processedEvents} 条日志证据。${details}`,
    affectedResources: [],
    findingIds: findings.map((finding) => finding.id),
    recommendationIds: [],
    userConclusion: hasFindings
      ? `您好，经分析诊断日志，${label} 专用规则检测到 ${processedEvents} 条异常证据：\n${details}`
      : `您好，经分析诊断日志，${label} 专用规则未命中关键词异常。`,
    engineerConclusion: hasFindings
      ? findings.map((finding) => `${finding.title}：${finding.summary}`).join('\n')
      : `${label} 专用规则未命中关键词。`
  };
}

function parseEvidenceTime(line: string): Pick<Evidence, 'timestamp' | 'timestampPrecision' | 'timestampConfidence'> {
  const match = line.match(/\b(20\d\d-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)?)\b/);
  if (!match) return { timestampPrecision: 'unknown', timestampConfidence: 'low' };
  const timestamp = new Date(match[1]!.replace(' ', 'T'));
  return Number.isNaN(timestamp.getTime())
    ? { timestampPrecision: 'unknown', timestampConfidence: 'low' }
    : { timestamp: timestamp.toISOString(), timestampPrecision: 'exact', timestampConfidence: 'confirmed' };
}

function higherSeverity(left: Severity, right: Severity): Severity {
  return severityRank(right) > severityRank(left) ? right : left;
}

function severityRank(value: Severity): number {
  return value === 'critical' ? 3 : value === 'warning' ? 2 : 1;
}

function countSeverities(diagnoses: Diagnosis[]): Record<Severity, number> {
  return diagnoses.reduce((counts, diagnosis) => {
    counts[diagnosis.severity] += 1;
    return counts;
  }, { critical: 0, warning: 0, info: 0 });
}
