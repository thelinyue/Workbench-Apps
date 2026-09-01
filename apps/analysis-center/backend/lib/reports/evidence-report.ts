import type { AnalysisResult, Evidence, Finding, Severity } from '../analysis-v1/pipeline';

interface EvidenceGroupPayload {
  id: string;
  title: string;
  severity: Severity;
  keyword: string;
  evidence: Evidence[];
}

/**
 * 两种报告只共享证据呈现能力。完整 Evidence 保存在 inert JSON 中，浏览器展开问题时才创建
 * 当前页节点；这既保留离线排障信息，也避免高频关键词一次性生成大量 DOM。
 */
export function renderEvidenceSection(result: AnalysisResult): string {
  const groups = buildEvidenceGroups(result);
  if (groups.length === 0) {
    return `<section class="report-section evidence-section" aria-labelledby="evidence-title"><div class="section-heading"><div><p class="section-kicker">ENGINEERING EVIDENCE</p><h2 id="evidence-title">关键字命中日志</h2></div><span class="section-count">0 条</span></div><p class="empty-state">当前分析结果没有保存关键字命中日志。</p></section>${renderEvidenceData(groups)}`;
  }
  const total = groups.reduce((count, group) => count + group.evidence.length, 0);
  const items = groups.map((group, index) => `<details class="evidence-group" data-evidence-group="${index}">
    <summary><span class="severity-mark severity-${group.severity}">${severityLabel(group.severity)}</span><span class="evidence-summary-copy"><strong>${escapeHtml(group.title)}</strong><code>${escapeHtml(group.keyword)}</code></span><span class="evidence-total">${group.evidence.length} 条</span></summary>
    <div class="evidence-page" data-evidence-page aria-live="polite"></div>
    <nav class="evidence-pagination" data-evidence-pagination aria-label="${escapeHtml(group.title)}日志分页" hidden><button type="button" data-page-action="previous">上一页</button><span data-page-status></span><button type="button" data-page-action="next">下一页</button></nav>
  </details>`).join('');
  return `<section class="report-section evidence-section" aria-labelledby="evidence-title">
    <div class="section-heading"><div><p class="section-kicker">ENGINEERING EVIDENCE</p><h2 id="evidence-title">关键字命中日志</h2></div><span class="section-count">${total} 条</span></div>
    <div class="evidence-toolbar"><p>日志按问题折叠，展开后仅渲染当前页。</p><label for="evidencePageSize">每页条数<select id="evidencePageSize"><option value="20" selected>20</option><option value="50">50</option><option value="100">100</option></select></label></div>
    <div class="evidence-groups">${items}</div>
  </section>${renderEvidenceData(groups)}`;
}

function buildEvidenceGroups(result: AnalysisResult): EvidenceGroupPayload[] {
  const evidenceById = new Map(result.evidence.map((item) => [item.id, item]));
  const referenced = new Set<string>();
  const groups = result.findings.map((finding) => {
    const evidence = finding.evidenceIds.flatMap((id) => {
      const item = evidenceById.get(id);
      if (!item) return [];
      referenced.add(id);
      return [item];
    });
    return groupFromFinding(finding, evidence);
  });
  const remaining = result.evidence.filter((item) => !referenced.has(item.id));
  if (remaining.length) groups.push({ id: 'unlinked-evidence', title: '其他诊断证据', severity: 'info', keyword: '非关键字规则', evidence: remaining });
  return groups;
}

function groupFromFinding(finding: Finding, evidence: Evidence[]): EvidenceGroupPayload {
  return { id: finding.id, title: finding.title, severity: finding.severity, keyword: finding.matchedKeyword ?? finding.type, evidence };
}

/** JSON 必须额外转义 HTML 有意义的字符，尤其禁止日志中的 </script> 提前结束数据块。 */
function renderEvidenceData(groups: EvidenceGroupPayload[]): string {
  const json = JSON.stringify(groups).replace(/[<>&\u2028\u2029]/g, (character) => ({
    '<': '\\u003c', '>': '\\u003e', '&': '\\u0026', '\u2028': '\\u2028', '\u2029': '\\u2029'
  })[character] ?? character);
  return `<script id="evidenceReportData" type="application/json">${json}</script><script>${evidenceReportScript}</script>`;
}

