import { ChevronLeft, CircleAlert, CircleCheck, Copy, ExternalLink, FilePlus2, FolderOpen, MoreHorizontal, PanelRightOpen, Play, Save, Settings, ShieldAlert, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildResultPresentation } from '../shared/result-presentation';
import { createEvidenceDrawerController, getEvidencePresentation, type EvidenceDrawerController, type EvidenceDrawerState } from './evidence-drawer';
import { AppHostClient } from './host-api';
import { createPackageImportWorkflow } from './package-file-import';
import { createSettingsActions, type MonitorSettings } from './settings-actions';
import { formatElapsed, getQueuePosition, isOutsideOverflowMenu } from './task-presentation';

interface PackageItem { id: string; displayName: string; sourcePath: string; detectedAt: string; status: 'pending' | 'queued' | 'running' | 'report-ready' | 'failed' | 'cancelled'; reportPath?: string; }
interface TaskItem { id: string; packageId: string; status: string; createdAt: string; startedAt?: string; progress: number; message: string; errorMessage?: string; }
interface Finding { id: string; type: string; title: string; summary: string; severity: 'critical' | 'warning' | 'info'; occurrenceCount: number; evidenceIds: string[]; }
interface Evidence { id: string; timestamp?: string; timestampPrecision: string; sourceFile: string; lineNumber?: number; eventType: string; resource?: string; rawMessage: string; }
interface Diagnosis { id: string; title: string; summary: string; severity: string; confidence: string; affectedResources: string[]; affectedDeviceResources?: string[]; findingIds: string[]; userConclusion?: string; engineerConclusion?: string; }
interface Result { diagnoses: Diagnosis[]; findings: Finding[]; evidence: Evidence[]; deviceAssessments?: Array<{ resource: string; label?: string; serial?: string; usedFor?: string; smartRiskAttributes: Array<{ id: number; name: string; raw: number }>; ioErrorCount: number; }>; recommendations: Array<{ id: string; priority: number; title: string; reason: string; risk: string }>; metadata: { source: string; missingData: string[] }; }
interface EvidenceContext { available: boolean; lines: string[]; message?: string; }

const host = new AppHostClient('analysis-center');

/**
 * 分析中心只负责把已有诊断数据编排为桌面工作流，不在 renderer 推断告警或修改任务状态。
 * 工作区强调待办优先级，结果页根据原生窗口宽度在固定证据栏与覆盖式 Drawer 间切换。
 */
