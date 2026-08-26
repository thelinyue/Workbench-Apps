import type { AnalysisIssue, AnalysisResult, IssueSeverity } from './log-analyzer';
import type { HealthLevel, MemoryModule, NetworkInterfaceCard, SmartAttribute, StorageDisk, StructuredAnalysis } from './structured-analysis';

export type ReportScope = 'comprehensive' | 'storage';

export interface ReportTemplateOptions {
  sourceName: string;
  analysis: AnalysisResult;
  structured: StructuredAnalysis;
  scope: ReportScope;
  ruleVersion: string;
}

interface ReportFileGroup {
  file: string;
  category: string;
  groups: IssueGroup[];
}

interface IssueGroup {
  keyword: string;
  message: string;
  severity: IssueSeverity;
  issues: AnalysisIssue[];
}

/**
 * 报告展示层独立于分析引擎：这里将当前 TypeScript 数据模型适配为旧版离线仪表盘，
 * 生成的 HTML、CSS 与脚本只使用本地资源，确保用户可以直接双击报告查看。
 */
export function renderReportTemplate(options: ReportTemplateOptions): string {
  return options.scope === 'storage' ? renderStorageReportTemplate(options) : renderComprehensiveReportTemplate(options);
}

function renderComprehensiveReportTemplate(options: ReportTemplateOptions): string {
  const { sourceName, analysis, structured, scope, ruleVersion } = options;
  const files = groupIssues(analysis);
  const issues = analysis.files.flatMap((file) => file.issues);
  const categories = unique(analysis.files.map((file) => file.category));
  const keywords = unique(issues.map((issue) => issue.keyword));
  const reportMode = '综合分析';
  const diagnosticClass = healthClass(structured.overallHealth);
  const diagnosticTarget = structured.sysInfo && Object.keys(structured.sysInfo).length > 0 ? 'sysinfoAnchor' : 'recommendationsAnchor';

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>系统日志诊断报告 · ${escapeHtml(sourceName)}</title>
  <link href="static/bootstrap.min.css" rel="stylesheet">
  <style>${reportCss}</style>
</head>
<body>
<main class="dashboard">
  <section class="hero">
    <div class="hero-heading">
      <div>
        <p class="eyebrow">HEPHAESTUS WORKBENCH · ${escapeHtml(reportMode)}</p>
        <h1>系统日志诊断报告</h1>
        <p class="hero-subtitle">快速判断风险，定位故障根因，查看关键日志上下文</p>
      </div>
      <span class="report-badge">规则 ${escapeHtml(ruleVersion || '内置规则')}</span>
    </div>
    <div class="hero-meta"><span>生成时间：${escapeHtml(new Date().toLocaleString('zh-CN', { hour12: false }))}</span><span>诊断包：${escapeHtml(sourceName)}</span></div>
  </section>

  <section class="diagnostic-banner ${diagnosticClass}" id="diagnosticSummary">
    <div class="diagnostic-copy"><div class="small-label">快速诊断结论</div><div class="diagnostic-message">${escapeHtml(structured.customerReply)}</div></div>
    <button class="outline-button" type="button" data-detail-target="${diagnosticTarget}">查看详情</button>
  </section>

  <section class="metrics-grid" aria-label="分析摘要">
    ${renderMetricCard('规则问题', issues.length, issues.some((issue) => issue.severity === 'critical') ? 'critical' : '')}
    ${renderMetricCard('存储证据', structured.evidence.length, structured.evidence.length > 0 ? 'alert' : '')}
    ${renderMetricCard('物理硬盘', structured.disks.length, structured.disks.some((disk) => disk.health === 'critical') ? 'critical' : '')}
    ${renderMetricCard('网络信息', structured.networks.length, '')}
  </section>

  <div class="dashboard-layout">
    <aside class="layout-left">
      ${renderSystemPanel(structured)}
      ${renderRecommendations(structured)}
    </aside>

    <section class="layout-center">
      ${renderBlockDevices(structured)}
      <section class="toolbar">
        <div class="toolbar-grid">
          <label class="sr-only" for="searchInput">搜索</label>
          <input id="searchInput" class="form-control" type="search" placeholder="搜索文件、关键词、问题描述或日志内容">
          <label class="sr-only" for="categoryFilter">分类</label>
          <select id="categoryFilter" class="form-select"><option value="">全部分类</option>${categories.map((value) => `<option>${escapeHtml(value)}</option>`).join('')}</select>
          <label class="sr-only" for="keywordFilter">关键词</label>
          <select id="keywordFilter" class="form-select"><option value="">全部关键词</option>${keywords.map((value) => `<option>${escapeHtml(value)}</option>`).join('')}</select>
          <div class="toolbar-actions"><button id="expandAll" class="outline-button" type="button">展开全部</button><button id="collapseAll" class="quiet-button" type="button">收起全部</button><button id="clearFilters" class="quiet-button" type="button">清空筛选</button></div>
        </div>
        <label class="nowrap-control"><input type="checkbox" id="nowrapToggle"><span>日志保持单行并支持横向滚动</span><span id="visibleCount" class="visible-count"></span></label>
      </section>

      <section id="resultsList">
        ${files.length === 0 ? '<div class="empty-state metric-card">未发现匹配问题，当前日志没有命中配置规则。</div>' : files.map((file, index) => renderFileCard(file, index)).join('')}
        <div id="filterEmpty" class="empty-state metric-card hidden-by-filter">没有符合当前筛选条件的结果。</div>
      </section>
    </section>

    <aside class="layout-right">
      ${renderNetworkPanel(structured.networks, 'networkAnchor')}
      ${renderTextPanel('RAID 信息', structured.raids, 'raidAnchor')}
      ${renderTextPanel('卷与文件系统', structured.volumes, 'volumeAnchor')}
      ${renderTextPanel('关键存储证据', structured.evidence, 'evidenceAnchor')}
      ${renderTextPanel('系统原始信息', [JSON.stringify(structured.sysInfo, null, 2)], 'rawSysinfoAnchor')}
    </aside>
  </div>
</main>
<script src="static/bootstrap.bundle.min.js"></script>
<script>${reportScript}</script>
</body>
</html>`;
}

/** 存储健康分析使用原始离线仪表盘的设备健康结构，不显示通用规则筛选和日志结果占位。 */
function renderStorageReportTemplate(options: ReportTemplateOptions): string {
  const { sourceName, structured, ruleVersion } = options;
  const diagnosticTarget = storageDiagnosticTarget(structured);
  const statistics = storageStatistics(structured);
  const summary = storageSummary(structured);
  const rootCause = storageRootCause(structured);
  const confidence = structured.evidence.length > 0 || structured.disks.length > 0 ? '中' : '低';
  const evidence = storageEvidence(structured);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>系统日志诊断报告 · ${escapeHtml(sourceName)}</title>
  <link href="static/bootstrap.min.css" rel="stylesheet">
  <style>${reportCss}</style>
</head>
<body>
<main class="dashboard storage-report">
  <section class="hero">
    <div class="hero-heading">
      <div>
        <p class="eyebrow">HEPHAESTUS WORKBENCH · 存储健康分析</p>
        <h1>系统日志诊断报告</h1>
        <p class="hero-subtitle">快速判断风险，定位故障根因，查看存储健康证据</p>
      </div>
      <span class="report-badge">规则 ${escapeHtml(ruleVersion || '内置规则')}</span>
    </div>
    <div class="hero-meta"><span>生成时间：${escapeHtml(new Date().toLocaleString('zh-CN', { hour12: false }))}</span><span>诊断包：${escapeHtml(sourceName)}</span></div>
  </section>

  <section class="metrics" aria-label="存储健康统计">
    <div class="metric"><span>物理硬盘</span><strong>${statistics.recognizedDisks} / ${statistics.expectedDisks}</strong><span>掉线 ${statistics.missingDisks} · 异常 ${statistics.abnormalDisks}</span></div>
    <div class="metric"><span>存储池 / RAID</span><strong>${statistics.pools}</strong><span>异常 ${statistics.abnormalPools}</span></div>
    <div class="metric"><span>存储空间</span><strong>${statistics.volumes}</strong><span>异常 ${statistics.abnormalVolumes}</span></div>
    <div class="metric"><span>文件系统异常</span><strong>${structured.raids.length > 0 ? structured.raids.length : 0}</strong><span>需要工程师确认</span></div>
    <div class="metric"><span>工程处理项</span><strong>${statistics.engineerActionItems}</strong><span>仅生成建议，不自动操作</span></div>
  </section>

  <section class="panel summary ${healthClass(structured.overallHealth)}" id="diagnosticSummary">
    <div class="section-head"><div><div class="text-muted">故障摘要</div><h2>${escapeHtml(summary)}</h2></div><span class="tag ${healthClass(structured.overallHealth)}">${escapeHtml(healthLabel(structured.overallHealth))}</span></div>
    <div class="facts"><div class="fact"><span>根因判断</span><strong>${escapeHtml(rootCause)}</strong></div><div class="fact"><span>可信度</span><strong>${confidence}</strong></div></div>
    <button class="outline-button" type="button" data-detail-target="${diagnosticTarget}">查看详情</button>
  </section>

  <div class="workspace">
    <section class="panel"><div class="section-head"><h2>存储拓扑与异常链路</h2><span class="text-muted">Disk → RAID → Volume → Filesystem → Mount</span></div>
      ${renderStorageTopology(structured)}
      <div class="section"><h2>物理硬盘</h2>${structured.disks.length > 0 ? structured.disks.map((disk, index) => renderDiskCard(disk, index)).join('') : '<p class="text-muted">未识别到物理硬盘快照。</p>'}</div>
    </section>
    <section class="panel"><h2>根因、证据与处理建议</h2><div class="section" id="evidenceAnchor"><h3>证据时间线</h3>${evidence || '<p class="text-muted">日志中没有可追溯的存储证据。</p>'}</div><div class="section"><h3>工程师处理建议</h3><ol class="recommendations">${structured.recommendations.map((value) => `<li>${escapeHtml(value)}</li>`).join('')}</ol><p class="text-muted">安全边界：报告不会自动执行 fsck、xfs_repair、RAID 或 LVM 写操作。</p></div></section>
  </div>
  <section class="customer"><div class="section-head"><h2>客户回复话术</h2><button id="copyReply" class="copy" type="button">复制话术</button></div><div id="customerReply" class="reply">${escapeHtml(structured.customerReply)}</div></section>
</main>
<script src="static/bootstrap.bundle.min.js"></script>
<script>${reportScript}</script>
</body>
</html>`;
}

