import { createHash } from 'node:crypto';
import type { MemoryModule } from '../parsers/dmidecode-memory';
import type { SysinfoDisk, SysinfoReportModel, SysinfoSmartAttribute } from './sysinfo-report-model';

export { normalizeSysinfo } from './sysinfo-report-model';
export type { SysinfoReportModel } from './sysinfo-report-model';

export interface SysinfoReportMetadata {
  packageName: string;
  generatedAt: Date;
}

/**
 * 报告以 file:// 打开时 Clipboard API 可能被浏览器限制，因此保留基于临时文本框的回退。
 * 脚本内容固定，并通过 CSP 哈希精确授权；诊断包中的数据只进入转义后的 data 属性，不能
 * 改写或拼接脚本，从而兼顾本地复制能力和离线报告的安全边界。
 */
const copyScript = `(() => {
  function fallbackCopy(value) {
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
      if (!document.execCommand('copy')) throw new Error('copy command failed');
    } finally {
      textarea.remove();
    }
  }

  document.addEventListener('click', async (event) => {
    const target = event.target;
    const button = target && typeof target.closest === 'function' ? target.closest('[data-copy-value]') : null;
    if (!button || button.disabled) return;
    const copyValue = button.dataset.copyValue || '';
    button.disabled = true;
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        try {
          await navigator.clipboard.writeText(copyValue);
        } catch {
          fallbackCopy(copyValue);
        }
      } else {
        fallbackCopy(copyValue);
      }
      button.textContent = '已复制';
    } catch {
      button.textContent = '复制失败';
    }
    setTimeout(() => {
      button.textContent = '复制';
      button.disabled = false;
    }, 1500);
  });
})();`.trim();

const copyScriptHash = createHash('sha256').update(copyScript).digest('base64');

/**
 * 生成可以直接交给系统浏览器打开的单文件报告。
 *
 * 页面不加载外部资源，折叠交互使用浏览器原生 details；唯一的复制脚本由 CSP 哈希锁定。
 * 所有来自诊断包的值在进入 HTML 前统一转义，即使 sysinfo 含有恶意标签，也只能作为文本
 * 显示，不能在本地文件权限上下文中执行。
 */