export function AnalysisCenterApp() {
  const [packages, setPackages] = useState<PackageItem[]>([]);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [monitor, setMonitor] = useState<MonitorSettings>({ enabled: false, scanIntervalMinutes: 5 });
  const [resultPackageId, setResultPackageId] = useState<string>();
  const [result, setResult] = useState<Result>();
  const [message, setMessage] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState<MonitorSettings>({ enabled: false, scanIntervalMinutes: 5 });
  const [settingsError, setSettingsError] = useState('');
  const [monitorStatus, setMonitorStatus] = useState<{ state: string; warning?: string }>({ state: 'disabled' });
  const [now, setNow] = useState(Date.now());
  const initialEvidencePresentation = getEvidencePresentation(window.innerWidth);
  const [evidenceDrawerState, setEvidenceDrawerState] = useState<EvidenceDrawerState>({ presentation: initialEvidencePresentation, open: false });
  const evidenceDrawerControllerRef = useRef<EvidenceDrawerController | null>(null);
  if (!evidenceDrawerControllerRef.current) evidenceDrawerControllerRef.current = createEvidenceDrawerController(initialEvidencePresentation, setEvidenceDrawerState);
  const evidenceDrawerController = evidenceDrawerControllerRef.current;
  const evidencePanelRef = useRef<HTMLElement>(null);
  const evidenceDrawerRef = useRef<HTMLElement>(null);
  const evidenceCloseRef = useRef<HTMLButtonElement>(null);
  const settingsDraftRef = useRef(settingsDraft);
  settingsDraftRef.current = settingsDraft;
  const showError = (error: unknown) => setMessage(error instanceof Error ? error.message : String(error));

  const load = useCallback(async () => {
    const [nextPackages, nextTasks, nextMonitor, nextMonitorStatus] = await Promise.all([
      host.invoke<PackageItem[]>('packages.list'), host.invoke<TaskItem[]>('tasks.list'), host.invoke<MonitorSettings>('settings.get'), host.invoke<{ state: string; warning?: string }>('monitor.status')
    ]);
    setPackages(nextPackages); setTasks(nextTasks); setMonitor(nextMonitor); setMonitorStatus(nextMonitorStatus);
  }, []);

  const packageImportWorkflow = useMemo(() => createPackageImportWorkflow({ host, refresh: load, reportFailures: setMessage }), [load]);
  const settingsActions = useMemo(() => createSettingsActions({
    host,
    getDraft: () => settingsDraftRef.current,
    changeDraft: setSettingsDraft,
    reportError: setSettingsError,
    refresh: load,
    close: () => setSettingsOpen(false)
  }), [load]);

  useEffect(() => {
    void load().catch(showError);
    const removeEvent = host.onEvent((event) => { void packageImportWorkflow.handleHostEvent(event).catch(showError); });
    return removeEvent;
  }, [load, packageImportWorkflow]);

  useEffect(() => {
    const updateEvidencePresentation = () => evidenceDrawerController.setPresentation(getEvidencePresentation(window.innerWidth));
    window.addEventListener('resize', updateEvidencePresentation);
    return () => window.removeEventListener('resize', updateEvidencePresentation);
  }, [evidenceDrawerController]);

  useEffect(() => {
    if (!evidenceDrawerState.open || !evidenceCloseRef.current || !evidenceDrawerRef.current) return;
    return evidenceDrawerController.attachLifecycle(document, evidenceCloseRef.current, evidenceDrawerRef.current);
  }, [evidenceDrawerController, evidenceDrawerState.open]);

  useEffect(() => {
    if (!tasks.some((task) => task.status === 'queued' || task.status === 'running')) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [tasks]);

  const failureByPackageId = useMemo(() => new Map(tasks.filter((task) => task.status === 'failed').map((task) => [task.packageId, task.errorMessage ?? task.message])), [tasks]);
  const openSettings = () => { setSettingsDraft(monitor); setSettingsError(''); setSettingsOpen(true); };
  const openEvidence = (trigger: HTMLButtonElement) => {
    if (evidenceDrawerController.open(trigger)) return;
    evidencePanelRef.current?.focus({ preventScroll: true });
    evidencePanelRef.current?.scrollIntoView({ block: 'nearest' });
  };
  const openResult = async (packageId: string) => { const value = await host.invoke<Result | null>('results.get', { packageId }); if (value) { setResult(value); setResultPackageId(packageId); } };
  const importPackages = async () => { try { await packageImportWorkflow.importSelectedFiles(); } catch (error) { showError(error); } };
  const importDroppedPackages = async (files: File[]) => { try { await packageImportWorkflow.importDroppedFiles(files); } catch (error) { showError(error); } };
  const analyze = async (packageId: string) => { try { await host.invoke('analysis.start', { packageId }); await load(); } catch (error) { showError(error); } };
  const selectMonitorDirectory = async () => settingsActions.chooseDirectory();
  const saveSettings = async () => settingsActions.save();
  const openBrowser = async () => { const item = packages.find((value) => value.id === resultPackageId); if (item?.reportPath) await host.invoke('host.openPath', { path: item.reportPath }); };
  const saveHtml = async () => { try { const item = packages.find((value) => value.id === resultPackageId); if (!item) return; const content = await host.invoke<string>('results.html', { packageId: item.id }); await host.invoke('host.saveFile', { fileName: `${item.displayName}.html`, content, kind: 'html' }); } catch (error) { showError(error); } };

  const settingsDialog = settingsOpen && <SettingsDialog draft={settingsDraft} error={settingsError} status={monitorStatus} onClose={() => setSettingsOpen(false)} onChoose={() => void selectMonitorDirectory()} onChange={setSettingsDraft} onSave={() => void saveSettings()} />;
  const resultPage = result && resultPackageId ? <main className="analysis-v1 result-view"><header className="result-toolbar"><button className="icon-button" title="返回分析工作区" aria-label="返回分析工作区" onClick={() => { setResult(undefined); setResultPackageId(undefined); }}><ChevronLeft size={18} /></button><strong title={result.metadata.source}>{result.metadata.source}</strong><div className="result-toolbar-actions"><button type="button" onClick={(event) => openEvidence(event.currentTarget)}><PanelRightOpen size={15} aria-hidden="true" />诊断证据</button><button onClick={() => void openBrowser()}><ExternalLink size={15} />在浏览器打开</button><button className="icon-button" title="另存为 HTML" aria-label="另存为 HTML" onClick={() => void saveHtml()}><Save size={16} /></button><button type="button" className="icon-button" title="打开分析中心设置" aria-label="打开分析中心设置" onClick={openSettings}><Settings size={17} aria-hidden="true" /></button></div></header><div className="result-layout"><section className="result-main"><DiagnosisView result={result} onEvidence={(trigger) => openEvidence(trigger)} /></section>{evidenceDrawerState.presentation === 'panel' && <EvidencePanel panelRef={evidencePanelRef} packageId={resultPackageId} result={result} />}</div>{evidenceDrawerState.presentation === 'drawer' && evidenceDrawerState.open && <div className="evidence-drawer-backdrop" role="presentation" onMouseDown={evidenceDrawerController.close}><section ref={evidenceDrawerRef} className="evidence-drawer" role="dialog" aria-modal="true" aria-label="诊断证据抽屉" onMouseDown={(event) => event.stopPropagation()}><EvidencePanel closeControlRef={evidenceCloseRef} onClose={evidenceDrawerController.close} packageId={resultPackageId} result={result} /></section></div>}{settingsDialog}</main> : undefined;
  if (resultPage) return resultPage;

  const pending = packages.filter((item) => item.status === 'pending');
  const running = tasks.filter((item) => item.status === 'running' || item.status === 'queued');
  const recent = packages.filter((item) => item.status === 'report-ready').slice(0, 20);
  const failed = packages.filter((item) => item.status === 'failed');
  const drop = (event: React.DragEvent) => { event.preventDefault(); void importDroppedPackages([...event.dataTransfer.files]); };
  return <main className="analysis-v1 workspace-view"><header className="workspace-toolbar"><h1>分析中心</h1><button type="button" className="icon-button" title="打开分析中心设置" aria-label="打开分析中心设置" onClick={openSettings}><Settings size={17} aria-hidden="true" /></button></header>{message && <div className="message" role="alert">{message}</div>}<section className="workspace-dropzone" onDragOver={(event) => event.preventDefault()} onDrop={drop}><FilePlus2 size={31} aria-hidden="true" /><strong>拖入诊断包，导入到“待分析”</strong><p>支持格式：.tgz · .tgz.temp · .zip</p><button className="primary-action" onClick={() => void importPackages()}>选择诊断包</button></section>{pending.length > 0 && <WorkspaceList title="待分析" items={pending} onChanged={load} action={(item) => <button className="secondary-action" onClick={() => void analyze(item.id)}><Play size={15} />开始分析</button>} />}{running.length > 0 && <RunningTasks tasks={running} packages={packages} now={now} />}{failed.length > 0 && <WorkspaceList title="分析失败" items={failed} onChanged={load} failureByPackageId={failureByPackageId} onAnalyze={analyze} action={() => null} />}{recent.length > 0 && <WorkspaceList title="最近分析" items={recent} onChanged={load} onAnalyze={analyze} action={(item) => <button className="secondary-action" onClick={() => void openResult(item.id).catch(showError)}>查看结果</button>} />}{settingsDialog}</main>;
}

/** 诊断包列表复用同一行结构，避免各个状态分区的文件信息呈现出现偏差。 */
function WorkspaceList({ title, items, action, onChanged, failureByPackageId, onAnalyze }: { title: string; items: PackageItem[]; action: (item: PackageItem) => React.ReactNode; onChanged: () => Promise<void>; failureByPackageId?: Map<string, string>; onAnalyze?: (packageId: string) => Promise<void> }) {
  const [openMenuPackageId, setOpenMenuPackageId] = useState<string>();
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const closeFromOutside = (event: PointerEvent) => { if (openMenuPackageId && isOutsideOverflowMenu(event.target, menuRef.current, triggerRef.current)) setOpenMenuPackageId(undefined); };
    const closeFromEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpenMenuPackageId(undefined); };
    document.addEventListener('pointerdown', closeFromOutside);
    document.addEventListener('keydown', closeFromEscape);
    return () => { document.removeEventListener('pointerdown', closeFromOutside); document.removeEventListener('keydown', closeFromEscape); };
  }, [openMenuPackageId]);
  const locate = async (packageId: string, method: 'packages.locate-source' | 'packages.locate-extract') => { const path = await host.invoke<string>(method, { packageId }); await host.invoke('host.showItemInFolder', { path }); };
  const remove = async (packageId: string) => { const preview = await host.invoke<{ packageCount: number; confirmationToken: string }>('packages.delete-preview', { packageIds: [packageId] }); if (!window.confirm(`将永久删除 ${preview.packageCount} 个诊断包及其分析记录，是否继续？`)) return; await host.invoke('packages.delete', { packageIds: [packageId], confirmationToken: preview.confirmationToken }); await onChanged(); };
  return <section className="workspace-section workspace-list"><header className="workspace-section-heading"><h2>{title} <span>{items.length}</span></h2></header>{items.map((item) => <article className="workspace-list-item" key={item.id} onContextMenu={() => setOpenMenuPackageId(item.id)}><PackageStatusIcon status={item.status} /><div className="workspace-item-copy"><strong title={item.displayName}>{item.displayName}</strong><span title={item.status === 'failed' ? failureByPackageId?.get(item.id) : item.sourcePath}>{item.status === 'failed' ? failureByPackageId?.get(item.id) ?? '分析失败，请查看失败原因。' : formatDetectedAt(item.detectedAt)}</span></div><div className="card-actions">{action(item)}<button ref={openMenuPackageId === item.id ? triggerRef : undefined} className="overflow-trigger" type="button" aria-label={`打开${item.displayName}的更多操作`} aria-haspopup="menu" aria-expanded={openMenuPackageId === item.id} onClick={() => setOpenMenuPackageId((current) => current === item.id ? undefined : item.id)}><MoreHorizontal size={18} /></button>{openMenuPackageId === item.id && <div ref={menuRef} className="overflow-menu" role="menu"><button type="button" role="menuitem" onClick={() => void locate(item.id, 'packages.locate-source')}><FolderOpen size={15} />定位诊断包</button><button type="button" role="menuitem" onClick={() => void locate(item.id, 'packages.locate-extract')}><FolderOpen size={15} />定位解压目录</button>{onAnalyze && (item.status === 'report-ready' || item.status === 'failed') && <button type="button" role="menuitem" onClick={() => void onAnalyze(item.id)}><Play size={15} />重新分析</button>}<button className="danger" type="button" role="menuitem" disabled={item.status === 'running' || item.status === 'queued'} onClick={() => void remove(item.id)}>删除诊断包</button></div>}</div></article>)}</section>;
}