function storageStatistics(data: StructuredAnalysis): { expectedDisks: number; recognizedDisks: number; missingDisks: number; abnormalDisks: number; pools: number; abnormalPools: number; volumes: number; abnormalVolumes: number; engineerActionItems: number } {
  const abnormalDisks = data.disks.filter((disk) => disk.health === 'critical' || disk.health === 'attention').length;
  const pools = data.raids.filter(Boolean).length;
  const volumes = data.volumes.filter(Boolean).length;
  return { expectedDisks: data.disks.length, recognizedDisks: data.disks.length, missingDisks: 0, abnormalDisks, pools, abnormalPools: data.overallHealth === 'critical' ? pools : 0, volumes, abnormalVolumes: data.overallHealth === 'critical' ? volumes : 0, engineerActionItems: data.recommendations.length };
}

function storageSummary(data: StructuredAnalysis): string { return data.overallHealth === 'critical' ? '检测到存储相关异常，需要优先保护数据并安排工程师检查。' : data.overallHealth === 'attention' ? '检测到需要关注的存储证据，建议安排工程师进一步确认。' : '当前未检测到需要立即处理的严重存储风险。'; }
function storageRootCause(data: StructuredAnalysis): string { return data.evidence[0] ? data.evidence[0] : data.disks.find((disk) => disk.health !== 'normal')?.evidence[0] ?? '未形成明确根因，需结合现场状态确认。'; }
function storageEvidence(data: StructuredAnalysis): string { const values = [...data.evidence, ...data.disks.flatMap((disk) => disk.evidence)]; return values.map((value, index) => `<div class="evidence"><div><strong>存储证据</strong></div><div class="evidence-time">时间未知 · 诊断日志</div><div>${escapeHtml(value)}</div></div>`).filter((_value, index) => index < 300).join(''); }
function renderStorageTopology(data: StructuredAnalysis): string { const disk = data.disks[0]; if (!disk && data.raids.length === 0 && data.volumes.length === 0) return '<p class="text-muted">日志中没有足够信息建立完整链路，以下仍保留已识别证据，不推测缺失节点。</p>'; return `<div class="chain">${disk ? `<div class="node ${healthClass(disk.health)}"><div class="node-head"><strong>${escapeHtml(disk.device || disk.name || '未命名硬盘')}</strong><span class="tag ${healthClass(disk.health)}">${escapeHtml(healthLabel(disk.health))}</span></div><div class="text-muted">${escapeHtml(disk.evidence[0] || '未见明确异常')}</div></div>` : ''}${data.raids[0] ? `<div class="arrow">↓</div><div class="node"><strong>${escapeHtml(data.raids[0])}</strong></div>` : ''}${data.volumes[0] ? `<div class="arrow">↓</div><div class="node"><strong>${escapeHtml(data.volumes[0])}</strong></div>` : ''}</div>`; }