export function escapeHtml(value: string): string {
  return String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character] ?? character);
}

function severityLabel(value: Severity): string { return value === 'critical' ? '严重' : value === 'warning' ? '关注' : '信息'; }

export const evidenceReportScript = String.raw`(() => {
  const dataNode = document.getElementById('evidenceReportData');
  const pageSizeControl = document.getElementById('evidencePageSize');
  const states = [];
  let groups;
  const loadGroups = () => groups || (groups = JSON.parse(dataNode?.textContent || '[]'));
  const text = (tag, className, value) => { const node = document.createElement(tag); if (className) node.className = className; node.textContent = value; return node; };
  const appendMeta = (parent, label, value, fallback) => { const item = document.createElement('span'); const display = value === undefined || value === null || value === '' ? fallback : value; item.append(text('strong', '', label + '：'), document.createTextNode(String(display))); parent.append(item); };

  function renderContext(item) {
    const box = text('div', 'log-context', '');
    const before = item.contextBefore || [];
    const after = item.contextAfter || [];
    const firstLine = item.lineNumber ? item.lineNumber - before.length : undefined;
    [...before, item.rawMessage, ...after].forEach((value, index) => {
      const line = text('div', index === before.length ? 'log-line is-hit' : 'log-line', '');
      line.append(text('span', 'log-line-number', firstLine ? String(firstLine + index) : '·'), text('code', 'log-line-text', value || ''));
      box.append(line);
    });
    return box;
  }

  function renderGroup(details) {
    const index = Number(details.dataset.evidenceGroup);
    const group = loadGroups()[index];
    if (!group) return;
    const page = details.querySelector('[data-evidence-page]');
    const pagination = details.querySelector('[data-evidence-pagination]');
    const size = Number(pageSizeControl?.value || 20);
    const pageCount = Math.max(1, Math.ceil(group.evidence.length / size));
    const state = states[index] || (states[index] = { page: 0 });
    state.page = Math.min(state.page, pageCount - 1);
    page.replaceChildren();
    const entries = group.evidence.slice(state.page * size, (state.page + 1) * size);
    if (!entries.length) page.append(text('p', 'empty-state', '该问题未保存关联日志。'));
    entries.forEach(item => {
      const article = document.createElement('article');
      article.className = 'evidence-entry';
      const meta = text('div', 'evidence-meta', '');
      appendMeta(meta, '来源', item.sourceFile, '未提供');
      appendMeta(meta, '行号', item.lineNumber, '未提供');
      appendMeta(meta, '时间', item.timestamp, '未提供');
      appendMeta(meta, '资源', item.resource, '未识别');
      article.append(meta, renderContext(item));
      page.append(article);
    });
    pagination.hidden = group.evidence.length <= size;
    const status = pagination.querySelector('[data-page-status]');
    if (status) status.textContent = '第 ' + (state.page + 1) + ' / ' + pageCount + ' 页';
    const previous = pagination.querySelector('[data-page-action="previous"]');
    const next = pagination.querySelector('[data-page-action="next"]');
    if (previous) previous.disabled = state.page === 0;
    if (next) next.disabled = state.page >= pageCount - 1;
  }

  document.querySelectorAll('[data-evidence-group]').forEach(details => {
    details.addEventListener('toggle', () => { if (details.open) renderGroup(details); });
    details.querySelector('[data-page-action="previous"]')?.addEventListener('click', () => { const index = Number(details.dataset.evidenceGroup); states[index].page -= 1; renderGroup(details); });
    details.querySelector('[data-page-action="next"]')?.addEventListener('click', () => { const index = Number(details.dataset.evidenceGroup); states[index].page += 1; renderGroup(details); });
  });
  pageSizeControl?.addEventListener('change', () => {
    states.forEach(state => { if (state) state.page = 0; });
    document.querySelectorAll('[data-evidence-group][open]').forEach(renderGroup);
  });
})();`;