function RunningTasks({ tasks, packages, now }: { tasks: TaskItem[]; packages: PackageItem[]; now: number }) { return <section className="workspace-section workspace-list"><header className="workspace-section-heading"><h2>分析队列 <span>{tasks.length}</span></h2></header>{tasks.map((task) => { const queued = task.status === 'queued'; const elapsed = formatElapsed(queued ? task.createdAt : task.startedAt, now); const detail = queued ? `排队中，前方还有 ${getQueuePosition(task.id, tasks)} 个任务 · ${elapsed.replace('已用时', '已等待')}` : `${task.message} · ${elapsed}`; return <article className="running-task" key={task.id}><div><strong>{packages.find((item) => item.id === task.packageId)?.displayName ?? '诊断包'}</strong><span>{detail}</span></div><div className="task-progress"><progress value={task.progress} max={100}>{task.progress}%</progress><strong>{task.progress}%</strong></div></article>; })}</section>; }

function PackageStatusIcon({ status }: { status: PackageItem['status'] }) { if (status === 'failed') return <CircleAlert className="package-status-icon is-danger" size={19} aria-label="分析失败" />; if (status === 'report-ready') return <CircleCheck className="package-status-icon is-success" size={19} aria-label="分析完成" />; return <FilePlus2 className="package-status-icon" size={19} aria-hidden="true" />; }

