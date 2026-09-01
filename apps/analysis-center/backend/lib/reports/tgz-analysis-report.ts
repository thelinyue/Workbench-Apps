import { selectImportantFindings } from '../../../shared/finding-presentation';
import type { AnalysisResult } from '../analysis-v1/pipeline';
import { escapeHtml, evidenceReportCss, renderEvidenceSection } from './evidence-report';

/** TGZ 覆盖系统、硬件和服务诊断，报告保留完整结论链，并把关键字原始日志作为工程证据附在结论之后。 */
export function renderTgzReport(result: AnalysisResult): string {
  const primary = result.diagnoses[0];
  const findings = selectImportantFindings(result.findings, primary?.findingIds).map((item) => {
    const display = item.display;
    const resources = display.affectedResources.length ? `<p>影响对象：${escapeHtml(display.affectedResources.join('、'))}</p>` : '';
    return `<li><strong>${escapeHtml(display.title)}</strong><span>${escapeHtml(display.riskLabel)} · ${escapeHtml(display.occurrenceText)}</span><p>${escapeHtml(display.meaning)}</p>${resources}<p><strong>建议：</strong>${escapeHtml(display.advice)}</p><small>技术事件：${escapeHtml(display.technicalEvent)}</small></li>`;
  }).join('') || '<li class="empty-state">未发现明确异常。</li>';
  const recommendations = result.recommendations.map((item) => `<li><strong>${item.priority}. ${escapeHtml(item.title)}</strong><p>${escapeHtml(item.reason)}</p></li>`).join('') || '<li class="empty-state">当前没有需要立即执行的建议。</li>';
  const abnormalDevices = result.deviceAssessments.filter((device) => device.smartRiskAttributes.length || device.ioErrorCount > 0);
  const deviceDetails = abnormalDevices.map((device) => `<li><strong>${escapeHtml(localizeDeviceLabel(device.label, device.resource))}</strong><span>序列号：${escapeHtml(device.serial ?? '日志未提供')} · 用途：${escapeHtml(localizeUsage(device.usedFor))}</span><small>型号：${escapeHtml(device.model ?? '日志未提供')} · 槽位：${escapeHtml(device.slot ?? '日志未提供')} · 设备名：${escapeHtml(device.resource)}</small></li>`).join('') || '<li class="empty-state">当前没有可定位的异常硬盘身份信息。</li>';
  const compatibilityNote = result.deviceAssessments.length ? '' : '<p class="notice">该分析结果未保存硬盘身份与双结论信息。</p>';
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>TGZ 系统诊断报告 · ${escapeHtml(result.metadata.source)}</title>
  <style>${tgzReportCss}${evidenceReportCss}</style>
</head>
<body data-report-format="tgz">
<main class="report-shell">
  <header class="report-header"><div><p class="report-type">HEPHAESTUS WORKBENCH · TGZ</p><h1>TGZ 系统诊断报告</h1><p>系统、硬件与服务日志综合诊断</p></div><dl><div><dt>诊断包</dt><dd>${escapeHtml(result.metadata.source)}</dd></div><div aria-label="规则包：${escapeHtml(result.metadata.rulePackVersion)}"><dt>规则包</dt><dd>${escapeHtml(result.metadata.rulePackVersion)}</dd></div></dl></header>
  <section class="report-section conclusion severity-panel-${escapeHtml(primary?.severity ?? 'info')}"><p class="section-kicker">CUSTOMER CONCLUSION</p><h2>给用户的结论</h2><p class="preline">${escapeHtml(primary?.userConclusion ?? primary?.summary ?? '本次日志范围内没有发现当前规则覆盖的高风险系统或存储故障。')}</p>${compatibilityNote}</section>
  <div class="report-grid">
    <section class="report-section"><p class="section-kicker">AFFECTED DEVICES</p><h2>异常硬盘</h2><ul class="detail-list">${deviceDetails}</ul></section>
    <section class="report-section"><p class="section-kicker">ENGINEER CONCLUSION</p><h2>给工程师的结论</h2><p class="preline">${escapeHtml(primary?.engineerConclusion ?? primary?.summary ?? '当前没有可用的工程师结论。')}</p></section>
  </div>
  ${renderEvidenceSection(result)}
  <div class="report-grid">
    <section class="report-section"><p class="section-kicker">RECOMMENDATIONS</p><h2>建议处理</h2><ol class="detail-list">${recommendations}</ol></section>
    <section class="report-section"><p class="section-kicker">OTHER FINDINGS</p><h2>其他重要发现</h2><ul class="finding-list">${findings}</ul></section>
  </div>
</main>
</body>
</html>`;
}

function localizeDeviceLabel(label: string | undefined, resource: string): string {
  if (!label) return resource;
  const m2 = label.match(/^M\.2\s+Hard Drive\s+(\d+)$/i);
  if (m2) return `M.2 硬盘 ${m2[1]}`;
  const disk = label.match(/^Hard Drive\s+(\d+)$/i);
  return disk ? `硬盘 ${disk[1]}` : label;
}

function localizeUsage(usage: string | undefined): string { return usage?.replace(/^Storage Pool\s+(\d+)$/i, '存储池 $1') ?? '日志未提供'; }

const tgzReportCss = String.raw`
:root { --page:#f5f7fa; --surface:#fff; --surface-muted:#f8fafc; --text:#172033; --text-soft:#334155; --muted:#64748b; --border:#e2e8f0; --border-strong:#cbd5e1; --accent:#1d4ed8; color:#172033; background:#f5f7fa; font:14px/1.6 "Segoe UI","Microsoft YaHei",sans-serif; }
* { box-sizing:border-box; }
body { margin:0; background:var(--page); color:var(--text); }
button, select { font:inherit; }
button, summary, select { cursor:pointer; }
button:focus-visible, select:focus-visible, summary:focus-visible { outline:3px solid rgba(37,99,235,.25); outline-offset:2px; }
.report-shell { width:min(1180px,calc(100% - 32px)); margin:24px auto 56px; }
.report-header { display:flex; align-items:flex-start; justify-content:space-between; gap:28px; padding:24px 26px; color:#fff; background:#17365d; border-radius:8px; }
.report-header h1 { margin:2px 0 4px; font-size:26px; letter-spacing:0; }
.report-header p { margin:0; color:#dbeafe; }
.report-type { font-size:12px; font-weight:700; }
.report-header dl { min-width:min(380px,42%); margin:0; }
.report-header dl div { display:grid; grid-template-columns:64px minmax(0,1fr); gap:10px; padding:5px 0; }
.report-header dt { color:#bfdbfe; }
.report-header dd { margin:0; overflow-wrap:anywhere; }
.report-section { margin-top:16px; padding:20px 22px; background:var(--surface); border:1px solid var(--border); border-radius:8px; }
.report-section h2 { margin:2px 0 12px; font-size:17px; letter-spacing:0; }
.report-section p { margin:8px 0 0; }
.conclusion { border-left:4px solid var(--accent); }
.severity-panel-critical { border-left-color:#b91c1c; }
.severity-panel-warning { border-left-color:#d97706; }
.report-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; }
.preline { white-space:pre-line; }
.notice { padding:10px 12px; color:#92400e; background:#fffbeb; border:1px solid #fde68a; border-radius:6px; }
.detail-list, .finding-list { margin:0; padding-left:20px; }
.detail-list li, .finding-list li { margin:10px 0; }
.detail-list span, .detail-list small, .finding-list span, .finding-list small { display:block; color:var(--muted); }
.finding-list p { margin:4px 0; }
.empty-state { color:var(--muted); }
@media (max-width:760px) { .report-shell{width:min(100% - 24px,1180px);margin-top:12px}.report-header{flex-direction:column;padding:20px}.report-header dl{width:100%;min-width:0}.report-grid{grid-template-columns:1fr}.report-section{padding:18px 16px} }
`;