function renderMetricCard(label: string, value: number, tone: string): string {
  return `<div class="metric-card ${tone}"><div class="metric-label">${escapeHtml(label)}</div><div class="metric-value">${value}</div></div>`;
}

function renderSystemPanel(data: StructuredAnalysis): string {
  const hasSysInfo = Object.keys(data.sysInfo).length > 0;
  const overview = [
    ['设备型号', firstString(data.sysInfo, ['deviceName', 'model', 'device_model'])],
    ['序列号', firstString(data.sysInfo, ['sn', 'serial', 'serial_number', 'serialNumber'])],
    ['固件版本', firstString(data.sysInfo, ['systemVersion', 'firmware', 'firmwareVersion'])],
    ['平台架构', firstString(data.sysInfo, ['platform', 'architecture', 'arch'])]
  ];
  if (!hasSysInfo && data.memory.length === 0 && data.disks.length === 0) return '<div class="empty-state metric-card">未采集设备概览。</div>';

  return `<details class="sysinfo-card" id="sysinfoAnchor">
    <summary class="panel-summary"><span>设备概览</span><span class="badge bg-primary">sysinfo.json</span></summary>
    <div class="overview-grid">${overview.map(([label, value]) => `<div class="overview-item"><div class="info-label">${escapeHtml(label)}</div><div class="info-value">${escapeHtml(value || '未知')}</div></div>`).join('')}</div>
    ${data.memory.length > 0 ? `<details class="nested-details"><summary>内存信息 <span class="badge bg-secondary">${data.memory.length} 条</span></summary><div class="memory-grid">${data.memory.map(renderMemoryCard).join('')}</div></details>` : ''}
    ${data.disks.length > 0 ? renderDiskPanel(data.disks) : ''}
  </details>`;
}

function renderDiskPanel(disks: StorageDisk[]): string {
  const names = disks.map((disk) => disk.name || disk.label || '未命名硬盘').join('、');
  return `<details class="nested-details" id="disksAnchor"><summary>硬盘与 SMART <span class="badge bg-primary">${disks.length} 块</span><span class="text-muted disk-name-list">${escapeHtml(names)}</span></summary><div class="disk-grid">${disks.map((disk, index) => renderDiskCard(disk, index)).join('')}</div></details>`;
}

function renderDiskCard(disk: StorageDisk, index: number): string {
  const title = disk.name || disk.label || disk.device || `未命名硬盘 ${index + 1}`;
  const focusedSmart = disk.smart.filter((attribute) => [5, 197, 198].includes(attribute.id));
  const smartTable = focusedSmart.length > 0 ? `<div class="smart-focus">${renderSmartTable(focusedSmart)}</div>` : '';
  const allSmart = disk.smart.length > 0 ? `<details class="all-smart-details"><summary>查看全部 SMART（${disk.smart.length} 条）</summary>${renderSmartTable(disk.smart)}</details>` : '';
  return `<details class="disk-card" id="diagnosticDisk-${index}">
    <summary class="disk-card-summary"><div><div class="file-name">${escapeHtml(title)}</div><div class="text-muted">${escapeHtml(disk.model || '型号未知')}</div></div><span class="badge ${diskHealthClass(disk.health)}">${escapeHtml(healthLabel(disk.health))}</span></summary>
    <div class="disk-details"><div class="info-grid disk-info-grid">
      ${renderDiskInfo('label', disk.label)}${renderDiskInfo('设备路径', disk.device)}${renderDiskInfo('容量', disk.capacity)}${renderDiskInfo('接口', disk.interfaceType)}${renderDiskInfo('槽位', disk.slot)}${renderDiskInfo('序列号', disk.serial)}${renderDiskInfo('温度', disk.temperature ? `${disk.temperature} °C` : '')}${renderDiskInfo('通电时长', disk.powerOnHours)}${renderDiskInfo('品牌', disk.brand)}${renderDiskInfo('存储用途', disk.usedFor)}
    </div>
    ${smartTable || (disk.smart.length === 0 ? '<div class="empty-inline">未采集 SMART 属性。</div>' : '')}
    ${allSmart}
    ${disk.evidence.length > 0 ? `<div class="smart-risk-note">${escapeHtml(disk.evidence.join('\n'))}</div>` : ''}</div>
  </details>`;
}

