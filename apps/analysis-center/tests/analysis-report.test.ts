import { Window } from 'happy-dom';
import { expect, it } from 'vitest';
import type { AnalysisResult } from '../backend/lib/analysis-v1/pipeline';
import { renderAnalysisReport } from '../backend/lib/reports/analysis-report';
import { evidenceReportScript, renderEvidenceSection } from '../backend/lib/reports/evidence-report';

const baseResult: AnalysisResult = {
  schemaVersion: 1,
  id: 'analysis-report-test',
  status: 'completed',
  summary: { criticalCount: 0, warningCount: 1, infoCount: 0, complete: true },
  diagnoses: [{
    id: 'diagnosis-1',
    category: 'format-rule',
    severity: 'warning',
    confidence: 'high',
    title: '规则发现异常',
    summary: '命中一条日志。',
    affectedResources: [],
    findingIds: ['finding-1'],
    recommendationIds: [],
    userConclusion: '用户结论',
    engineerConclusion: '工程师结论'
  }],
  findings: [{
    id: 'finding-1',
    type: 'format-rule.zip.zip_syslog',
    category: 'format-rule',
    severity: 'warning',
    confidence: 'high',
    title: 'UPS 切换',
    summary: '规则命中。',
    matchedKeyword: 'UPS <ups0@localhost> "on battery" 中文',
    affectedResources: ['ups0@localhost'],
    evidenceIds: ['evidence-1'],
    occurrenceCount: 1
  }],
  evidence: [{
    id: 'evidence-1',
    timestampPrecision: 'unknown',
    timestampConfidence: 'low',
    sourceFile: 'DEVICE_syslog',
    lineNumber: 7,
    eventType: 'format-rule.zip.zip_syslog',
    resource: 'ups0@localhost',
    rawMessage: 'UPS <ups0@localhost> </script><script>window.__injected=1</script>'
  }],
  deviceAssessments: [],
  recommendations: [],
  metadata: {
    source: 'fixture.zip',
    startTime: '2026-09-01T00:00:00.000Z',
    completeTime: '2026-09-01T00:00:01.000Z',
    duration: 1000,
    processedFiles: 1,
    processedLines: 1,
    processedEvents: 1,
    analyzerVersion: '1.2.0',
    rulePackVersion: 'zip@test',
    missingData: []
  }
};

it('报告分派严格隔离 TGZ、ZIP 与未知格式', () => {
  expect(renderAnalysisReport('tgz', baseResult)).toContain('data-report-format="tgz"');
  expect(renderAnalysisReport('zip', baseResult)).toContain('data-report-format="zip"');
  expect(() => renderAnalysisReport('rar' as 'zip', baseResult)).toThrow('不支持的分析报告格式：rar');
});

it('证据元数据固定显示来源、行号、时间和资源，缺失值明确标记', () => {
  const window = new Window();
  const { document } = window;
  document.body.innerHTML = renderEvidenceSection({
    ...baseResult,
    evidence: [{ ...baseResult.evidence[0]!, timestamp: undefined, resource: undefined }]
  });
  window.eval(evidenceReportScript);
  const group = document.querySelector<HTMLDetailsElement>('[data-evidence-group]')!;
  group.open = true;
  group.dispatchEvent(new window.Event('toggle'));

  const metadata = group.querySelector('.evidence-meta')?.textContent;
  expect(metadata).toContain('来源：DEVICE_syslog');
  expect(metadata).toContain('行号：7');
  expect(metadata).toContain('时间：未提供');
  expect(metadata).toContain('资源：未识别');
  window.close();
});

it('关键字和日志安全写入 inert JSON，不能闭合数据脚本', () => {
  const html = renderEvidenceSection(baseResult);

  expect(html).toContain('UPS \\u003cups0@localhost\\u003e \\"on battery\\" 中文');
  expect(html).toContain('\\u003c/script\\u003e\\u003cscript\\u003ewindow.__injected=1\\u003c/script\\u003e');
  expect(html).not.toContain('</script><script>window.__injected=1</script>');
  expect(html).not.toContain('<article class="evidence-entry"');
});

