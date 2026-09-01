import { describe, expect, it } from 'vitest';
import { buildV1ResultFromFormatRules } from '../backend/lib/analysis-v1/format-rule-adapter';
import type { AnalyzerScanResult } from '../backend/lib/analysis/log-analyzer';

describe('格式规则 V1 结果适配器', () => {
  it('格式日志没有关键词命中时仍生成格式专用汇总 Diagnosis', () => {
    const result = buildV1ResultFromFormatRules({
      sourceName: 'diagnostic.zip',
      format: 'zip',
      ruleVersion: '2026.08.26',
      scan: {
        analysis: { files: [] },
        processedFiles: 1,
        matchedFiles: 1,
        processedLines: 3,
        fileStats: []
      }
    });

    expect(result.diagnoses).toEqual([expect.objectContaining({
      id: 'format-rule.zip.summary',
      severity: 'info',
      title: 'ZIP 规则分析完成',
      findingIds: [],
      recommendationIds: []
    })]);
    expect(result.summary.primaryDiagnosisId).toBe('format-rule.zip.summary');
  });

  it('将选中格式的规则命中转换为 Evidence、Finding 和汇总 Diagnosis', () => {
    const scan: AnalyzerScanResult = {
      analysis: {
        files: [{
          file: 'DEVICE_syslog',
          ruleName: 'zip_syslog',
          category: '系统日志',
          issues: [
            {
              keyword: 'UPS ups0@localhost on battery',
              message: 'UPS 已切换至电池供电',
              severity: 'warning',
              line: 2,
              contextLines: [
                { number: 1, text: '前一行', hit: false },
                { number: 2, text: 'UPS ups0@localhost on battery', hit: true },
                { number: 3, text: '后一行', hit: false }
              ]
            },
            {
              keyword: 'UPS ups0@localhost on battery',
              message: 'UPS 已切换至电池供电',
              severity: 'warning',
              line: 8,
              contextLines: [{ number: 8, text: 'UPS ups0@localhost on battery', hit: true }]
            }
          ]
        }]
      },
      processedFiles: 1,
      matchedFiles: 1,
      processedLines: 8,
      fileStats: []
    };

    const result = buildV1ResultFromFormatRules({
      sourceName: 'diagnostic.zip',
      format: 'zip',
      ruleVersion: '2026.08.26',
      scan
    });

    expect(result.metadata.rulePackVersion).toBe('zip@2026.08.26');
    expect(result.metadata.processedFiles).toBe(1);
    expect(result.metadata.processedLines).toBe(8);
    expect(result.metadata.processedEvents).toBe(2);
    expect(result.findings).toEqual([expect.objectContaining({
      id: 'format-rule.zip.zip_syslog:UPS ups0@localhost on battery',
      type: 'format-rule.zip.zip_syslog',
      title: 'UPS 已切换至电池供电',
      matchedKeyword: 'UPS ups0@localhost on battery',
      occurrenceCount: 2,
      evidenceIds: ['evidence-1', 'evidence-2']
    })]);
    expect(result.evidence[0]).toMatchObject({
      id: 'evidence-1',
      sourceFile: 'DEVICE_syslog',
      lineNumber: 2,
      eventType: 'format-rule.zip.zip_syslog',
      resource: 'ups0@localhost',
      rawMessage: 'UPS ups0@localhost on battery',
      contextBefore: ['前一行'],
      contextAfter: ['后一行']
    });
    expect(result.diagnoses[0]).toMatchObject({
      id: 'format-rule.zip.summary',
      findingIds: ['format-rule.zip.zip_syslog:UPS ups0@localhost on battery'],
      recommendationIds: []
    });
  });
});