export function renderSysinfoReport(model: SysinfoReportModel, metadata: SysinfoReportMetadata): string {
  const allDisks = model.storagePools.flatMap((pool) => pool.disks);
  const maxDiskSize = Math.max(0, ...allDisks.map((disk) => disk.sizeBytes ?? 0));
  const generatedAt = metadata.generatedAt.toLocaleString('zh-CN', { hour12: false });
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${copyScriptHash}'; base-uri 'none'; form-action 'none'">
  <title>完整 sysinfo 报告 - ${escapeHtml(metadata.packageName)}</title>
  <style>${reportCss}</style>
</head>
<body>
  <header class="report-header">
    <div class="report-header__inner">
      <div>
        <p class="product-name">Hephaestus Workbench 分析中心</p>
        <h1>完整 sysinfo 报告</h1>
        <p class="report-description">系统、网络和硬盘数据来自 sysinfo.json，内存数据来自 dmidecode.log。</p>
      </div>
      <dl class="report-meta">
        <div><dt>诊断包</dt><dd title="${escapeHtml(metadata.packageName)}">${escapeHtml(metadata.packageName)}</dd></div>
        <div><dt>生成时间</dt><dd>${escapeHtml(generatedAt)}</dd></div>
      </dl>
    </div>
  </header>
  <main>
    <section class="report-section" aria-labelledby="system-heading">
      <div class="section-heading"><div><h2 id="system-heading">设备概览</h2><p>系统身份与软件环境</p></div><span class="count">sysinfo.json</span></div>
      <dl class="overview-grid">
        ${overviewItem('设备名称', model.system.deviceName)}
        ${overviewItem('序列号', model.system.serialNumber, true, '复制设备序列号')}
        ${overviewItem('系统版本', model.system.systemVersion, true)}
        ${overviewItem('平台', model.system.platform, true)}
      </dl>
    </section>

    <section class="report-section" aria-labelledby="storage-heading">
      <div class="section-heading"><div><h2 id="storage-heading">硬盘与存储池分组</h2><p>仅按 sysinfo.json 的 used_for 分组，不代表 RAID 级别</p></div><span class="count">${allDisks.length} 块硬盘</span></div>
      ${model.storagePools.length === 0 ? emptyState('未提供硬盘信息') : model.storagePools.map((pool) => `
        <section class="pool" aria-label="${escapeHtml(localizeStoragePoolLabel(pool.name))}">
          <div class="pool-heading"><div><h3>${value(localizeStoragePoolLabel(pool.name))}</h3><p>${pool.diskCount} 块硬盘${pool.totalSizeBytes === undefined ? '' : `，已识别容量合计 ${formatBytes(pool.totalSizeBytes)}`}</p></div></div>
          <div class="disk-list">${pool.disks.map((disk) => renderDisk(disk, maxDiskSize)).join('')}</div>
        </section>`).join('')}
    </section>

    <section class="report-section" aria-labelledby="network-heading">
      <div class="section-heading"><div><h2 id="network-heading">网络接口</h2><p>地址和硬件标识按原值展示</p></div><span class="count">${model.networks.length} 个接口</span></div>
      ${model.networks.length === 0 ? emptyState('未提供网络接口信息') : `<div class="table-scroll"><table><thead><tr><th>接口</th><th>运行状态</th><th>MAC</th><th>IPv4</th><th>IPv6</th><th>MTU</th></tr></thead><tbody>${model.networks.map((network) => `<tr><td class="mono strong">${value(network.name)}</td><td>${network.running === undefined ? '<span class="status neutral">未提供</span>' : network.running ? '<span class="status good">运行中</span>' : '<span class="status muted">未运行</span>'}</td><td class="mono">${value(network.mac)}</td><td class="mono multi-value">${values(network.ipv4)}</td><td class="mono multi-value">${values(network.ipv6)}</td><td class="mono">${value(network.mtu)}</td></tr>`).join('')}</tbody></table></div>`}
    </section>

    <section class="report-section" aria-labelledby="memory-heading">
      <div class="section-heading"><div><h2 id="memory-heading">内存信息</h2><p>来自诊断包中的独立 dmidecode 文件</p></div><span class="count">${model.memory.length} 条</span></div>
      ${model.memory.length === 0 ? emptyState('未提供内存信息') : renderMemoryTable(model.memory)}
    </section>

    <section class="report-section raw-section" aria-labelledby="raw-heading">
      <details>
        <summary><span><strong id="raw-heading">完整 sysinfo.json 原始数据</strong><small>包含所有未识别字段，展开后可逐项核对</small></span><span class="disclosure">展开</span></summary>
        <pre>${escapeHtml(JSON.stringify(model.raw, null, 2))}</pre>
      </details>
    </section>
  </main>
  <script>${copyScript}</script>
</body>
</html>`;
}

function renderDisk(disk: SysinfoDisk, maxDiskSize: number): string {
  const title = localizeDiskLabel(disk.label) || disk.device || disk.name || '未命名硬盘';
  const percent = disk.sizeBytes && maxDiskSize > 0 ? Math.max(2, Math.round((disk.sizeBytes / maxDiskSize) * 100)) : 0;
  return `<article class="disk">
    <div class="disk-heading"><div><h4>${escapeHtml(title)}</h4><p class="mono">${value(disk.device || disk.name)}</p></div><span class="status neutral">源状态 ${value(disk.sourceStatus)}</span></div>
    <dl class="disk-facts">
      ${fact('盘位', disk.slot)}${fact('型号', disk.model, false, '复制硬盘型号')}${fact('序列号', disk.serial, true, '复制硬盘序列号')}${fact('品牌', disk.brand)}${fact('接口', disk.interfaceType)}${fact('温度', disk.temperature ? `${disk.temperature} °C` : '')}${fact('通电时长', disk.powerOnHours ? `${disk.powerOnHours} 小时` : '')}
    </dl>
    <div class="capacity"><div><span>容量</span><strong>${disk.sizeBytes === undefined ? value(disk.sizeSource) : `${formatBytes(disk.sizeBytes)} (${formatInteger(disk.sizeBytes)} bytes)`}</strong></div>${percent > 0 ? `<div class="capacity-line" aria-hidden="true"><span style="width:${percent}%"></span></div>` : ''}</div>
    <div class="smart-summary"><h5>重点 SMART</h5>${disk.keySmart.length === 0 ? '<p class="empty-inline">未提供 5、197、198 或源数据标记异常的属性</p>' : `<div class="smart-key-grid">${disk.keySmart.map(renderKeySmart).join('')}</div>`}</div>
    <details class="smart-details"><summary><span>完整 SMART 属性</span><span>${disk.smart.length} 项</span></summary>${disk.smart.length === 0 ? emptyState('未提供 SMART 属性') : renderSmartTable(disk.smart)}</details>
  </article>`;
}

function renderKeySmart(attribute: SysinfoSmartAttribute): string {
  const rawClass = leadingRawValueIsNonZero(attribute.raw) ? 'mono raw-attention' : 'mono';
  return `<div class="smart-key"><div><span class="smart-id">${value(attribute.sourceId)}</span><strong>${renderSmartName(attribute.name)}</strong></div><dl><div><dt>Raw</dt><dd class="${rawClass}">${value(attribute.raw)}</dd></div></dl></div>`;
}

function renderSmartTable(attributes: SysinfoSmartAttribute[]): string {
  return `<div class="table-scroll"><table class="smart-table"><thead><tr><th>ID</th><th>名称</th><th>Current</th><th>Worst</th><th>Threshold</th><th>Raw</th><th>源状态</th></tr></thead><tbody>${attributes.map((attribute) => `<tr><td class="mono strong">${value(attribute.sourceId)}</td><td>${renderSmartName(attribute.name)}</td><td class="mono">${value(attribute.current)}</td><td class="mono">${value(attribute.worst)}</td><td class="mono">${value(attribute.threshold)}</td><td class="mono">${value(attribute.raw)}</td><td class="mono">${value(attribute.sourceStatus)}</td></tr>`).join('')}</tbody></table></div>`;
}

function renderMemoryTable(modules: MemoryModule[]): string {
  return `<div class="table-scroll"><table class="memory-table"><thead><tr><th>内存</th><th>容量</th><th>品牌</th><th>型号</th></tr></thead><tbody>${modules.map((module, index) => `<tr><td class="strong">内存 ${index + 1}</td><td class="mono">${value(module.size)}</td><td>${value(module.manufacturer)}</td><td class="mono">${value(module.model)}</td></tr>`).join('')}</tbody></table></div>`;
}

function overviewItem(label: string, content: string, mono = false, copyLabel?: string): string {
  return `<div><dt>${label}</dt>${reportValue(content, mono, copyLabel)}</div>`;
}

function fact(label: string, content: string, mono = false, copyLabel?: string): string {
  return `<div><dt>${label}</dt>${reportValue(content, mono, copyLabel)}</div>`;
}

function reportValue(content: string, mono: boolean, copyLabel?: string): string {
  const className = [mono ? 'mono' : '', copyLabel && content ? 'copyable-value' : ''].filter(Boolean).join(' ');
  if (!copyLabel || !content) return `<dd${className ? ` class="${className}"` : ''}>${value(content)}</dd>`;
  return `<dd class="${className}"><span class="copy-value">${escapeHtml(content)}</span><button type="button" class="copy-button" aria-label="${escapeHtml(copyLabel)}" data-copy-value="${escapeHtml(content)}">复制</button></dd>`;
}

function values(items: string[]): string {
  return items.length === 0 ? '<span class="missing">未提供</span>' : items.map((item) => `<span>${escapeHtml(item)}</span>`).join('');
}

function value(content: string): string {
  return content ? escapeHtml(content) : '<span class="missing">未提供</span>';
}

function emptyState(message: string): string {
  return `<p class="empty-state">${escapeHtml(message)}</p>`;
}

/** Raw 可能带 Min/Max 等说明，只按开头的十进制或 0x 十六进制数判断是否需要强调。 */
function leadingRawValueIsNonZero(raw: string): boolean {
  const match = raw.match(/^\s*(0x[0-9a-f]+|\d+)/i);
  if (!match) return false;
  const source = match[1];
  const parsed = Number.parseInt(source, /^0x/i.test(source) ? 16 : 10);
  return Number.isFinite(parsed) && parsed !== 0;
}

function localizeStoragePoolLabel(label: string): string {
  const match = label.trim().match(/^Storage Pool(?:\s+(.+))?$/i);
  return match ? `存储池${match[1] ? ` ${match[1]}` : ''}` : label;
}

function localizeDiskLabel(label: string): string {
  const trimmed = label.trim();
  const m2Match = trimmed.match(/^M\.2 Hard Drive(?:\s+(.+))?$/i);
  if (m2Match) return `M.2 硬盘${m2Match[1] ? ` ${m2Match[1]}` : ''}`;
  const hardDriveMatch = trimmed.match(/^Hard Drive(?:\s+(.+))?$/i);
  return hardDriveMatch ? `硬盘${hardDriveMatch[1] ? ` ${hardDriveMatch[1]}` : ''}` : label;
}

/**
 * SMART 名称由硬盘固件提供，不能对未知词组做机器式猜译。这里仅收录真实样本和常见
 * ATA/NVMe 属性；未命中的名称保留英文并明确提示未收录，避免产生错误的诊断术语。
 */
function renderSmartName(name: string): string {
  if (!name) return value(name);
  const translation = smartNameTranslations[name];
  return `${escapeHtml(name)}<span class="smart-translation${translation ? '' : ' missing'}">（${escapeHtml(translation || '中文名未收录')}）</span>`;
}

const smartNameTranslations: Record<string, string> = {
  Raw_Read_Error_Rate: '原始读取错误率',
  temperature: '温度',
  available_spare: '可用备用空间',
  available_spare_threshold: '可用备用空间阈值',
  Spin_Up_Time: '启动旋转时间',
  percentage_used: '已用寿命百分比',
  Start_Stop_Count: '启停次数',
  data_units_read: '已读取数据单元',
  Reallocated_Sector_Ct: '重映射扇区计数',
  data_units_written: '已写入数据单元',
  host_reads: '主机读取命令数',
  Seek_Error_Rate: '寻道错误率',
  host_writes: '主机写入命令数',
  controller_busy_time: '控制器忙碌时间',
  Power_On_Hours: '通电时长',
  power_cycles: '电源循环次数',
  Spin_Retry_Count: '旋转重试计数',
  Calibration_Retry_Count: '校准重试计数',
  power_on_hours: '通电时长',
  Power_Cycle_Count: '电源循环次数',
  unsafe_shutdowns: '非正常关机次数',
  warning_temp_time: '警告温度持续时间',
  temperature_sensors: '温度传感器',
  'End-to-End_Error': '端到端错误计数',
  Reported_Uncorrect: '报告的不可校正错误计数',
  Command_Timeout: '命令超时计数',
  High_Fly_Writes: '磁头高飞写入计数',
  Airflow_Temperature_Cel: '气流温度',
  'G-Sense_Error_Rate': '冲击感应错误率',
  'Power-Off_Retract_Count': '断电磁头回缩计数',
  Load_Cycle_Count: '磁头加载循环计数',
  Temperature_Celsius: '温度',
  Hardware_ECC_Recovered: '硬件 ECC 恢复计数',
  Reallocated_Event_Count: '扇区重映射事件计数',
  Current_Pending_Sector: '当前待处理扇区计数',
  Offline_Uncorrectable: '离线不可校正扇区计数',
  UDMA_CRC_Error_Count: 'UDMA CRC 错误计数',
  Multi_Zone_Error_Rate: '多区域错误率',
  Head_Flying_Hours: '磁头飞行时长',
  Total_LBAs_Written: '累计写入 LBA 数',
  Total_LBAs_Read: '累计读取 LBA 数'
};

function formatBytes(bytes: number): string {
  const units = ['bytes', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  if (bytes < 1024) return `${formatInteger(bytes)} bytes`;
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** unit)).toFixed(2)} ${units[unit]}`;
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value);
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