export const evidenceReportCss = String.raw`
.evidence-section { padding: 0; overflow: hidden; }
.evidence-section > .section-heading { padding: 20px 22px; }
.section-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.section-heading h2 { margin: 2px 0 0; }
.section-kicker { margin: 0; color: var(--muted); font-size: 12px; font-weight: 700; letter-spacing: 0; }
.section-count { color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
.evidence-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 22px; background: var(--surface-muted); border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
.evidence-toolbar p { margin: 0; color: var(--muted); }
.evidence-toolbar label { display: flex; align-items: center; gap: 8px; white-space: nowrap; }
.evidence-toolbar select { min-height: 36px; padding: 5px 28px 5px 10px; color: var(--text); background: var(--surface); border: 1px solid var(--border-strong); border-radius: 6px; }
.evidence-group + .evidence-group { border-top: 1px solid var(--border); }
.evidence-group > summary { display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; align-items: center; gap: 12px; min-height: 56px; padding: 10px 22px; cursor: pointer; list-style: none; }
.evidence-group > summary::-webkit-details-marker { display: none; }
.evidence-group > summary::after { content: '+'; display: grid; place-items: center; width: 28px; height: 28px; color: var(--accent); border: 1px solid var(--border-strong); border-radius: 4px; font-size: 18px; line-height: 1; }
.evidence-group[open] > summary::after { content: '-'; }
.evidence-summary-copy { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.evidence-summary-copy strong { overflow-wrap: anywhere; }
.evidence-summary-copy code { color: var(--muted); font: 12px/1.45 Consolas, "SFMono-Regular", monospace; overflow-wrap: anywhere; }
.evidence-total { color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
.severity-mark { min-width: 40px; padding: 3px 7px; border-radius: 4px; text-align: center; font-size: 12px; font-weight: 700; }
.severity-critical { color: #991b1b; background: #fee2e2; }
.severity-warning { color: #92400e; background: #fef3c7; }
.severity-info { color: #1e40af; background: #dbeafe; }
.evidence-page { padding: 0 22px 18px; }
.evidence-entry { padding: 14px 0; border-top: 1px solid var(--border); }
.evidence-meta { display: flex; flex-wrap: wrap; gap: 6px 18px; margin-bottom: 8px; color: var(--muted); font-size: 12px; }
.evidence-meta strong { color: var(--text-soft); }
.log-context { overflow-x: auto; background: #111827; border: 1px solid #1f2937; border-radius: 6px; color: #d1d5db; }
.log-line { display: grid; grid-template-columns: 54px minmax(max-content, 1fr); min-height: 28px; }
.log-line.is-hit { color: #fff; background: #3f2d12; box-shadow: inset 3px 0 #f59e0b; }
.log-line-number { padding: 5px 10px; color: #94a3b8; border-right: 1px solid #334155; text-align: right; font: 12px/1.5 Consolas, monospace; user-select: none; }
.log-line-text { padding: 5px 12px; font: 13px/1.5 Consolas, "SFMono-Regular", monospace; white-space: pre; }
.evidence-pagination { display: flex; align-items: center; justify-content: flex-end; gap: 10px; padding: 0 22px 18px; }
.evidence-pagination button { min-height: 36px; padding: 6px 12px; color: var(--accent); background: var(--surface); border: 1px solid var(--border-strong); border-radius: 6px; }
.evidence-pagination button:disabled { color: #94a3b8; cursor: not-allowed; background: var(--surface-muted); }
.evidence-pagination span { min-width: 88px; color: var(--muted); text-align: center; font-variant-numeric: tabular-nums; }
@media (max-width: 640px) {
  .evidence-toolbar { align-items: flex-start; flex-direction: column; }
  .evidence-group > summary { grid-template-columns: auto minmax(0, 1fr) auto; padding-inline: 16px; }
  .evidence-group > summary::after { grid-column: 3; grid-row: 1 / span 2; }
  .evidence-total { grid-column: 2; }
  .evidence-page { padding-inline: 16px; }
  .evidence-pagination { justify-content: space-between; padding-inline: 16px; }
}`;