function renderSmartTable(attributes: SmartAttribute[]): string {
  return `<div class="table-wrap"><table class="smart-table"><thead><tr><th>ID</th><th>属性</th><th>当前</th><th>Worst</th><th>阈值</th><th>RAW</th><th>状态</th></tr></thead><tbody>${attributes.map((attribute) => `<tr><td>${attribute.id}</td><td>${escapeHtml(attribute.name || '未命名属性')}</td><td>${escapeHtml(attribute.value || '未采集')}</td><td>${escapeHtml(attribute.worst || '未采集')}</td><td>${escapeHtml(attribute.threshold || '未采集')}</td><td>${escapeHtml(attribute.raw || '未采集')}</td><td><span class="badge ${smartClass(attribute.status)}">${escapeHtml(attribute.status || '未知')}</span></td></tr>`).join('')}</tbody></table></div>`;
}

function renderMemoryCard(module: MemoryModule): string {
  return `<div class="overview-item"><div class="info-label">大小</div><div class="info-value">${escapeHtml(module.size || '未采集')}</div><div class="info-label memory-label">品牌</div><div class="small text-break">${escapeHtml(module.manufacturer || '未知')}</div><div class="info-label memory-label">型号</div><div class="small text-break">${escapeHtml(module.model || '未知')}</div></div>`;
}

function renderDiskInfo(label: string, value: string): string {
  return `<div><span class="info-label">${escapeHtml(label)}：</span><span class="text-break">${escapeHtml(value || '未采集')}</span></div>`;
}

function renderNetworkPanel(networks: NetworkInterfaceCard[], id: string): string {
  if (networks.length === 0) return '';
  return `<details class="sysinfo-card" id="${escapeHtml(id)}"><summary class="panel-summary"><span>网络接口信息</span><span class="badge bg-primary">${networks.length} 个接口</span></summary><div class="table-wrap"><table class="network-table"><thead><tr><th>接口</th><th>MAC 地址</th><th>IPv4</th><th>IPv6</th><th>状态</th><th>MTU</th></tr></thead><tbody>${networks.map((network) => `<tr><td class="file-name">${escapeHtml(network.name || '未命名接口')}</td><td class="text-break"><code>${escapeHtml(network.mac || '未采集')}</code></td><td class="text-break">${escapeHtml(network.ipv4.join('、') || '无')}</td><td class="text-break">${escapeHtml(network.ipv6.join('、') || '无')}</td><td><span class="badge ${networkStatusClass(network.status)}">${escapeHtml(network.status || '未知')}</span><div class="text-muted network-state">${escapeHtml([network.state, network.carrier].filter(Boolean).join(' · ') || '状态未知')}</div></td><td>${escapeHtml(network.mtu || '未采集')}</td></tr>`).join('')}</tbody></table></div></details>`;
}

function renderRecommendations(data: StructuredAnalysis): string {
  return `<details class="sysinfo-card" id="recommendationsAnchor"><summary class="panel-summary"><span>故障摘要与处理建议</span><span class="badge ${healthClass(data.overallHealth)}">${escapeHtml(healthLabel(data.overallHealth))}</span></summary><div class="summary-card"><p>${escapeHtml(data.customerReply)}</p><ol>${data.recommendations.map((value) => `<li>${escapeHtml(value)}</li>`).join('')}</ol></div></details>`;
}

function renderBlockDevices(data: StructuredAnalysis): string {
  if (!data.blockDevicesRaw && data.blockDevices.length === 0) return '';
  return `<details class="sysinfo-card layout-block"><summary class="panel-summary"><span>块设备信息</span><span class="badge bg-secondary">${data.blockDevices.length} 行</span></summary><div class="raw-log-box">${escapeHtml(data.blockDevicesRaw || data.blockDevices.join('\n') || '未提供数据')}</div><p class="panel-link"><a href="structured/lsblk.html">打开独立块设备页面</a></p></details>`;
}

function renderTextPanel(title: string, values: string[], id: string): string {
  const content = values.filter((value) => value.trim()).join('\n');
  if (!content) return '';
  return `<details class="sysinfo-card" id="${escapeHtml(id)}"><summary class="panel-summary"><span>${escapeHtml(title)}</span><span class="badge bg-secondary">${values.filter((value) => value.trim()).length} 项</span></summary><div class="raw-log-box">${escapeHtml(content)}</div></details>`;
}

function storageDiagnosticTarget(data: StructuredAnalysis): string {
  const riskyDisk = data.disks.findIndex((disk) => disk.health === 'critical' || disk.smart.some((attribute) => /风险|异常|fail|critical|warning/i.test(attribute.status)));
  if (riskyDisk >= 0) return `diagnosticDisk-${riskyDisk}`;
  if (data.evidence.length > 0) return 'evidenceAnchor';
  return Object.keys(data.sysInfo).length > 0 || data.disks.length > 0 ? 'sysinfoAnchor' : 'recommendationsAnchor';
}

function renderFileCard(file: ReportFileGroup, index: number): string {
  const bodyId = `fileCollapse-${index}`;
  const searchText = [file.file, file.category, ...file.groups.flatMap((group) => [group.keyword, group.message, ...group.issues.flatMap((issue) => issue.contextLines.map((line) => line.text))])].join(' ');
  return `<article class="result-card" data-category="${escapeHtml(file.category)}" data-search="${escapeHtml(searchText)}"><button class="result-head" type="button" data-result-toggle="${bodyId}" aria-expanded="false" aria-controls="${bodyId}"><span class="result-arrow">▸</span><div class="result-title"><div class="file-name">${escapeHtml(file.file)}</div><div class="text-muted">${escapeHtml(file.category)}</div></div><span class="badge severity-critical rounded-pill">${file.groups.length} 个问题</span></button><div id="${bodyId}" class="result-body" hidden>${file.groups.map((group) => renderIssueGroup(group)).join('')}</div></article>`;
}