it('空 Evidence 生成明确空状态且仍保留安全数据区', () => {
  const html = renderEvidenceSection({ ...baseResult, findings: [], evidence: [] });

  expect(html).toContain('当前分析结果没有保存关键字命中日志');
  expect(html).toContain('<script id="evidenceReportData" type="application/json">[]</script>');
});

it('证据脚本惰性渲染当前页，并保持各问题分页状态独立', () => {
  const evidence = ['a', 'b'].flatMap((group) => Array.from({ length: 105 }, (_, index) => ({
    ...baseResult.evidence[0]!,
    id: `${group}-${index}`,
    rawMessage: `${group}-marker-${index}`
  })));
  const findings = ['a', 'b'].map((group, index) => ({
    ...baseResult.findings[0]!,
    id: `finding-${group}`,
    title: `问题 ${index + 1}`,
    evidenceIds: Array.from({ length: 105 }, (_, evidenceIndex) => `${group}-${evidenceIndex}`),
    occurrenceCount: 105
  }));
  const window = new Window();
  const { document } = window;
  document.body.innerHTML = renderEvidenceSection({ ...baseResult, findings, evidence });
  window.eval(evidenceReportScript);

  const groups = [...document.querySelectorAll<HTMLDetailsElement>('[data-evidence-group]')];
  expect(document.querySelectorAll('.evidence-entry')).toHaveLength(0);

  groups[0]!.open = true;
  groups[0]!.dispatchEvent(new window.Event('toggle'));
  expect(groups[0]!.querySelectorAll('.evidence-entry')).toHaveLength(20);
  expect(groups[0]!.querySelector('.log-line-text')?.textContent).toBe('a-marker-0');
  expect(groups[1]!.querySelectorAll('.evidence-entry')).toHaveLength(0);

  const size = document.querySelector<HTMLSelectElement>('#evidencePageSize')!;
  size.value = '50';
  size.dispatchEvent(new window.Event('change'));
  expect(groups[0]!.querySelectorAll('.evidence-entry')).toHaveLength(50);

  groups[0]!.querySelector<HTMLElement>('[data-page-action="next"]')!.click();
  expect(groups[0]!.querySelector('[data-page-status]')?.textContent).toBe('第 2 / 3 页');
  expect(groups[0]!.querySelector('.log-line-text')?.textContent).toBe('a-marker-50');

  groups[1]!.open = true;
  groups[1]!.dispatchEvent(new window.Event('toggle'));
  expect(groups[1]!.querySelector('[data-page-status]')?.textContent).toBe('第 1 / 3 页');
  expect(groups[1]!.querySelector('.log-line-text')?.textContent).toBe('b-marker-0');

  groups[0]!.querySelector<HTMLElement>('[data-page-action="next"]')!.click();
  expect(groups[0]!.querySelectorAll('.evidence-entry')).toHaveLength(5);
  expect(groups[0]!.querySelector('.log-line-text')?.textContent).toBe('a-marker-100');
  expect(groups[0]!.querySelector<HTMLButtonElement>('[data-page-action="next"]')!.disabled).toBe(true);

  groups[0]!.querySelector<HTMLElement>('[data-page-action="previous"]')!.click();
  expect(groups[0]!.querySelector('.log-line-text')?.textContent).toBe('a-marker-50');

  size.value = '100';
  size.dispatchEvent(new window.Event('change'));
  expect(groups[0]!.querySelectorAll('.evidence-entry')).toHaveLength(100);
  expect(groups[0]!.querySelector('.log-line-text')?.textContent).toBe('a-marker-0');
  expect(groups[1]!.querySelector('.log-line-text')?.textContent).toBe('b-marker-0');

  window.close();
});