function DiagnosisView({ result, onEvidence }: { result: Result; onEvidence: (trigger: HTMLButtonElement) => void }) {
  const presentation = buildResultPresentation(result as never);
  const primary = presentation.primary;
  const copyConclusion = () => { void navigator.clipboard?.writeText(presentation.customerReply); };
  return <><section className={`primary-diagnosis severity-${presentation.summary.severity}`}><div className="severity-label">结论摘要 <span>{presentation.summary.confidence}</span></div><h1>{presentation.summary.title}</h1><p>{presentation.summary.text}</p></section><section className="user-conclusion"><header><h2>建议回复用户</h2><button className="icon-text-button" onClick={copyConclusion}><Copy size={15} />复制</button></header><p>{presentation.customerReply}</p></section>{primary && <section className="result-section"><h2>主要诊断</h2><p className="engineer-conclusion">{primary.engineerConclusion ?? primary.summary}</p><button className="text-action" onClick={(event) => onEvidence(event.currentTarget)}>为什么这样判断？</button></section>}{(presentation.impact.devices.length + presentation.impact.raids.length + presentation.impact.storage.length) > 0 && <section className="result-section"><h2>影响范围</h2><div className="impact-list">{presentation.impact.devices.map((device) => <p key={device.resource}><strong>{device.label}</strong><span>{device.serial ?? '日志未提供'} · {device.usedFor} · {device.resource}</span></p>)}{presentation.impact.raids.map((item) => <p key={item.resource}><strong>RAID</strong><span>{item.label}</span></p>)}{presentation.impact.storage.map((item) => <p key={item.resource}><strong>存储池</strong><span>{item.label}</span></p>)}</div></section>}{primary && !result.deviceAssessments && <section className="partial"><h2>硬盘身份信息不可用</h2><p>该历史结果未保存硬盘身份与双结论信息，请重新分析诊断包以查看硬盘身份和双结论。</p></section>}<section className="result-section"><h2>建议处理</h2>{result.recommendations.length ? <ol className="recommendations">{result.recommendations.map((item) => <li key={item.id}><span className={`recommendation-priority priority-${item.priority}`}>{item.priority}</span><div><strong>{item.title}</strong><p>{item.reason}</p></div><small>{item.risk === 'safe' ? '安全检查' : '需要确认'}</small></li>)}</ol> : <p className="muted">当前没有需要立即执行的建议。</p>}</section>{presentation.importantFindings.length > 0 && <section className="result-section"><h2>其他重要发现</h2>{presentation.importantFindings.map((item) => <article className={`finding severity-${item.severity}`} key={item.id}><div className="finding-heading"><strong>{item.display.title}</strong><span>{item.display.riskLabel}</span></div><p>{item.display.occurrenceText}</p>{item.display.affectedResources.length > 0 && <p>影响对象：{item.display.affectedResources.join('、')}</p>}<p>{item.display.meaning}</p><p className="finding-advice"><strong>建议：</strong>{item.display.advice}</p><small className="finding-event">技术事件：<code>{item.display.technicalEvent}</code></small></article>)}</section>}{result.metadata.missingData.length > 0 && <section className="partial"><h2>分析完成，但缺少部分数据</h2><p>缺少：{result.metadata.missingData.join('、')}。当前诊断置信度可能受到影响。</p></section>}</>;
}