function renderIssueGroup(group: IssueGroup): string {
  const searchText = [group.keyword, group.message, ...group.issues.flatMap((issue) => issue.contextLines.map((line) => line.text))].join(' ');
  const context = group.issues.flatMap((issue) => issue.contextLines).map((line) => `<div class="context-line ${line.hit ? 'context-line-hit' : ''}"><span class="line-number">${line.number}</span><code class="context-text">${escapeHtml(line.text)}</code></div>`).join('');
  return `<details class="issue-group" data-keyword="${escapeHtml(group.keyword)}" data-severity="${escapeHtml(group.severity)}"><summary class="issue-head"><span class="badge ${severityClass(group.severity)}">${escapeHtml(severityLabel(group.severity))}</span><span class="badge keyword-badge">${escapeHtml(group.keyword)}</span><span class="issue-title-message">${escapeHtml(group.message)}</span><span class="text-muted issue-count">${group.issues.length} 次命中</span></summary><div class="issue-item" data-search="${escapeHtml(searchText)}"><div class="context-box"><button class="copy-context outline-button" type="button">复制全部上下文</button>${context || '<div class="empty-inline">未提供上下文。</div>'}</div></div></details>`;
}

function groupIssues(analysis: AnalysisResult): ReportFileGroup[] {
  const files = new Map<string, ReportFileGroup>();
  analysis.files.forEach((file) => {
    const fileKey = `${file.file}\u0000${file.category}`;
    let groupedFile = files.get(fileKey);
    if (!groupedFile) {
      groupedFile = { file: file.file, category: file.category, groups: [] };
      files.set(fileKey, groupedFile);
    }
    file.issues.forEach((issue) => {
      const groupKey = `${issue.keyword}\u0000${issue.message}\u0000${issue.severity}`;
      const group = groupedFile.groups.find((item) => `${item.keyword}\u0000${item.message}\u0000${item.severity}` === groupKey);
      if (group) group.issues.push(issue);
      else groupedFile.groups.push({ keyword: issue.keyword, message: issue.message, severity: issue.severity, issues: [issue] });
    });
  });
  return [...files.values()];
}

function firstString(value: unknown, keys: string[]): string {
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = firstString(item, keys);
      if (result) return result;
    }
    return '';
  }
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const actualKey = Object.keys(record).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
    const candidate = actualKey ? record[actualKey] : undefined;
    if (typeof candidate === 'string' || typeof candidate === 'number' || typeof candidate === 'boolean') return String(candidate);
  }
  for (const child of Object.values(record)) {
    const result = firstString(child, keys);
    if (result) return result;
  }
  return '';
}

function unique(values: string[]): string[] { return [...new Set(values.filter((value) => value.trim()))]; }

function healthClass(health: HealthLevel): string { return `diagnostic-${health}`; }
function diskHealthClass(health: HealthLevel): string { return health === 'critical' ? 'smart-risk' : health === 'unknown' ? 'smart-unknown' : health === 'attention' ? 'smart-attention' : 'smart-normal'; }
function smartClass(status: string): string { return /风险|异常|fail|critical|warning/i.test(status) ? 'smart-risk' : /未知|unknown/i.test(status) ? 'smart-unknown' : 'smart-normal'; }
function networkStatusClass(status: string): string { return /正常|ok|up/i.test(status) ? 'status-ok' : /未连接|offline|down/i.test(status) ? 'status-offline' : 'status-unknown'; }
function severityClass(severity: IssueSeverity): string { return `severity-${severity}`; }
function severityLabel(severity: IssueSeverity): string { return severity === 'critical' ? '严重' : severity === 'warning' ? '关注' : '信息'; }
function healthLabel(health: HealthLevel): string { return health === 'critical' ? '严重风险' : health === 'attention' ? '需要关注' : health === 'normal' ? '正常' : '未知'; }

export function escapeHtml(value: string): string {
  return String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character] ?? character);
}