const reportCss = `
:root { color-scheme: light; --bg:#f4f7fb; --surface:#ffffff; --line:#d8e0ea; --line-strong:#bac7d6; --text:#17202d; --muted:#5f6f82; --accent:#1769aa; --accent-soft:#e8f2fb; --good:#1e6b46; --good-bg:#e7f5ed; --mono:"Cascadia Mono","SFMono-Regular",Consolas,monospace; }
* { box-sizing:border-box; }
html { background:var(--bg); color:var(--text); font-family:"Segoe UI","Microsoft YaHei UI",sans-serif; font-size:14px; }
body { margin:0; }
.mono { font-family:var(--mono); font-variant-numeric:tabular-nums; }
.report-header { background:#17324b; color:#f7fbff; border-bottom:3px solid #2f86c5; }
.report-header__inner, main { width:min(1440px, calc(100% - 48px)); margin:0 auto; }
.report-header__inner { min-height:168px; padding:30px 0; display:grid; grid-template-columns:minmax(0,1fr) minmax(320px,460px); gap:44px; align-items:end; }
.product-name { margin:0 0 8px; color:#9bc9ea; font-size:13px; font-weight:600; }
h1 { margin:0; font-size:30px; font-weight:650; letter-spacing:0; }
.report-description { margin:10px 0 0; color:#d1e1ee; }
.report-meta { margin:0; display:grid; gap:10px; }
.report-meta div { display:grid; grid-template-columns:74px minmax(0,1fr); gap:12px; }
.report-meta dt { color:#9db4c8; }
.report-meta dd { margin:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
main { padding:24px 0 56px; }
.report-section { background:var(--surface); border:1px solid var(--line); margin-bottom:16px; }
.section-heading { min-height:68px; padding:14px 18px; border-bottom:1px solid var(--line); display:flex; align-items:center; justify-content:space-between; gap:20px; }
.section-heading h2 { margin:0; font-size:18px; }
.section-heading p, .pool-heading p, .disk-heading p { margin:4px 0 0; color:var(--muted); }
.count { flex:none; color:#285b82; background:var(--accent-soft); padding:4px 8px; border-radius:4px; font-size:12px; }
.overview-grid { margin:0; display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); }
.overview-grid div { min-width:0; padding:18px; border-right:1px solid var(--line); }
.overview-grid div:last-child { border-right:0; }
dt { color:var(--muted); font-size:12px; }
dd { margin:7px 0 0; overflow-wrap:anywhere; }
.overview-grid dd { font-size:15px; font-weight:600; }
.copyable-value { display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; gap:6px; }
.copy-value { min-width:0; overflow-wrap:anywhere; }
.copy-button { min-width:40px; height:24px; padding:0 7px; border:1px solid #9eb1c3; border-radius:3px; background:#fff; color:#285b82; font:12px "Segoe UI","Microsoft YaHei UI",sans-serif; cursor:pointer; }
.copy-button:hover { border-color:#4f82a8; background:var(--accent-soft); }
.copy-button:focus-visible { outline:2px solid #2f86c5; outline-offset:2px; }
.copy-button:disabled { cursor:default; color:#526b7f; background:#edf3f8; }
.pool + .pool { border-top:1px solid var(--line-strong); }
.pool-heading { padding:15px 18px; background:#f8fafc; }
.pool-heading h3 { margin:0; font-size:15px; }
.disk { padding:18px; }
.disk + .disk { border-top:1px solid var(--line); }
.disk-heading { display:flex; align-items:flex-start; justify-content:space-between; gap:20px; }
.disk-heading h4 { margin:0; font-size:16px; }
.status { display:inline-flex; align-items:center; min-height:25px; padding:3px 8px; border-radius:4px; font-size:12px; white-space:nowrap; }
.status.neutral { color:#35536d; background:#edf3f8; }
.status.good { color:var(--good); background:var(--good-bg); }
.status.muted { color:#5f6570; background:#eef0f2; }
.disk-facts { margin:16px 0; display:grid; grid-template-columns:repeat(7,minmax(0,1fr)); border:1px solid var(--line); }
.disk-facts div { min-width:0; padding:10px 12px; border-right:1px solid var(--line); }
.disk-facts div:last-child { border-right:0; }
.capacity { display:grid; grid-template-columns:minmax(280px,1fr) minmax(220px,2fr); gap:24px; align-items:center; padding:11px 12px; background:#f8fafc; }
.capacity div:first-child { display:flex; align-items:baseline; justify-content:space-between; gap:20px; }
.capacity span { color:var(--muted); }
.capacity strong { font-family:var(--mono); font-size:12px; text-align:right; }
.capacity-line { height:5px; background:#dce6ef; }
.capacity-line span { display:block; height:100%; background:var(--accent); }
.smart-summary { margin-top:18px; }
.smart-summary h5 { margin:0 0 9px; font-size:13px; }
.smart-key-grid { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:8px; }
.smart-key { border-left:3px solid #85a8c3; background:#f5f8fb; padding:9px 10px; }
.smart-key > div { display:flex; align-items:center; gap:8px; min-width:0; }
.smart-key strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.smart-id { min-width:26px; color:var(--accent); font-family:var(--mono); font-weight:700; }
.smart-translation { margin-left:4px; color:var(--muted); font-size:12px; font-weight:400; }
.smart-key dl { margin:8px 0 0; display:grid; grid-template-columns:1fr; gap:8px; }
.smart-key dl div { display:flex; justify-content:space-between; gap:8px; }
.smart-key dd { margin:0; }
.raw-attention { padding:1px 4px; border-radius:3px; background:#fee2e2; color:#b91c1c; font-weight:700; }
.smart-details { margin-top:12px; border:1px solid var(--line); }
.smart-details summary { cursor:pointer; min-height:42px; padding:10px 12px; display:flex; justify-content:space-between; gap:12px; color:#27465f; font-weight:600; }
.smart-details[open] summary { border-bottom:1px solid var(--line); }
.table-scroll { width:100%; overflow:auto; }
table { width:100%; border-collapse:collapse; font-size:13px; }
th { background:#f3f6f9; color:#506174; font-size:12px; font-weight:600; text-align:left; white-space:nowrap; }
th, td { padding:10px 12px; border-bottom:1px solid var(--line); vertical-align:top; }
tbody tr:last-child td { border-bottom:0; }
.smart-table { min-width:850px; }
.strong { font-weight:600; color:#233b50; }
.multi-value span { display:block; white-space:nowrap; }
.missing, .empty-inline { color:#7b8795; font-weight:400; }
.empty-state { margin:0; padding:24px 18px; color:#6e7b89; }
.empty-inline { margin:0; }
.raw-section details > summary { cursor:pointer; min-height:68px; padding:14px 18px; display:flex; align-items:center; justify-content:space-between; gap:20px; }
.raw-section summary span:first-child { display:grid; gap:4px; }
.raw-section summary strong { font-size:18px; }
.raw-section summary small { color:var(--muted); font-weight:400; }
.disclosure { color:var(--accent); }
.raw-section pre { margin:0; padding:18px; border-top:1px solid var(--line); background:#101b27; color:#dce8f2; font:12px/1.6 var(--mono); white-space:pre; overflow:auto; max-height:70vh; }
@media (max-width:1099px) {
  .report-header__inner { grid-template-columns:1fr; gap:20px; }
  .overview-grid { grid-template-columns:repeat(2,minmax(0,1fr)); }
  .overview-grid div { border-bottom:1px solid var(--line); }
  .disk-facts { grid-template-columns:repeat(4,minmax(0,1fr)); }
  .disk-facts div { border-bottom:1px solid var(--line); }
  .smart-key-grid { grid-template-columns:repeat(2,minmax(0,1fr)); }
}
@media (max-width:800px) {
  .report-header__inner, main { width:calc(100% - 24px); }
  .report-header__inner { min-height:0; padding:22px 0; }
  h1 { font-size:25px; }
  .report-meta div { grid-template-columns:68px minmax(0,1fr); }
  .section-heading, .disk-heading { align-items:flex-start; }
  .overview-grid { grid-template-columns:1fr 1fr; }
  .overview-grid div:nth-child(2n) { border-right:0; }
  .disk { padding:14px; }
  .disk-facts { grid-template-columns:1fr 1fr; }
  .disk-facts div:nth-child(2n) { border-right:0; }
  .capacity { grid-template-columns:1fr; gap:9px; }
  .smart-key-grid { grid-template-columns:1fr; }
  th, td { padding:9px 10px; }
}
`;