/** 证据内容与数据加载只有一份实现，宽屏固定栏和窄屏 Drawer 仅改变其容器。 */
function EvidencePanel({ packageId, result, panelRef, closeControlRef, onClose }: { packageId: string; result: Result; panelRef?: React.RefObject<HTMLElement | null>; closeControlRef?: React.RefObject<HTMLButtonElement | null>; onClose?: () => void }) {
  const [contexts, setContexts] = useState<Record<string, EvidenceContext>>({});
  const evidence = useMemo(() => { const ids = new Set(result.diagnoses[0]?.findingIds.flatMap((id) => result.findings.find((item) => item.id === id)?.evidenceIds ?? []) ?? []); return result.evidence.filter((item) => ids.has(item.id)); }, [result]);
  useEffect(() => { void Promise.all(evidence.map(async (item) => [item.id, await host.invoke<EvidenceContext>('results.evidence-context', { packageId, evidenceId: item.id })] as const)).then((entries) => setContexts(Object.fromEntries(entries))).catch(() => setContexts({})); }, [evidence, packageId]);
  return <aside ref={panelRef} tabIndex={-1} className="result-evidence-panel" id="diagnostic-evidence" aria-label="诊断证据"><header><h2>诊断证据</h2><div className="evidence-panel-actions"><span>{evidence.length} 条</span>{onClose && <button ref={closeControlRef} type="button" className="icon-button" title="关闭诊断证据" aria-label="关闭诊断证据" onClick={onClose}><X size={17} aria-hidden="true" /></button>}</div></header>{evidence.length ? evidence.map((item) => <article className="evidence-card" key={item.id}><div className="evidence-tag">{item.eventType}</div><dl><dt>来源</dt><dd title={item.sourceFile}>{item.sourceFile}{item.lineNumber ? `:${item.lineNumber}` : ''}</dd>{item.resource && <><dt>资源</dt><dd>{item.resource}</dd></>}{item.timestamp && <><dt>时间</dt><dd>{item.timestamp}</dd></>}</dl><code>{contexts[item.id]?.available ? contexts[item.id].lines.join('\n') : contexts[item.id]?.message ?? item.rawMessage}</code></article>) : <div className="evidence-empty"><ShieldAlert size={20} aria-hidden="true" /><p>当前主要诊断没有关联证据</p></div>}</aside>;
}