/** 旧版报告使用单文件脚本实现筛选与折叠，保持离线报告不依赖外部 UI 框架。 */
export const reportScript = String.raw`(function () {
  const cards = Array.from(document.querySelectorAll('.result-card'));
  const search = document.getElementById('searchInput');
  const category = document.getElementById('categoryFilter');
  const keyword = document.getElementById('keywordFilter');
  const visibleCount = document.getElementById('visibleCount');
  const filterEmpty = document.getElementById('filterEmpty');
  const normalize = value => (value || '').toLocaleLowerCase();

  function applyFilters() {
    const query = normalize(search && search.value);
    const selectedCategory = normalize(category && category.value);
    const selectedKeyword = normalize(keyword && keyword.value);
    let visibleCards = 0;
    let visibleIssues = 0;
    cards.forEach(card => {
      const cardText = normalize(card.dataset.search);
      const categoryMatch = !selectedCategory || normalize(card.dataset.category) === selectedCategory;
      let cardHasIssue = false;
      card.querySelectorAll('.issue-group').forEach(group => {
        const keywordMatch = !selectedKeyword || normalize(group.dataset.keyword) === selectedKeyword;
        let groupHasIssue = false;
        group.querySelectorAll('.issue-item').forEach(issue => {
          const issueMatch = (!query || cardText.includes(query) || normalize(issue.dataset.search).includes(query)) && keywordMatch;
          issue.classList.toggle('hidden-by-filter', !issueMatch);
          if (issueMatch) { groupHasIssue = true; visibleIssues += 1; }
        });
        group.classList.toggle('hidden-by-filter', !groupHasIssue);
        if (groupHasIssue) cardHasIssue = true;
      });
      const showCard = categoryMatch && cardHasIssue;
      card.classList.toggle('hidden-by-filter', !showCard);
      if (showCard) visibleCards += 1;
    });
    if (filterEmpty) filterEmpty.classList.toggle('hidden-by-filter', visibleCards !== 0 || cards.length === 0);
    if (visibleCount) visibleCount.textContent = '当前显示 ' + visibleCards + ' 个文件、' + visibleIssues + ' 条记录';
  }

  function setResultOpen(card, open) {
    const button = card.querySelector('[data-result-toggle]');
    const body = button && document.getElementById(button.dataset.resultToggle);
    if (!button || !body) return;
    body.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    const arrow = button.querySelector('.result-arrow');
    if (arrow) arrow.textContent = open ? '▾' : '▸';
  }

  document.querySelectorAll('[data-result-toggle]').forEach(button => button.addEventListener('click', () => {
    const card = button.closest('.result-card');
    if (!card) return;
    setResultOpen(card, button.getAttribute('aria-expanded') !== 'true');
  }));
  document.getElementById('expandAll')?.addEventListener('click', () => { cards.forEach(card => setResultOpen(card, true)); document.querySelectorAll('details').forEach(detail => { detail.open = true; }); });
  document.getElementById('collapseAll')?.addEventListener('click', () => { cards.forEach(card => setResultOpen(card, false)); document.querySelectorAll('details').forEach(detail => { detail.open = false; }); });
  [search, category, keyword].forEach(control => control?.addEventListener('input', applyFilters));
  document.getElementById('clearFilters')?.addEventListener('click', () => { if (search) search.value = ''; if (category) category.value = ''; if (keyword) keyword.value = ''; applyFilters(); });
  document.querySelectorAll('[data-detail-target]').forEach(button => button.addEventListener('click', () => {
    const target = document.getElementById(button.dataset.detailTarget);
    if (!target) return;
    if (target.tagName === 'DETAILS') target.open = true;
    let ancestor = target.parentElement && target.parentElement.closest('details');
    while (ancestor) { ancestor.open = true; ancestor = ancestor.parentElement && ancestor.parentElement.closest('details'); }
    target.querySelectorAll('details').forEach(detail => { detail.open = true; });
    target.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  }));
  document.getElementById('nowrapToggle')?.addEventListener('change', event => document.querySelectorAll('.context-box').forEach(box => box.classList.toggle('nowrap', event.target.checked)));
  document.querySelectorAll('.copy-context').forEach(button => button.addEventListener('click', async () => {
    const text = Array.from(button.parentElement.querySelectorAll('.context-text')).map(line => line.textContent).join('\n');
    try {
      if (!navigator.clipboard) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(text);
      button.textContent = '已复制';
    } catch (_) {
      button.textContent = '复制失败';
    }
    window.setTimeout(() => { button.textContent = '复制全部上下文'; }, 1200);
  }));
  document.getElementById('copyReply')?.addEventListener('click', async function () {
    const button = this;
    const reply = document.getElementById('customerReply');
    if (!reply) return;
    try {
      if (!navigator.clipboard) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(reply.innerText);
      button.textContent = '已复制';
    } catch (_) {
      button.textContent = '复制失败';
    }
    window.setTimeout(() => { button.textContent = '复制话术'; }, 1200);
  });
  applyFilters();
})();`;

