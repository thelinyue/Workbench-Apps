package main

// dashboardReportTemplate 是离线报告的唯一展示模板。
// 报告不依赖外部网络，Bootstrap 和交互脚本均由生成器写入报告目录。
const dashboardReportTemplate = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>{{.Title}}</title>
    <link href="static/bootstrap.min.css" rel="stylesheet">
    <style>
        :root { --brand: #2563eb; --ink: #172033; --muted: #64748b; --surface: #fff; --page: #f1f5f9; }
        body { background: var(--page); color: var(--ink); font-family: "Segoe UI", "Microsoft YaHei", sans-serif; }
        .dashboard { max-width: 1500px; margin: 0 auto; padding: 28px 20px 60px; }
        .dashboard-layout { display: flex; flex-direction: column; gap: 18px; }
        .layout-left { order: 1; }
        .layout-center { order: 4; min-width: 0; }
        .layout-block { order: 3; }
        .layout-disks { order: 3; }
        .layout-right { order: 2; }
        .hero { color: #fff; background: linear-gradient(135deg, #1d4ed8, #2563eb 58%, #38bdf8); border-radius: 18px; padding: 28px 32px; box-shadow: 0 12px 30px rgba(37,99,235,.2); }
        .hero h1 { font-size: clamp(1.65rem, 3vw, 2.35rem); font-weight: 700; margin: 0 0 8px; }
        .hero-meta { display: flex; flex-wrap: wrap; gap: 8px 20px; color: rgba(255,255,255,.88); font-size: .9rem; }
        .metric-card, .toolbar, .result-card { background: var(--surface); border: 1px solid #e2e8f0; border-radius: 14px; box-shadow: 0 4px 14px rgba(15,23,42,.05); }
        .metric-card { padding: 18px 20px; height: 100%; border-left: 4px solid var(--brand); }
        .metric-card.alert { border-left-color: #dc2626; }
        .metric-card.critical { border-left-color: #991b1b; }
        .metric-label { color: var(--muted); font-size: .86rem; }
        .metric-value { font-size: 1.8rem; font-weight: 700; margin-top: 3px; }
        .summary-card, .sysinfo-card { background: #fff; border: 1px solid #e2e8f0; border-radius: 14px; box-shadow: 0 4px 14px rgba(15,23,42,.05); }
        .summary-card { border-left: 4px solid #dc2626; padding: 18px 20px; }
        .diagnostic-banner { border-radius: 14px; padding: 18px 22px; border: 1px solid transparent; box-shadow: 0 5px 16px rgba(15,23,42,.08); }
        .diagnostic-critical { background: #fef2f2; border-color: #fecaca; color: #991b1b; }
        .diagnostic-disk { background: #fff7ed; border-color: #fed7aa; color: #9a3412; }
        .diagnostic-filesystem { background: #fefce8; border-color: #fde68a; color: #854d0e; }
        .diagnostic-ok { background: #f0fdf4; border-color: #bbf7d0; color: #166534; }
        .summary-item { border-top: 1px solid #eef2f7; padding: 10px 0; }
        .sysinfo-card { padding: 20px; }
        details > summary { cursor: pointer; }
        .sysinfo-card > summary { list-style: none; margin: -20px; padding: 18px 20px; border-radius: 14px; }
        .sysinfo-card > summary::-webkit-details-marker { display: none; }
        .sysinfo-card[open] > summary { margin-bottom: 20px; border-bottom: 1px solid #e2e8f0; border-radius: 14px 14px 0 0; }
        .sysinfo-card:not([open]) { padding: 0 !important; margin-bottom: 12px !important; min-height: 0; }
        .sysinfo-card:not([open]) > summary,
        .sysinfo-card:not([open]) > summary.h5 { margin: 0 !important; padding: 13px 20px; }
        .overview-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
        .overview-item { min-width: 0; padding: 13px 15px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 11px; }
        .overview-item .info-value { margin-top: 5px; }
        .overview-secondary { margin-top: 12px; }
        .overview-secondary .overview-item { background: #fff; }
        .disk-card { background: #fff; overflow: hidden; height: auto !important; }
        .disk-card-summary { list-style: none; }
        .disk-card-summary::-webkit-details-marker { display: none; }
        .info-value { font-size: 1.05rem; font-weight: 600; overflow-wrap: anywhere; }
        .info-label { color: var(--muted); font-size: .8rem; }
        .smart-table th, .smart-table td { vertical-align: middle; white-space: nowrap; }
        .smart-normal { color: #15803d; background: #dcfce7; }
        .smart-risk { color: #b91c1c; background: #fee2e2; }
        .smart-risk-note { padding: 10px 12px; color: #991b1b; background: #fff1f2; border: 1px solid #fecdd3; border-radius: 8px; font-size: .9rem; font-weight: 600; }
        .smart-unknown { color: #475569; background: #e2e8f0; }
        .status-ok { color: #15803d; background: #dcfce7; }
        .status-risk { color: #b91c1c; background: #fee2e2; }
        .status-offline { color: #475569; background: #e2e8f0; }
        .status-unknown { color: #475569; background: #e2e8f0; }
        .severity-critical { color: #991b1b; background: #fee2e2; }
        .severity-warning { color: #92400e; background: #fef3c7; }
        .severity-info { color: #1d4ed8; background: #dbeafe; }
        .context-line { display: flex; gap: 12px; }
        .context-line-hit { background: rgba(220,38,38,.28); color: #fff; border-radius: 3px; }
        .line-number { color: #94a3b8; min-width: 42px; text-align: right; user-select: none; }
        .context-text { flex: 1; min-width: 0; }
        .toolbar { padding: 18px; position: sticky; top: 12px; z-index: 10; }
        .toolbar .form-control, .toolbar .form-select { border-color: #cbd5e1; }
        .result-card { overflow: hidden; transition: box-shadow .2s, transform .2s; }
        .result-card:hover { box-shadow: 0 8px 22px rgba(15,23,42,.1); transform: translateY(-1px); }
        .result-head { background: #fff; border: 0; width: 100%; text-align: left; padding: 18px 20px; }
        .result-head:hover { background: #f8fafc; }
        .file-name { font-weight: 700; overflow-wrap: anywhere; word-break: break-word; }
        .file-path { font-family: Consolas, "Cascadia Code", "Microsoft YaHei", sans-serif; line-height: 1.5; }
        .issue-group { border-top: 1px solid #e2e8f0; }
        .issue-head { padding: 14px 20px; background: #f8fafc; cursor: pointer; list-style: none; }
        .issue-head::-webkit-details-marker { display: none; }
        .issue-head::before { content: '▶'; color: #64748b; margin-right: 8px; font-size: .75rem; }
        .issue-group[open] > .issue-head::before { content: '▼'; }
        .issue-title-message { color: #334155; font-weight: 600; overflow-wrap: anywhere; }
        .issue-item { padding: 18px 20px; border-top: 1px solid #eef2f7; }
        .issue-message { color: #334155; font-weight: 600; }
        .context-box { background: #0f172a; color: #dbeafe; border-radius: 10px; padding: 14px; position: relative; }
        .context-box code { color: inherit; white-space: pre-wrap; overflow-wrap: anywhere; font: .82rem/1.55 Consolas, "Cascadia Code", monospace; }
        .context-box.nowrap .context-text { white-space: pre; overflow-x: auto; }
        .raw-log-box { background: #0f172a; color: #dbeafe; border-radius: 10px; padding: 14px; max-height: 420px; overflow: auto; white-space: pre; font: .82rem/1.55 Consolas, "Cascadia Code", monospace; }
        .raw-log-frame { display: block; width: 100%; height: 520px; border: 1px solid #1e293b; border-radius: 10px; background: #0f172a; }
        .copy-context { position: absolute; right: 10px; top: 10px; }
        .empty-state { color: var(--muted); text-align: center; padding: 60px 20px; }
        .hidden-by-filter { display: none !important; }
        .truncate { max-width: 560px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        @media (max-width: 1050px) { .overview-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
        @media (max-width: 768px) { .dashboard { padding: 14px 10px 40px; } .hero { padding: 22px 20px; } .toolbar { position: static; } .truncate { max-width: 220px; } .issue-item { padding: 14px 12px; } }
        @media (max-width: 520px) { .overview-grid { grid-template-columns: 1fr; } .sysinfo-card { padding: 16px; } .sysinfo-card > summary { margin: -16px; padding: 16px; } .sysinfo-card[open] > summary { margin-bottom: 16px; } }
    </style>
</head>
<body>
<main class="dashboard">
    <section class="hero mb-4">
        <div class="d-flex flex-wrap justify-content-between gap-3 align-items-start">
            <div><h1>{{.Title}}</h1><p class="mb-0 opacity-75">快速判断风险，定位故障根因，查看关键日志上下文</p></div>
            <span class="badge rounded-pill bg-light text-primary px-3 py-2">规则 {{.RuleVersion}}</span>
        </div>
        <div class="hero-meta mt-4"><span>分析时间：{{.AnalysisTime}}</span><span>目标路径：{{.TargetPath}}</span></div>
    </section>

    <section class="diagnostic-banner {{.DiagnosticClass}} mb-4" id="diagnosticSummary">
        <div class="d-flex flex-wrap align-items-center justify-content-between gap-3"><div><div class="small fw-bold text-uppercase mb-1">快速诊断结论</div><div class="fw-semibold">{{.DiagnosticSummary}}</div></div>{{if .DiagnosticTarget}}<button class="btn btn-sm btn-outline-dark" type="button" data-detail-target="{{.DiagnosticTarget}}">查看详情</button>{{end}}</div>
    </section>

    <div class="dashboard-layout">

    <aside class="layout-left">
    {{if .SysInfo}}
    <details class="sysinfo-card mb-4" id="sysinfoAnchor">
        <summary class="h5 mb-3">设备概览 <span class="badge bg-primary">sysinfo.json</span></summary>
        <div class="overview-grid">
            <div class="overview-item"><div class="info-label">设备型号</div><div class="info-value">{{if .SysInfo.Model}}{{.SysInfo.Model}}{{else}}未知{{end}}</div></div>
            <div class="overview-item"><div class="info-label">序列号</div><div class="info-value">{{if .SysInfo.SerialNumber}}{{.SysInfo.SerialNumber}}{{else}}未知{{end}}</div></div>
            <div class="overview-item"><div class="info-label">固件版本</div><div class="info-value">{{if .SysInfo.Firmware}}{{.SysInfo.Firmware}}{{else}}未知{{end}}</div></div>
            <div class="overview-item"><div class="info-label">平台架构</div><div class="info-value">{{if .SysInfo.Platform}}{{.SysInfo.Platform}}{{else}}未知{{end}}</div></div>
        </div>
        {{if .SysInfo.System}}<div class="overview-grid overview-secondary">{{range .SysInfo.System}}<div class="overview-item"><div class="info-label">{{.Key}}</div><div class="small text-break">{{.Value}}</div></div>{{end}}</div>{{end}}
        {{if .Memory}}<details class="mt-4"><summary class="h6 mb-3">内存信息 <span class="badge bg-secondary">{{len .Memory}} 条</span></summary><div class="row g-3">{{range .Memory}}<div class="col-12 col-md-6 col-xl-4"><div class="border rounded-3 p-3 h-100"><div class="info-label">大小</div><div class="info-value text-break">{{.Size}}</div><div class="info-label mt-2">品牌</div><div class="small text-break">{{if .Manufacturer}}{{.Manufacturer}}{{else}}未知{{end}}</div><div class="info-label mt-2">型号</div><div class="small text-break">{{if .Model}}{{.Model}}{{else}}未知{{end}}</div></div></div>{{end}}</div></details>{{end}}
        {{if .SysInfo.Disks}}
        <details class="mt-4" id="disksAnchor">
            <summary class="h5 mb-3">硬盘与 SMART <span class="badge bg-primary">{{len .SysInfo.Disks}} 块</span> <span class="text-muted small ms-2">{{range $index, $disk := .SysInfo.Disks}}{{if $index}}、{{end}}{{if $disk.Name}}{{$disk.Name}}{{else if $disk.Label}}{{$disk.Label}}{{else}}未命名硬盘{{end}}{{end}}</span></summary>
            <div class="row g-3">
                {{range $diskIndex, $disk := .SysInfo.Disks}}
                <div class="col-12 col-lg-6">
                    <details class="disk-card border rounded-3 h-100" id="diagnosticDisk-{{$diskIndex}}">
                        <summary class="disk-card-summary p-3">
                            <div class="d-flex justify-content-between gap-2">
                                <div><div class="fw-bold text-break">{{if .Name}}{{.Name}}{{else if .Label}}{{.Label}}{{else}}未命名硬盘{{end}}</div><div class="text-muted small text-break">{{if .Model}}{{.Model}}{{else}}型号未知{{end}}</div></div>
                                <span class="badge {{if smartHasRisk .Smart}}smart-risk{{else if eq .Health "风险"}}smart-risk{{else if eq .Health "未知"}}smart-unknown{{else}}smart-normal{{end}}">{{if smartHasRisk .Smart}}风险{{else if .Health}}{{.Health}}{{else}}正常{{end}}</span>
                            </div>
                        </summary>
                        <div class="p-3 pt-0">
                            <div class="row g-2 small">
                                <div class="col-12 col-md-6"><span class="text-muted">label：</span><span class="text-break">{{if .Label}}{{.Label}}{{else}}未采集{{end}}</span></div>
                                <div class="col-12 col-md-6"><span class="text-muted">设备路径：</span><span class="text-break">{{if .DeviceName}}{{.DeviceName}}{{else}}未采集{{end}}</span></div>
                                <div class="col-12 col-md-6"><span class="text-muted">容量：</span><span class="text-break">{{if .Capacity}}{{.Capacity}}{{else}}未采集{{end}}</span></div>
                                <div class="col-12 col-md-6"><span class="text-muted">接口：</span><span class="text-break">{{if .InterfaceType}}{{.InterfaceType}}{{else}}未采集{{end}}</span></div>
                                <div class="col-12 col-md-6"><span class="text-muted">槽位：</span><span class="text-break">{{if .Slot}}{{.Slot}}{{else}}未采集{{end}}</span></div>
                                <div class="col-12 col-md-6"><span class="text-muted">序列号：</span><span class="text-break">{{if .Serial}}{{.Serial}}{{else}}未采集{{end}}</span></div>
                                <div class="col-12 col-md-6"><span class="text-muted">温度：</span><span class="text-break">{{if .Temperature}}{{.Temperature}} °C{{else}}未采集{{end}}</span></div>
                                <div class="col-12 col-md-6"><span class="text-muted">通电时长：</span><span class="text-break">{{if .PowerOnHours}}{{.PowerOnHours}}{{else}}未采集{{end}}</span></div>
                                <div class="col-12 col-md-6"><span class="text-muted">品牌：</span><span class="text-break">{{if .Brand}}{{.Brand}}{{else}}未采集{{end}}</span></div>
                                <div class="col-12 col-md-6"><span class="text-muted">存储用途：</span><span class="text-break">{{if .UsedFor}}{{.UsedFor}}{{else}}未采集{{end}}</span></div>
                            </div>
                            {{if smartFocus .Smart}}
                            <div class="table-responsive mt-3"><table class="table table-sm smart-table mb-0"><thead><tr><th>ID</th><th>属性</th><th>当前</th><th>Worst</th><th>阈值</th><th>RAW</th><th>状态</th></tr></thead><tbody>{{range smartFocus .Smart}}<tr><td>{{.ID}}</td><td>{{.Name}}</td><td>{{if .Value}}{{.Value}}{{else}}未采集{{end}}</td><td>{{if .Worst}}{{.Worst}}{{else}}未采集{{end}}</td><td>{{if .Threshold}}{{.Threshold}}{{else}}未采集{{end}}</td><td>{{if .Raw}}{{.Raw}}{{else}}未采集{{end}}</td><td><span class="badge {{if eq .Status "风险"}}smart-risk{{else if eq .Status "未知"}}smart-unknown{{else}}smart-normal{{end}}">{{if .Status}}{{.Status}}{{else}}未采集{{end}}</span></td></tr>{{end}}</tbody></table></div>
                            {{end}}
                            {{if .Smart}}<details class="mt-3"><summary class="text-primary small">查看全部 SMART（{{len .Smart}} 条）</summary><div class="table-responsive mt-2"><table class="table table-sm smart-table mb-0"><thead><tr><th>ID</th><th>属性</th><th>当前</th><th>Worst</th><th>阈值</th><th>RAW</th><th>状态</th></tr></thead><tbody>{{range .Smart}}<tr><td>{{.ID}}</td><td class="text-break">{{if .Name}}{{.Name}}{{else}}未命名属性{{end}}</td><td>{{if .Value}}{{.Value}}{{else}}未采集{{end}}</td><td>{{if .Worst}}{{.Worst}}{{else}}未采集{{end}}</td><td>{{if .Threshold}}{{.Threshold}}{{else}}未采集{{end}}</td><td>{{if .Raw}}{{.Raw}}{{else}}未采集{{end}}</td><td><span class="badge {{if eq .Status "风险"}}smart-risk{{else if eq .Status "未知"}}smart-unknown{{else}}smart-normal{{end}}">{{if .Status}}{{.Status}}{{else}}未采集{{end}}</span></td></tr>{{end}}</tbody></table></div></details>{{end}}
                            {{if smartRiskReminder .Smart}}<div class="smart-risk-note mt-3">{{smartRiskReminder .Smart}}</div>{{end}}
                        </div>
                    </details>
                </div>
                {{end}}
            </div>
        </details>
        {{end}}
        <details class="mt-4"><summary class="text-primary">查看原始 JSON</summary><pre class="context-box mt-2 mb-0"><code>{{.SysInfo.RawJSON}}</code></pre></details>
    </details>
    {{end}}
	</aside>

    {{if .BlockDevicesPath}}
    <details class="sysinfo-card layout-block mb-4"><summary class="h5 mb-3">块设备信息</summary><iframe class="raw-log-frame" src="{{.BlockDevicesPath}}" loading="lazy" title="块设备原始信息"></iframe></details>
    {{end}}

    <aside class="layout-right">
    {{if .BuildVersions}}
    <details class="sysinfo-card mb-4"><summary class="h5 mb-3">应用构建版本 <span class="badge bg-secondary">{{len .BuildVersions}} 个应用</span></summary><div class="row g-3">{{range .BuildVersions}}<div class="col-12 col-md-6 col-xl-4"><div class="border rounded-3 p-3 h-100"><div class="info-label">{{.Category}}</div><div class="fw-bold text-break">{{.Application}}</div><div class="info-value mt-2">{{.Version}}</div>{{if .Timestamp}}<div class="text-muted small mt-2">最新时间：{{.Timestamp}}</div>{{end}}<div class="text-muted small mt-2 text-break">{{.File}}</div></div></div>{{end}}</div></details>
    {{end}}

    {{if .Networks}}
    <details class="sysinfo-card mb-4"><summary class="h5 mb-3">网络接口信息 <span class="badge bg-primary">{{len .Networks}} 个接口</span></summary><div class="table-responsive"><table class="table table-sm table-striped align-middle mb-0"><thead><tr><th>接口</th><th>MAC 地址</th><th>IPv4</th><th>IPv6</th><th>状态</th><th>MTU</th></tr></thead><tbody>{{range .Networks}}<tr><td class="fw-bold text-nowrap">{{if .Name}}{{.Name}}{{else}}未命名接口{{end}}</td><td class="text-break"><code>{{if .MAC}}{{.MAC}}{{else}}未采集{{end}}</code></td><td class="text-break">{{if .IPv4}}{{range $index, $address := .IPv4}}{{if $index}}、{{end}}{{$address}}{{end}}{{else}}无{{end}}</td><td class="text-break">{{if .IPv6}}{{range $index, $address := .IPv6}}{{if $index}}、{{end}}{{$address}}{{end}}{{else}}无{{end}}</td><td><span class="badge {{if eq .Status "正常"}}status-ok{{else if eq .Status "风险"}}status-risk{{else if eq .Status "未连接"}}status-offline{{else}}status-unknown{{end}}">{{if .Status}}{{.Status}}{{else}}未知{{end}}</span><div class="text-muted small mt-1">{{if .State}}{{.State}}{{else}}状态未知{{end}}{{if .Carrier}} · {{.Carrier}}{{end}}</div></td><td>{{if .MTU}}{{.MTU}}{{else}}未采集{{end}}</td></tr>{{end}}</tbody></table></div></details>
    {{end}}
	</aside>

    <section class="layout-center">
    <section class="toolbar mb-4">
        <div class="row g-2 align-items-center">
            <div class="col-12 col-lg-4"><label class="visually-hidden" for="searchInput">搜索</label><input id="searchInput" class="form-control" type="search" placeholder="搜索文件、关键词、问题描述或日志内容"></div>
            <div class="col-6 col-lg-2"><select id="categoryFilter" class="form-select"><option value="">全部分类</option>{{range .Categories}}<option>{{.}}</option>{{end}}</select></div>
            <div class="col-6 col-lg-2"><select id="keywordFilter" class="form-select"><option value="">全部关键词</option>{{range .Keywords}}<option>{{.}}</option>{{end}}</select></div>
            <div class="col-12 col-lg-4 d-flex flex-wrap gap-2 justify-content-lg-end"><button id="expandAll" class="btn btn-outline-primary" type="button">展开全部</button><button id="collapseAll" class="btn btn-outline-secondary" type="button">收起全部</button><button id="clearFilters" class="btn btn-light" type="button">清空筛选</button></div>
        </div>
        <div class="form-check mt-3"><input class="form-check-input" type="checkbox" id="nowrapToggle"><label class="form-check-label" for="nowrapToggle">日志保持单行并支持横向滚动</label><span id="visibleCount" class="text-muted small ms-3"></span></div>
    </section>

    <section id="resultsList">
        {{range $fileIndex, $result := .Results}}
        {{if $result.GroupedIssues}}
        <article class="result-card mb-3" data-category="{{$result.Category}}" data-search="{{$result.File}} {{$result.Category}}">
            <button class="result-head" type="button" data-bs-toggle="collapse" data-bs-target="#fileCollapse{{$fileIndex}}" aria-expanded="false">
                <div class="d-flex align-items-center gap-3"><span class="fs-4 text-primary">▸</span><div class="flex-grow-1"><div class="file-name">{{$result.File}}</div><div class="text-muted small">{{$result.Category}}</div></div><span class="badge bg-danger rounded-pill">{{len $result.GroupedIssues}} 个问题</span></div>
            </button>
            <div id="fileCollapse{{$fileIndex}}" class="collapse"><div class="issue-list">
                {{range $groupIndex, $group := $result.GroupedIssues}}
                <details class="issue-group" id="diagnosticIssue-{{$fileIndex}}-{{$groupIndex}}" data-keyword="{{$group.Keyword}}" data-severity="{{$group.Severity}}">
                    <summary class="issue-head d-flex flex-wrap align-items-center gap-2"><span class="badge severity-{{$group.Severity}}">{{if eq $group.Severity "critical"}}严重{{else if eq $group.Severity "warning"}}关注{{else}}信息{{end}}</span><span class="badge bg-warning text-dark">{{$group.Keyword}}</span><span class="issue-title-message">{{$group.Message}}</span><span class="text-muted small">{{$group.TotalCount}} 次命中{{if ne $group.ShowCount $group.TotalCount}}，默认显示最新 {{$group.ShowCount}} 次{{end}}</span></summary>
                    <div class="issue-item" data-search="{{$group.Keyword}} {{$group.Message}} {{range $issue := $group.Issues}}{{$issue.Context}} {{end}}">
                        <div class="d-flex flex-wrap align-items-center gap-2 mb-2"><span class="badge bg-secondary">{{$group.TotalCount}} 个命中点</span></div>
                        <div class="context-box"><button class="copy-context btn btn-sm btn-outline-light" type="button">复制全部上下文</button>{{range $issue := $group.Issues}}{{range $line := $issue.ContextLines}}<div class="context-line {{if $line.Hit}}context-line-hit{{end}}"><span class="line-number">{{$line.Number}}</span><code class="context-text">{{$line.Text}}</code></div>{{end}}{{end}}</div>
                    </div>
                </details>
                {{end}}
            </div></div>
        </article>
        {{end}}
        {{else}}<div class="empty-state metric-card">未发现匹配问题，当前日志没有命中配置规则。</div>{{end}}
        <div id="filterEmpty" class="empty-state metric-card hidden-by-filter">没有符合当前筛选条件的结果。</div>
    </section>
	</section>

</div>
</main>
<script src="static/bootstrap.bundle.min.js"></script>
<script>
(function () {
    const cards = Array.from(document.querySelectorAll('.result-card'));
    const search = document.getElementById('searchInput');
    const category = document.getElementById('categoryFilter');
    const keyword = document.getElementById('keywordFilter');
    const visibleCount = document.getElementById('visibleCount');
    const filterEmpty = document.getElementById('filterEmpty');
    const normalize = value => (value || '').toLocaleLowerCase();

    function applyFilters() {
        const query = normalize(search.value);
        const selectedCategory = normalize(category.value);
        const selectedKeyword = normalize(keyword.value);
        let visibleCards = 0;
        let visibleIssues = 0;
        cards.forEach(card => {
            const cardText = normalize(card.dataset.search);
            const categoryMatch = !selectedCategory || normalize(card.dataset.category) === selectedCategory;
            let cardHasIssue = false;
            card.querySelectorAll('.issue-group').forEach(group => {
                const groupMatch = !selectedKeyword || normalize(group.dataset.keyword) === selectedKeyword;
                let groupHasIssue = false;
                group.querySelectorAll('.issue-item').forEach(issue => {
                    const issueMatch = (!query || cardText.includes(query) || normalize(issue.dataset.search).includes(query)) && groupMatch;
                    issue.classList.toggle('hidden-by-filter', !issueMatch);
                    if (issueMatch) { groupHasIssue = true; visibleIssues++; }
                });
                group.classList.toggle('hidden-by-filter', !groupHasIssue);
                if (groupHasIssue) cardHasIssue = true;
            });
            const showCard = categoryMatch && cardHasIssue;
            card.classList.toggle('hidden-by-filter', !showCard);
            if (showCard) visibleCards++;
        });
        filterEmpty.classList.toggle('hidden-by-filter', visibleCards !== 0 || cards.length === 0);
        visibleCount.textContent = '当前显示 ' + visibleCards + ' 个文件、' + visibleIssues + ' 条记录';
    }

    [search, category, keyword].forEach(control => control.addEventListener('input', applyFilters));
    document.getElementById('clearFilters').addEventListener('click', () => { search.value = ''; category.value = ''; keyword.value = ''; applyFilters(); });
    function setAll(open) {
        document.querySelectorAll('.collapse').forEach(panel => panel.classList.toggle('show', open));
        document.querySelectorAll('[data-bs-toggle="collapse"]').forEach(button => button.setAttribute('aria-expanded', String(open)));
        document.querySelectorAll('details').forEach(detail => detail.open = open);
    }
    document.getElementById('expandAll').addEventListener('click', () => setAll(true));
    document.getElementById('collapseAll').addEventListener('click', () => setAll(false));
    document.querySelectorAll('[data-detail-target]').forEach(button => button.addEventListener('click', () => {
        const target = document.getElementById(button.dataset.detailTarget);
        if (!target) return;
        if (target.tagName === 'DETAILS') target.open = true;
        let ancestor = target.parentElement && target.parentElement.closest('details');
        while (ancestor) {
            ancestor.open = true;
            ancestor = ancestor.parentElement && ancestor.parentElement.closest('details');
        }
        target.querySelectorAll('details').forEach(detail => detail.open = true);
        target.querySelectorAll('.collapse').forEach(panel => panel.classList.add('show'));
        target.querySelectorAll('[data-bs-toggle="collapse"]').forEach(toggle => toggle.setAttribute('aria-expanded', 'true'));
        requestAnimationFrame(() => target.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    }));
    document.getElementById('nowrapToggle').addEventListener('change', event => document.querySelectorAll('.context-box').forEach(box => box.classList.toggle('nowrap', event.target.checked)));
    document.querySelectorAll('.copy-context').forEach(button => button.addEventListener('click', async () => {
        const text = Array.from(button.parentElement.querySelectorAll('code')).map(line => line.textContent).join('\n');
        try { await navigator.clipboard.writeText(text); button.textContent = '已复制'; setTimeout(() => button.textContent = '复制全部上下文', 1200); }
        catch (_) { button.textContent = '复制失败'; setTimeout(() => button.textContent = '复制全部上下文', 1200); }
    }));
    applyFilters();
})();
</script>
</body>
</html>`