function SettingsDialog({ draft, error, status, onClose, onChoose, onChange, onSave }: { draft: MonitorSettings; error: string; status: { state: string; warning?: string }; onClose: () => void; onChoose: () => void; onChange: (value: MonitorSettings) => void; onSave: () => void }) { return <div className="analysis-settings-backdrop" role="presentation" onMouseDown={onClose}><section className="analysis-settings-popover" role="dialog" aria-modal="true" aria-label="分析中心设置" onMouseDown={(event) => event.stopPropagation()}><header className="settings-heading"><h2>分析中心设置</h2><button className="icon-button" aria-label="关闭设置" onClick={onClose}><X size={16} /></button></header><section className="settings-group"><h3>监控目录</h3><label className="switch-field"><span>启用目录监控</span><input type="checkbox" checked={draft.enabled} onChange={(event) => onChange({ ...draft, enabled: event.target.checked })} /></label><div className="settings-field"><span>监控目录</span><div className="directory-item"><code title={draft.directory}>{draft.directory ?? '尚未选择目录'}</code><button onClick={onChoose}>选择</button></div></div><label className="settings-field"><span>扫描间隔（分钟）</span><input type="number" min="1" step="1" value={draft.scanIntervalMinutes} onChange={(event) => onChange({ ...draft, scanIntervalMinutes: event.currentTarget.valueAsNumber })} /></label><p>检测到稳定的新诊断包后，自动加入“待分析”，不会自动开始分析。</p></section><section className="settings-group settings-formats"><h3>支持格式</h3><p>.tgz · .tgz.temp · .zip</p></section>{status.state === 'paused' && <p className="message" role="alert">监控已暂停：{status.warning}</p>}{error && <p className="message" role="alert">{error}</p>}<footer className="dialog-actions"><button onClick={onClose}>取消</button><button className="primary-action" onClick={onSave}>保存</button></footer></section></div>; }

function formatDetectedAt(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : `检测时间：${new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date)}`; }