export const reportCss = String.raw`:root {
  --brand: #2563eb;
  --ink: #172033;
  --muted: #64748b;
  --line: #e2e8f0;
  --surface: #ffffff;
  --page: #f1f5f9;
  font-family: "Segoe UI", "Microsoft YaHei", sans-serif;
  color: var(--ink);
  background: var(--page);
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--page); color: var(--ink); }
button, input, select { font: inherit; }
button, select { cursor: pointer; }
.dashboard { max-width: 1500px; margin: 0 auto; padding: 28px 20px 60px; }
.hero { padding: 28px 32px; color: #fff; border-radius: 18px; background: linear-gradient(135deg, #1d4ed8, #2563eb 58%, #38bdf8); box-shadow: 0 12px 30px rgba(37, 99, 235, .2); }
.hero-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; }
.eyebrow, .small-label { margin: 0 0 8px; font-size: .72rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
.hero h1 { margin: 0 0 8px; font-size: clamp(1.65rem, 3vw, 2.35rem); }
.hero-subtitle { margin: 0; color: rgba(255, 255, 255, .88); }
.report-badge, .badge { display: inline-flex; align-items: center; width: fit-content; padding: 5px 9px; border-radius: 999px; font-size: .74rem; font-weight: 700; white-space: nowrap; }
.report-badge { color: #1d4ed8; background: #eff6ff; }
.hero-meta { display: flex; flex-wrap: wrap; gap: 8px 20px; margin-top: 24px; color: rgba(255, 255, 255, .88); font-size: .88rem; }
.diagnostic-banner { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-top: 18px; padding: 18px 22px; border: 1px solid transparent; border-radius: 14px; box-shadow: 0 5px 16px rgba(15, 23, 42, .08); }
.diagnostic-critical { color: #991b1b; background: #fef2f2; border-color: #fecaca; }
.diagnostic-attention { color: #9a3412; background: #fff7ed; border-color: #fed7aa; }
.diagnostic-normal { color: #166534; background: #f0fdf4; border-color: #bbf7d0; }
.diagnostic-unknown { color: #475569; background: #f8fafc; border-color: #e2e8f0; }
.small-label { margin-bottom: 4px; }
.diagnostic-message { font-weight: 600; }
.metrics-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-top: 18px; }
.metric-card, .toolbar, .result-card, .summary-card, .sysinfo-card { background: var(--surface); border: 1px solid var(--line); border-radius: 14px; box-shadow: 0 4px 14px rgba(15, 23, 42, .05); }
.metric-card { padding: 18px 20px; border-left: 4px solid var(--brand); }
.metric-card.alert { border-left-color: #dc2626; }
.metric-card.critical { border-left-color: #991b1b; }
.metric-label, .info-label, .text-muted { color: var(--muted); }
.metric-value { margin-top: 3px; font-size: 1.8rem; font-weight: 700; }
.dashboard-layout { display: grid; grid-template-columns: minmax(220px, .9fr) minmax(420px, 1.8fr) minmax(220px, .9fr); gap: 18px; margin-top: 18px; align-items: start; }
.layout-left, .layout-right, .layout-center { min-width: 0; display: flex; flex-direction: column; gap: 18px; }
.sysinfo-card { padding: 20px; overflow: hidden; }
.panel-summary { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 24px; font-size: 1rem; font-weight: 700; cursor: pointer; list-style: none; }
.panel-summary::-webkit-details-marker, .disk-card-summary::-webkit-details-marker { display: none; }
.sysinfo-card[open] > .panel-summary { padding-bottom: 18px; margin-bottom: 18px; border-bottom: 1px solid var(--line); }
.overview-grid, .memory-grid, .disk-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.overview-item { min-width: 0; padding: 13px 15px; background: #f8fafc; border: 1px solid var(--line); border-radius: 11px; }
.info-value { margin-top: 5px; font-size: 1.02rem; font-weight: 600; overflow-wrap: anywhere; }
.nested-details { margin-top: 18px; padding-top: 18px; border-top: 1px solid #eef2f7; }
.nested-details > summary { cursor: pointer; font-weight: 700; list-style: none; }
.nested-details > summary::-webkit-details-marker { display: none; }
.nested-details > summary::before { content: '▶'; display: inline-block; margin-right: 8px; color: var(--muted); font-size: .7rem; }
.nested-details[open] > summary::before { content: '▼'; }
.memory-grid, .disk-grid { margin-top: 14px; }
.disk-grid { grid-template-columns: 1fr; }
.disk-card { overflow: hidden; background: #fff; border: 1px solid var(--line); border-radius: 11px; }
.disk-card-summary { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px; cursor: pointer; list-style: none; }
.disk-card[open] .disk-card-summary { border-bottom: 1px solid var(--line); }
.disk-details { padding: 14px; }
.info-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; font-size: .86rem; }
.info-grid > div { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.smart-normal, .status-ok { color: #15803d; background: #dcfce7; }
.smart-risk, .status-risk { color: #b91c1c; background: #fee2e2; }
.smart-attention { color: #9a3412; background: #ffedd5; }
.smart-unknown { color: #475569; background: #e2e8f0; }
.smart-table { width: 100%; border-collapse: collapse; font-size: .78rem; }
.smart-table th, .smart-table td { padding: 8px 6px; border-bottom: 1px solid #eef2f7; text-align: left; vertical-align: middle; }
.smart-table th { color: var(--muted); font-weight: 600; }
.table-wrap { margin-top: 14px; overflow-x: auto; }
.smart-risk-note { margin-top: 14px; padding: 10px 12px; color: #991b1b; white-space: pre-wrap; background: #fff1f2; border: 1px solid #fecdd3; border-radius: 8px; font-size: .86rem; }
.summary-card { padding: 18px 20px; border-left: 4px solid #dc2626; box-shadow: none; }
.summary-card p { margin: 0; line-height: 1.6; }
.summary-card ol { margin: 12px 0 0; padding-left: 20px; line-height: 1.7; }
.toolbar { position: sticky; top: 12px; z-index: 10; padding: 18px; }
.toolbar-grid { display: grid; grid-template-columns: minmax(150px, 1.6fr) minmax(110px, .8fr) minmax(110px, .8fr); gap: 8px; align-items: center; }
.form-control, .form-select { width: 100%; min-height: 38px; padding: 8px 10px; color: var(--ink); background: #fff; border: 1px solid #cbd5e1; border-radius: 8px; outline: none; }
.form-control:focus, .form-select:focus, button:focus-visible { border-color: var(--brand); box-shadow: 0 0 0 3px rgba(37, 99, 235, .18); outline: none; }
.toolbar-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; grid-column: 1 / -1; }
.outline-button, .quiet-button { min-height: 34px; padding: 7px 11px; border-radius: 7px; font-size: .82rem; }
.outline-button { color: #1d4ed8; background: #fff; border: 1px solid #93c5fd; }
.quiet-button { color: #475569; background: #f8fafc; border: 1px solid var(--line); }
.outline-button:hover, .quiet-button:hover { filter: brightness(.97); }
.nowrap-control { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 14px; color: var(--muted); font-size: .82rem; }
.visible-count { margin-left: 4px; }
.result-card { overflow: hidden; transition: box-shadow .2s, transform .2s; }
.result-card:hover { box-shadow: 0 8px 22px rgba(15, 23, 42, .1); transform: translateY(-1px); }
.result-head { display: flex; width: 100%; align-items: center; gap: 12px; padding: 17px 18px; color: var(--ink); text-align: left; background: #fff; border: 0; }
.result-head:hover { background: #f8fafc; }
.result-arrow { color: var(--brand); font-size: 1.15rem; }
.result-title { flex: 1; min-width: 0; }
.file-name { font-weight: 700; overflow-wrap: anywhere; word-break: break-word; }
.result-title .text-muted { margin-top: 4px; font-size: .82rem; }
.result-body { border-top: 1px solid var(--line); }
#resultsList { display: flex; flex-direction: column; gap: 12px; }
.issue-group { border-top: 1px solid #eef2f7; }
.issue-group:first-child { border-top: 0; }
.issue-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 14px 18px; background: #f8fafc; cursor: pointer; list-style: none; }
.issue-head::-webkit-details-marker { display: none; }
.issue-head::before { content: '▶'; color: var(--muted); font-size: .7rem; }
.issue-group[open] > .issue-head::before { content: '▼'; }
.issue-title-message { color: #334155; font-weight: 600; overflow-wrap: anywhere; }
.issue-count { margin-left: auto; font-size: .78rem; }
.keyword-badge { color: #92400e; background: #fef3c7; }
.severity-critical { color: #991b1b; background: #fee2e2; }
.severity-warning { color: #92400e; background: #fef3c7; }
.severity-info { color: #1d4ed8; background: #dbeafe; }
.issue-item { padding: 18px; border-top: 1px solid #eef2f7; }
.context-box, .raw-log-box { position: relative; padding: 14px; color: #dbeafe; background: #0f172a; border-radius: 10px; }
.context-box { overflow: auto; }
.context-box.nowrap .context-text { white-space: pre; }
.context-line { display: flex; gap: 12px; min-width: max-content; line-height: 1.55; }
.context-line-hit { color: #fff; background: rgba(220, 38, 38, .5); border-radius: 3px; }
.line-number { min-width: 42px; color: #94a3b8; text-align: right; user-select: none; }
.context-text { flex: 1; min-width: 0; color: inherit; white-space: pre-wrap; overflow-wrap: anywhere; font: .82rem/1.55 Consolas, "Cascadia Code", monospace; }
.context-box.nowrap .context-text { overflow-x: auto; overflow-wrap: normal; }
.raw-log-box { max-height: 420px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font: .82rem/1.55 Consolas, "Cascadia Code", monospace; }
.panel-link { margin: 12px 0 0; font-size: .86rem; }
a { color: #1d4ed8; }
.storage-layout { grid-template-columns: minmax(340px, 1.25fr) minmax(280px, 1fr) minmax(320px, 1.2fr); }
.storage-report .overview-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.storage-report .memory-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.storage-report .disk-name-list { margin-left: 8px; font-size: .8rem; font-weight: 400; }
.memory-label { margin-top: 10px; }
.disk-info-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.all-smart-details { margin-top: 14px; padding-top: 12px; border-top: 1px solid #eef2f7; }
.all-smart-details > summary { color: #1d4ed8; cursor: pointer; font-size: .82rem; }
.network-table { width: 100%; border-collapse: collapse; font-size: .78rem; }
.network-table th, .network-table td { padding: 8px 6px; border-bottom: 1px solid #eef2f7; text-align: left; vertical-align: middle; }
.network-table th { color: var(--muted); font-weight: 600; }
.network-state { margin-top: 4px; font-size: .72rem; }
.status-offline { color: #475569; background: #e2e8f0; }
.status-unknown { color: #475569; background: #e2e8f0; }
.empty-state { padding: 60px 20px; color: var(--muted); text-align: center; }
.empty-inline { margin-top: 12px; color: var(--muted); font-size: .85rem; }
.hidden-by-filter { display: none !important; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.metrics { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; margin: 18px 0; }
.metric, .panel { background: var(--surface); border: 1px solid var(--line); border-radius: 14px; box-shadow: 0 4px 14px rgba(15, 23, 42, .05); }
.metric { padding: 15px 17px; }
.metric span { display: block; color: var(--muted); font-size: .82rem; }
.metric strong { display: block; margin-top: 4px; font-size: 1.45rem; }
.workspace { display: grid; grid-template-columns: minmax(360px, .9fr) minmax(520px, 1.25fr); gap: 18px; }
.panel { padding: 20px; }
.panel h2 { margin: 0; font-size: 1.18rem; }
.section-head, .node-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.summary { border-left: 5px solid #dc2626; padding: 18px 20px; margin-bottom: 18px; }
.summary.diagnostic-attention { border-left-color: #b54708; }
.summary.diagnostic-normal { border-left-color: #067647; }
.facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 18px; margin: 15px 0; }
.fact span { display: block; color: var(--muted); font-size: .75rem; }
.fact strong { overflow-wrap: anywhere; }
.chain { margin-top: 16px; }
.node { padding: 14px 15px; border: 1px solid var(--line); border-left: 5px solid #067647; border-radius: 11px; background: #fff; }
.node.diagnostic-critical { border-color: #fecdca; border-left-color: #b42318; background: #fff1f0; }
.node.diagnostic-attention { border-color: #fedf89; border-left-color: #b54708; background: #fff7e8; }
.arrow { color: #98a2b3; font-size: 21px; line-height: 28px; text-align: center; }
.tag { padding: 3px 8px; border-radius: 999px; font-size: .75rem; font-weight: 700; }
.tag.diagnostic-critical { color: #b42318; background: #fee4e2; }
.tag.diagnostic-attention { color: #b54708; background: #fef0c7; }
.tag.diagnostic-normal { color: #067647; background: #d1fadf; }
.tag.diagnostic-unknown { color: #475467; background: #f2f4f7; }
.section { border-top: 1px solid var(--line); padding-top: 17px; margin-top: 17px; }
.evidence { padding: 11px 0; border-bottom: 1px solid #eef2f6; }
.evidence-time { color: var(--muted); font: .75rem Consolas, monospace; }
.recommendations { margin: 12px 0 0; padding-left: 22px; }
.recommendations li { margin: 7px 0; }
.customer { margin-top: 18px; padding: 19px 21px; background: #eef4ff; border: 1px solid #b2ccff; border-radius: 14px; }
.customer h2 { color: #1849a9; }
.reply { white-space: pre-wrap; font-size: 1rem; }
.copy { padding: 7px 10px; color: #1849a9; background: #fff; border: 1px solid #84adff; border-radius: 8px; }
@media (max-width: 1000px) { .workspace { grid-template-columns: 1fr; } .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 620px) { .metrics, .facts { grid-template-columns: 1fr; } .panel { padding: 16px; } }
@media (max-width: 1180px) { .dashboard-layout { grid-template-columns: minmax(190px, .8fr) minmax(400px, 1.8fr); } .storage-layout { grid-template-columns: minmax(280px, 1fr) minmax(280px, 1fr); } .layout-right { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 800px) { .dashboard { padding: 18px 12px 40px; } .hero { padding: 22px 20px; } .hero-heading, .diagnostic-banner { align-items: flex-start; flex-direction: column; } .metrics-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .dashboard-layout { display: flex; flex-direction: column; } .layout-left, .layout-right, .layout-center { width: 100%; } .layout-right { display: flex; } .toolbar { position: static; } }
@media (max-width: 520px) { .overview-grid, .memory-grid, .info-grid { grid-template-columns: 1fr; } .metrics-grid { grid-template-columns: 1fr; } .toolbar-grid { grid-template-columns: 1fr; } .toolbar-actions { grid-column: auto; justify-content: flex-start; } .sysinfo-card { padding: 16px; } .result-head { align-items: flex-start; } .issue-count { width: 100%; margin-left: 0; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; transition-duration: .01ms !important; animation-duration: .01ms !important; } }
`;
