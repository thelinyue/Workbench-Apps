import type { AnalysisResult, Severity } from '../analysis-v1/pipeline';
import { escapeHtml, evidenceReportCss, renderEvidenceSection } from './evidence-report';

/** ZIP 只包含三类规则日志流，报告聚焦问题与命中原文，不渲染缺少结构化依据的硬件诊断区块。 */
export function renderZipReport(result: AnalysisResult): string {
  const primary = result.diagnoses[0];
  const sourceCount = new Set(result.evidence.map((item) => item.sourceFile)).size;
  const issueRows = result.findings.map((finding) => `<tr><td><span class="severity-label severity-${finding.severity}">${severityLabel(finding.severity)}</span></td><td><strong>${escapeHtml(finding.title)}</strong><code>${escapeHtml(finding.matchedKeyword ?? finding.type)}</code></td><td>${finding.occurrenceCount}</td></tr>`).join('');
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ZIP 诊断日志分析报告 · ${escapeHtml(result.metadata.source)}</title>
  <style>${zipReportCss}${evidenceReportCss}</style>
</head>
<body data-report-format="zip">
<main class="report-shell">
  <header class="report-header"><div><p class="report-type">HEPHAESTUS WORKBENCH · ZIP</p><h1>ZIP 诊断日志分析报告</h1><p>syslog、dmsg 与存储服务日志规则分析</p></div><dl><div><dt>诊断包</dt><dd>${escapeHtml(result.metadata.source)}</dd></div><div aria-label="规则包：${escapeHtml(result.metadata.rulePackVersion)}"><dt>规则包</dt><dd>${escapeHtml(result.metadata.rulePackVersion)}</dd></div></dl></header>
  <section class="metrics" aria-label="ZIP 日志分析摘要"><div><span>问题类型</span><strong>${result.findings.length}</strong></div><div><span>命中日志</span><strong>${result.evidence.length}</strong></div><div><span>关联文件</span><strong>${sourceCount}</strong></div><div><span>最高风险</span><strong class="metric-risk severity-${primary?.severity ?? 'info'}">${severityLabel(primary?.severity ?? 'info')}</strong></div></section>
  <section class="report-section conclusion severity-panel-${escapeHtml(primary?.severity ?? 'info')}"><p class="section-kicker">RULE ANALYSIS</p><h2>规则分析结论</h2><p class="preline">${escapeHtml(primary?.engineerConclusion ?? primary?.summary ?? 'ZIP 日志没有命中当前规则覆盖的问题。')}</p></section>
  <section class="report-section issue-overview"><div class="section-heading"><div><p class="section-kicker">MATCHED ISSUES</p><h2>问题概览</h2></div><span class="section-count">${result.findings.length} 项</span></div>${issueRows ? `<div class="table-wrap"><table><thead><tr><th>级别</th><th>问题与关键字</th><th>命中</th></tr></thead><tbody>${issueRows}</tbody></table></div>` : '<p class="empty-state">当前日志没有命中配置规则。</p>'}</section>
  ${renderEvidenceSection(result)}
</main>
</body>
</html>`;
}

function severityLabel(value: Severity): string { return value === 'critical' ? '严重' : value === 'warning' ? '关注' : '信息'; }

const zipReportCss = String.raw`
:root { --page:#f4f6f8; --surface:#fff; --surface-muted:#f8fafc; --text:#172033; --text-soft:#334155; --muted:#64748b; --border:#e2e8f0; --border-strong:#cbd5e1; --accent:#0f5c5e; color:#172033; background:#f4f6f8; font:14px/1.6 "Segoe UI","Microsoft YaHei",sans-serif; }
* { box-sizing:border-box; }
body { margin:0; background:var(--page); color:var(--text); }
button, select { font:inherit; }
button, summary, select { cursor:pointer; }
button:focus-visible, select:focus-visible, summary:focus-visible { outline:3px solid rgba(15,92,94,.24); outline-offset:2px; }
.report-shell { width:min(1080px,calc(100% - 32px)); margin:24px auto 56px; }
.report-header { display:flex; align-items:flex-start; justify-content:space-between; gap:28px; padding:24px 26px; color:#fff; background:#164e63; border-radius:8px; }
.report-header h1 { margin:2px 0 4px; font-size:26px; letter-spacing:0; }
.report-header p { margin:0; color:#cffafe; }
.report-type { font-size:12px; font-weight:700; }
.report-header dl { min-width:min(380px,42%); margin:0; }
.report-header dl div { display:grid; grid-template-columns:64px minmax(0,1fr); gap:10px; padding:5px 0; }
.report-header dt { color:#a5f3fc; }
.report-header dd { margin:0; overflow-wrap:anywhere; }
.metrics { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:1px; margin-top:16px; overflow:hidden; background:var(--border); border:1px solid var(--border); border-radius:8px; }
.metrics div { min-width:0; padding:16px 18px; background:var(--surface); }
.metrics span { display:block; color:var(--muted); }
.metrics strong { display:block; margin-top:2px; font-size:22px; font-variant-numeric:tabular-nums; }
.metrics .metric-risk { width:fit-content; padding:1px 6px; border-radius:4px; font-size:16px; }
.report-section { margin-top:16px; padding:20px 22px; background:var(--surface); border:1px solid var(--border); border-radius:8px; }
.report-section h2 { margin:2px 0 12px; font-size:17px; letter-spacing:0; }
.report-section p { margin:8px 0 0; }
.conclusion { border-left:4px solid var(--accent); }
.severity-panel-critical { border-left-color:#b91c1c; }
.severity-panel-warning { border-left-color:#d97706; }
.preline { white-space:pre-line; }
.section-heading { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; }
.section-heading h2 { margin-bottom:0; }
.section-kicker { margin:0; color:var(--muted); font-size:12px; font-weight:700; letter-spacing:0; }
.section-count { color:var(--muted); white-space:nowrap; }
.table-wrap { margin-top:14px; overflow-x:auto; }
table { width:100%; border-collapse:collapse; }
th, td { padding:11px 10px; border-top:1px solid var(--border); text-align:left; vertical-align:top; }
th { color:var(--muted); font-size:12px; font-weight:600; }
td:last-child { width:64px; font-variant-numeric:tabular-nums; }
td strong, td code { display:block; }
td code { margin-top:3px; color:var(--muted); font:12px/1.45 Consolas,"SFMono-Regular",monospace; overflow-wrap:anywhere; }
.severity-label { display:inline-block; min-width:40px; padding:3px 7px; border-radius:4px; text-align:center; font-size:12px; font-weight:700; }
.severity-critical { color:#991b1b; background:#fee2e2; }
.severity-warning { color:#92400e; background:#fef3c7; }
.severity-info { color:#1e40af; background:#dbeafe; }
.empty-state { color:var(--muted); }
@media (max-width:760px) { .report-shell{width:min(100% - 24px,1080px);margin-top:12px}.report-header{flex-direction:column;padding:20px}.report-header dl{width:100%;min-width:0}.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.report-section{padding:18px 16px} }
`;
