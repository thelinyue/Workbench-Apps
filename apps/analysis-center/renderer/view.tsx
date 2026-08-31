import { ChevronLeft, CircleAlert, CircleCheck, Clock3, Copy, ExternalLink, FileJson2, FilePlus2, FolderOpen, LoaderCircle, MoreHorizontal, PanelRightOpen, Play, Save, ScanSearch, Settings, ShieldAlert, Trash2, Upload, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildResultPresentation } from '../shared/result-presentation';
import { createEvidenceDrawerController, getEvidencePresentation, type EvidenceDrawerController, type EvidenceDrawerState } from './evidence-drawer';
import { AppHostClient } from './host-api';
import { createLatestLoad } from './load-coordinator';
import { createPackageImportWorkflow } from './package-file-import';
import { createSettingsActions, type MonitorSettings } from './settings-actions';
import { formatElapsed, getAnalysisRuntimePresentation, getLatestRuntimeTimingsByPackageId, getQueuePosition, isOutsideOverflowMenu, type AnalysisRuntimeTimingsView } from './task-presentation';
import { startDialogLifecycle } from './dialog-lifecycle';
import { openSysinfoReport } from './sysinfo-report-action';
import { formatFileSize, getAnalysisStageItems, getNextRecentPackageSelection, getNotificationActivation, getPackageDeletionConfirmation, getPackageRecordDeletionConfirmation, getPackageTone, getRecentAnalysisPackageIds, getRecentAnalysisPresentation, getWorkspaceGroups, type AnalysisTaskStage } from './workspace-presentation';

interface PackageItem { id: string; displayName: string; sourcePath: string; sourceSizeBytes?: number; detectedAt: string; status: 'pending' | 'queued' | 'running' | 'report-ready' | 'failed' | 'cancelled'; reportPath?: string; }
interface TaskItem { id: string; packageId: string; status: string; createdAt: string; startedAt?: string; progress: number; stage: AnalysisTaskStage; message: string; errorMessage?: string; runtimeTimings?: AnalysisRuntimeTimingsView; }
interface Finding { id: string; type: string; title: string; summary: string; severity: 'critical' | 'warning' | 'info'; occurrenceCount: number; evidenceIds: string[]; }
interface Evidence { id: string; timestamp?: string; timestampPrecision: string; sourceFile: string; lineNumber?: number; eventType: string; resource?: string; rawMessage: string; }
interface Diagnosis { id: string; title: string; summary: string; severity: string; confidence: string; affectedResources: string[]; affectedDeviceResources?: string[]; findingIds: string[]; userConclusion?: string; engineerConclusion?: string; }
interface Result { diagnoses: Diagnosis[]; findings: Finding[]; evidence: Evidence[]; deviceAssessments?: Array<{ resource: string; label?: string; serial?: string; usedFor?: string; smartRiskAttributes: Array<{ id: number; name: string; raw: number }>; ioErrorCount: number; }>; recommendations: Array<{ id: string; priority: number; title: string; reason: string; risk: string }>; metadata: { source: string; missingData: string[] }; }
interface ResultSummary { diagnoses: Array<Pick<Diagnosis, 'title' | 'severity'>>; }
interface EvidenceContext { available: boolean; lines: string[]; message?: string; }
interface PackageDeletionPreview { packageCount: number; extractPaths: string[]; confirmationToken: string; }
interface PackageRecordDeletionPreview { packageCount: number; taskCount: number; caseCount: number; analysisRecordCount: number; reportRecordCount: number; confirmationToken: string; }
type PendingPackageDeletion =
  | { packageIds: string[]; mode: 'lifecycle'; preview: PackageDeletionPreview; trigger: HTMLButtonElement | null }
  | { packageIds: string[]; mode: 'records'; preview: PackageRecordDeletionPreview; trigger: HTMLButtonElement | null };

const host = new AppHostClient('analysis-center');

/**
 * 分析中心只负责把已有诊断数据编排为桌面工作流，不在 renderer 推断告警或修改任务状态。
 * 工作区强调待办优先级，结果页根据原生窗口宽度在固定证据栏与覆盖式 Drawer 间切换。
 */
export function AnalysisCenterApp() {
  const [packages, setPackages] = useState<PackageItem[]>([]);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [monitor, setMonitor] = useState<MonitorSettings>({ enabled: false, autoAnalyzeEnabled: true, scanIntervalSeconds: 10 });
  const [recentResults, setRecentResults] = useState<Array<{ packageId: string; result: ResultSummary }>>([]);
  const [resultPackageId, setResultPackageId] = useState<string>();
  const [result, setResult] = useState<Result>();
  const [message, setMessage] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsDraft, setSettingsDraft] = useState<MonitorSettings>({ enabled: false, autoAnalyzeEnabled: true, scanIntervalSeconds: 10 });
  const [settingsError, setSettingsError] = useState('');
  const [monitorStatus, setMonitorStatus] = useState<{ state: string; warning?: string }>({ state: 'disabled' });
  const [dragging, setDragging] = useState(false);
  const [scanningExisting, setScanningExisting] = useState(false);
  const [sysinfoReportLoading, setSysinfoReportLoading] = useState(false);
  const [highlightedPackageId, setHighlightedPackageId] = useState<string>();
  const [now, setNow] = useState(Date.now());
  const initialEvidencePresentation = getEvidencePresentation(window.innerWidth);
  const [evidenceDrawerState, setEvidenceDrawerState] = useState<EvidenceDrawerState>({ presentation: initialEvidencePresentation, open: false });
  const evidenceDrawerControllerRef = useRef<EvidenceDrawerController | null>(null);
  if (!evidenceDrawerControllerRef.current) evidenceDrawerControllerRef.current = createEvidenceDrawerController(initialEvidencePresentation, setEvidenceDrawerState);
  const evidenceDrawerController = evidenceDrawerControllerRef.current;
  const evidencePanelRef = useRef<HTMLElement>(null);
  const evidenceDrawerRef = useRef<HTMLElement>(null);
  const evidenceCloseRef = useRef<HTMLButtonElement>(null);
  const settingsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const highlightedRef = useRef<HTMLElement | null>(null);
  const dragDepthRef = useRef(0);
  const settingsDraftRef = useRef(settingsDraft);
  settingsDraftRef.current = settingsDraft;
  const showError = (error: unknown) => setMessage(error instanceof Error ? error.message : String(error));
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  const load = useMemo(() => createLatestLoad(
    () => Promise.all([
      host.invoke<PackageItem[]>('packages.list'), host.invoke<TaskItem[]>('tasks.list'), host.invoke<MonitorSettings>('settings.get'), host.invoke<{ state: string; warning?: string }>('monitor.status'), host.invoke<Array<{ packageId: string; result: ResultSummary }>>('results.recent')
    ]),
    ([nextPackages, nextTasks, nextMonitor, nextMonitorStatus, nextRecentResults]) => {
      setPackages(nextPackages); setTasks(nextTasks); setMonitor(nextMonitor); setMonitorStatus(nextMonitorStatus); setRecentResults(nextRecentResults);
    }
  ), []);

  const openResult = useCallback(async (packageId: string) => {
    const value = await host.invoke<Result | null>('results.get', { packageId });
    if (value) { setResult(value); setResultPackageId(packageId); setHighlightedPackageId(undefined); }
  }, []);

  const packageImportWorkflow = useMemo(() => createPackageImportWorkflow({ host, refresh: load, reportFailures: setMessage }), [load]);
  const settingsActions = useMemo(() => createSettingsActions({
    host,
    getDraft: () => settingsDraftRef.current,
    changeDraft: setSettingsDraft,
    reportError: setSettingsError,
    refresh: load,
    close: closeSettings
  }), [closeSettings, load]);

  useEffect(() => {
    void load().catch(showError);
    const removeEvent = host.onEvent((event) => {
      void (async () => {
        const activation = getNotificationActivation(event);
        await packageImportWorkflow.handleHostEvent(event);
        if (!activation) return;
        if (activation.kind === 'result') await openResult(activation.packageId);
        else { setResult(undefined); setResultPackageId(undefined); setHighlightedPackageId(activation.packageId); }
      })().catch(showError);
    });
    return removeEvent;
  }, [load, openResult, packageImportWorkflow]);

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

  useEffect(() => {
    if (!highlightedPackageId || !highlightedRef.current) return;
    highlightedRef.current.scrollIntoView({ block: 'center' });
    highlightedRef.current.focus({ preventScroll: true });
  }, [highlightedPackageId, packages]);

  const failureByPackageId = useMemo(() => new Map(tasks.filter((task) => task.status === 'failed').map((task) => [task.packageId, task.errorMessage ?? task.message])), [tasks]);
  const runtimeTimingsByPackageId = useMemo(() => getLatestRuntimeTimingsByPackageId(tasks), [tasks]);
  const resultByPackageId = useMemo(() => new Map(recentResults.map((item) => [item.packageId, item.result])), [recentResults]);
  const openSettings = (trigger?: HTMLButtonElement) => { if (trigger) settingsTriggerRef.current = trigger; setSettingsDraft(monitor); setSettingsError(''); setSettingsOpen(true); };
  const openEvidence = (trigger: HTMLButtonElement) => {
    if (evidenceDrawerController.open(trigger)) return;
    evidencePanelRef.current?.focus({ preventScroll: true });
    evidencePanelRef.current?.scrollIntoView({ block: 'nearest' });
  };
  const importPackages = async () => { try { await packageImportWorkflow.importSelectedFiles(); } catch (error) { showError(error); } };
  const importDroppedPackages = async (files: File[]) => { try { await packageImportWorkflow.importDroppedFiles(files); } catch (error) { showError(error); } };
  const analyze = async (packageId: string) => { try { await host.invoke('analysis.start', { packageId }); await load(); } catch (error) { showError(error); } };
  const selectMonitorDirectory = async () => settingsActions.chooseDirectory();
  const saveSettings = async () => settingsActions.save();
  const scanExisting = async () => { setScanningExisting(true); setMessage(''); try { await host.invoke('packages.scan'); await load(); } catch (error) { showError(error); } finally { setScanningExisting(false); } };
  const openMonitorDirectory = async () => { if (monitor.directory) await host.invoke('host.openPath', { path: monitor.directory }); };
  const openBrowser = async () => { const item = packages.find((value) => value.id === resultPackageId); if (item?.reportPath) await host.invoke('host.openPath', { path: item.reportPath }); };
  const openCompleteSysinfo = async () => { if (!resultPackageId || sysinfoReportLoading) return; setSysinfoReportLoading(true); try { await openSysinfoReport(host, resultPackageId); } catch (error) { showError(error); } finally { setSysinfoReportLoading(false); } };
  const saveHtml = async () => { try { const item = packages.find((value) => value.id === resultPackageId); if (!item) return; const content = await host.invoke<string>('results.html', { packageId: item.id }); await host.invoke('host.saveFile', { fileName: `${item.displayName}.html`, content, kind: 'html' }); } catch (error) { showError(error); } };

  const settingsDialog = settingsOpen && <SettingsDialog draft={settingsDraft} error={settingsError} status={monitorStatus} trigger={settingsTriggerRef.current} onClose={closeSettings} onChoose={() => void selectMonitorDirectory()} onChange={setSettingsDraft} onSave={() => void saveSettings()} />;
  const resultPage = result && resultPackageId ? <main className="analysis-v1 result-view"><header className="result-toolbar"><button className="icon-button" title="返回分析工作区" aria-label="返回分析工作区" onClick={() => { setResult(undefined); setResultPackageId(undefined); }}><ChevronLeft size={18} /></button><strong title={result.metadata.source}>{result.metadata.source}</strong><div className="result-toolbar-actions"><button type="button" onClick={(event) => openEvidence(event.currentTarget)}><PanelRightOpen size={15} aria-hidden="true" />诊断证据</button><button type="button" className="sysinfo-report-button" disabled={sysinfoReportLoading} onClick={() => void openCompleteSysinfo()}>{sysinfoReportLoading ? <LoaderCircle className="is-spinning" size={15} aria-hidden="true" /> : <FileJson2 size={15} aria-hidden="true" />}{sysinfoReportLoading ? '生成中' : '查看完整 sysinfo'}</button><button onClick={() => void openBrowser()}><ExternalLink size={15} aria-hidden="true" />在浏览器打开</button><button className="icon-button" title="另存为 HTML" aria-label="另存为 HTML" onClick={() => void saveHtml()}><Save size={16} aria-hidden="true" /></button><button type="button" className="icon-button" title="打开分析中心设置" aria-label="打开分析中心设置" onClick={(event) => openSettings(event.currentTarget)}><Settings size={17} aria-hidden="true" /></button><ResultMoreMenu packageId={resultPackageId} /></div></header><div className="result-layout"><section className="result-main"><DiagnosisView result={result} onEvidence={(trigger) => openEvidence(trigger)} /></section>{evidenceDrawerState.presentation === 'panel' && <EvidencePanel panelRef={evidencePanelRef} packageId={resultPackageId} result={result} />}</div>{evidenceDrawerState.presentation === 'drawer' && evidenceDrawerState.open && <div className="evidence-drawer-backdrop" role="presentation" onMouseDown={evidenceDrawerController.close}><section ref={evidenceDrawerRef} className="evidence-drawer" role="dialog" aria-modal="true" aria-label="诊断证据抽屉" onMouseDown={(event) => event.stopPropagation()}><EvidencePanel closeControlRef={evidenceCloseRef} onClose={evidenceDrawerController.close} packageId={resultPackageId} result={result} /></section></div>}{settingsDialog}</main> : undefined;
  if (resultPage) return resultPage;

  const { pending, recent } = getWorkspaceGroups(packages);
  const running = tasks.filter((item) => item.status === 'running' || item.status === 'queued');
  const hasFiles = (event: React.DragEvent) => [...event.dataTransfer.types].includes('Files');
  const dragEnter = (event: React.DragEvent) => { if (!hasFiles(event)) return; event.preventDefault(); dragDepthRef.current += 1; setDragging(true); };
  const dragLeave = (event: React.DragEvent) => { if (!hasFiles(event)) return; event.preventDefault(); dragDepthRef.current = Math.max(0, dragDepthRef.current - 1); if (dragDepthRef.current === 0) setDragging(false); };
  const drop = (event: React.DragEvent) => { event.preventDefault(); dragDepthRef.current = 0; setDragging(false); void importDroppedPackages([...event.dataTransfer.files]); };
  const monitorStateLabel = monitorStatus.state === 'watching' ? '正在监控' : monitorStatus.state === 'paused' ? '监控已暂停' : '监控已关闭';
  const monitorDescription = monitor.enabled
    ? monitor.autoAnalyzeEnabled ? '仅对启用监控后新增且稳定的诊断包自动分析' : '发现新诊断包后加入待分析，不会自动开始'
    : '启用监控时只建立目录基线，存量需手动扫描';

  return <main className="analysis-v1 workspace-view" onDragEnter={dragEnter} onDragOver={(event) => { if (hasFiles(event)) event.preventDefault(); }} onDragLeave={dragLeave} onDrop={drop}>
    <section className="monitor-statusbar" aria-label="目录监控状态">
      <span className={`monitor-indicator state-${monitorStatus.state}`} aria-hidden="true" />
      <div className="monitor-state"><strong>{monitorStateLabel}</strong><span>{monitor.autoAnalyzeEnabled ? '自动分析开启' : '自动分析关闭'}</span></div>
      <div className="monitor-directory"><strong title={monitor.directory}>{monitor.directory ?? '尚未选择监控目录'}</strong><span>{monitorDescription}</span></div>
      <div className="monitor-actions"><button type="button" disabled={!monitor.directory || scanningExisting} onClick={() => void scanExisting()}><ScanSearch size={16} aria-hidden="true" />{scanningExisting ? '扫描中' : '扫描存量'}</button><button type="button" disabled={!monitor.directory} onClick={() => void openMonitorDirectory()}><FolderOpen size={16} aria-hidden="true" />打开目录</button><button type="button" className="icon-button" title="打开分析中心设置" aria-label="打开分析中心设置" onClick={(event) => openSettings(event.currentTarget)}><Settings size={17} aria-hidden="true" /></button></div>
    </section>
    {monitorStatus.warning && <div className="monitor-warning" role="alert">{monitorStatus.warning}</div>}
    {message && <div className="message" role="alert">{message}</div>}
    <WorkspaceList title="待分析" items={pending} emptyText="当前没有待分析诊断包" onChanged={load} onError={showError} action={(item) => <button className="secondary-action" onClick={() => void analyze(item.id)}><Play size={15} aria-hidden="true" />开始分析</button>} />
    <RunningTasks tasks={running} packages={packages} now={now} />
    <WorkspaceList title="最近分析" items={recent} emptyText="暂无已完成或失败的分析" onChanged={load} onError={showError} failureByPackageId={failureByPackageId} resultByPackageId={resultByPackageId} runtimeTimingsByPackageId={runtimeTimingsByPackageId} onAnalyze={analyze} enableBatchDeletion highlightedPackageId={highlightedPackageId} highlightedRef={highlightedRef} action={(item) => item.status === 'report-ready' ? <button className="secondary-action" onClick={() => void openResult(item.id).catch(showError)}>查看结果</button> : <button className="secondary-action" onClick={() => void analyze(item.id)}><Play size={15} aria-hidden="true" />重新分析</button>} />
    <section className="workspace-dropzone"><FolderOpen size={18} aria-hidden="true" /><span>不在监控目录中？</span><button className="text-action" onClick={() => void importPackages()}>手动选择诊断包</button><small>导入后进入待分析</small></section>
    {dragging && <div className="drop-overlay" role="presentation"><div className="drop-target"><span className="drop-icon"><Upload size={34} aria-hidden="true" /></span><strong>松开以导入诊断包</strong><p>支持 .tgz · .tgz.temp · .zip</p><small>导入后将加入待分析</small></div></div>}
    {settingsDialog}
  </main>;
}

/** 诊断包列表复用同一行结构，避免各个状态分区的文件信息呈现出现偏差。 */
function WorkspaceList({ title, items, emptyText, action, onChanged, onError, failureByPackageId, resultByPackageId, runtimeTimingsByPackageId, onAnalyze, enableBatchDeletion = false, highlightedPackageId, highlightedRef }: { title: string; items: PackageItem[]; emptyText: string; action: (item: PackageItem) => React.ReactNode; onChanged: () => Promise<void>; onError: (error: unknown) => void; failureByPackageId?: Map<string, string>; resultByPackageId?: Map<string, ResultSummary>; runtimeTimingsByPackageId?: Map<string, AnalysisRuntimeTimingsView>; onAnalyze?: (packageId: string) => Promise<void>; enableBatchDeletion?: boolean; highlightedPackageId?: string; highlightedRef?: React.MutableRefObject<HTMLElement | null> }) {
  const [openMenuPackageId, setOpenMenuPackageId] = useState<string>();
  const [deletingPackageId, setDeletingPackageId] = useState<string>();
  const [pendingDeletion, setPendingDeletion] = useState<PendingPackageDeletion>();
  const [deletionSubmitting, setDeletionSubmitting] = useState(false);
  const [selectedPackageIds, setSelectedPackageIds] = useState<string[]>([]);
  const [batchPreviewLoading, setBatchPreviewLoading] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const batchDeleteTriggerRef = useRef<HTMLButtonElement>(null);
  const deletionSubmittingRef = useRef(false);
  deletionSubmittingRef.current = deletionSubmitting;
  const selectablePackageIds = enableBatchDeletion ? getRecentAnalysisPackageIds(items) : [];
  const selectedIds = selectedPackageIds.filter((id) => selectablePackageIds.includes(id));
  const allSelectableSelected = selectablePackageIds.length > 0 && selectablePackageIds.every((id) => selectedIds.includes(id));
  const deletionBusy = batchPreviewLoading || deletionSubmitting || Boolean(deletingPackageId);
  useEffect(() => {
    const closeFromOutside = (event: PointerEvent) => { if (openMenuPackageId && isOutsideOverflowMenu(event.target, menuRef.current, triggerRef.current)) setOpenMenuPackageId(undefined); };
    const closeFromEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpenMenuPackageId(undefined); };
    document.addEventListener('pointerdown', closeFromOutside);
    document.addEventListener('keydown', closeFromEscape);
    return () => { document.removeEventListener('pointerdown', closeFromOutside); document.removeEventListener('keydown', closeFromEscape); };
  }, [openMenuPackageId]);
  const locate = async (packageId: string, method: 'packages.locate-source' | 'packages.locate-extract') => { const path = await host.invoke<string>(method, { packageId }); await host.invoke('host.showItemInFolder', { path }); };
  const remove = async (packageId: string, mode: 'lifecycle' | 'records') => {
    if (deletionBusy) return;
    const trigger = triggerRef.current;
    setOpenMenuPackageId(undefined);
    setDeletingPackageId(packageId);
    try {
      if (mode === 'records') {
        const preview = await host.invoke<PackageRecordDeletionPreview>('packages.delete-record-preview', { packageIds: [packageId] });
        setPendingDeletion({ packageIds: [packageId], mode, preview, trigger });
      } else {
        const preview = await host.invoke<PackageDeletionPreview>('packages.delete-preview', { packageIds: [packageId] });
        setPendingDeletion({ packageIds: [packageId], mode, preview, trigger });
      }
    } catch (error) {
      setDeletingPackageId(undefined);
      throw error;
    }
  };
  const togglePackageSelection = (packageId: string, checked: boolean) => {
    setSelectedPackageIds((current) => checked
      ? current.includes(packageId) ? current : [...current, packageId]
      : current.filter((id) => id !== packageId));
  };
  const toggleAllSelection = () => setSelectedPackageIds(getNextRecentPackageSelection(items, selectedIds));
  const requestBatchDeletion = async () => {
    if (selectedIds.length === 0 || deletionBusy) return;
    const packageIds = [...selectedIds];
    setBatchPreviewLoading(true);
    try {
      const preview = await host.invoke<PackageDeletionPreview>('packages.delete-preview', { packageIds });
      setPendingDeletion({ packageIds, mode: 'lifecycle', preview, trigger: batchDeleteTriggerRef.current });
    } catch (error) {
      onError(error);
    } finally {
      setBatchPreviewLoading(false);
    }
  };
  const cancelDeletion = useCallback(() => {
    if (deletionSubmittingRef.current) return;
    setPendingDeletion(undefined);
    setDeletingPackageId(undefined);
  }, []);
  const confirmDeletion = async () => {
    if (!pendingDeletion || deletionSubmitting) return;
    setDeletionSubmitting(true);
    try {
      if (pendingDeletion.mode === 'records') {
        await host.invoke('packages.delete-record', { packageIds: pendingDeletion.packageIds, confirmationToken: pendingDeletion.preview.confirmationToken });
      } else {
        await host.invoke('packages.delete', { packageIds: pendingDeletion.packageIds, confirmationToken: pendingDeletion.preview.confirmationToken });
      }
      setSelectedPackageIds((current) => current.filter((id) => !pendingDeletion.packageIds.includes(id)));
      setPendingDeletion(undefined);
      setDeletingPackageId(undefined);
      await onChanged();
    } catch (error) {
      setPendingDeletion(undefined);
      setDeletingPackageId(undefined);
      onError(error);
    } finally {
      setDeletionSubmitting(false);
    }
  };
  return <section className="workspace-section workspace-list"><header className="workspace-section-heading"><h2>{title} <span>{items.length}</span></h2>{enableBatchDeletion && <div className="workspace-batch-actions"><label className="batch-select-all"><input type="checkbox" checked={allSelectableSelected} disabled={selectablePackageIds.length === 0 || deletionBusy} aria-label="全选最近分析" onChange={toggleAllSelection} /><span>全选</span></label><button ref={batchDeleteTriggerRef} type="button" className="danger-action batch-delete-action" disabled={selectedIds.length === 0 || deletionBusy} onClick={() => void requestBatchDeletion()}>{batchPreviewLoading ? <LoaderCircle className="is-spinning" size={15} aria-hidden="true" /> : <Trash2 size={15} aria-hidden="true" />}<span>{batchPreviewLoading ? '准备中' : `批量删除${selectedIds.length > 0 ? `（${selectedIds.length}）` : ''}`}</span></button></div>}</header>{items.length === 0 ? <div className="workspace-empty"><span>{emptyText}</span></div> : items.map((item) => {
    const analysisResult = resultByPackageId?.get(item.id);
    const isRecent = item.status === 'report-ready' || item.status === 'failed';
    const presentation = getRecentAnalysisPresentation({ status: item.status, displayName: item.displayName, result: analysisResult, failureMessage: failureByPackageId?.get(item.id) });
    const runtimePresentation = getAnalysisRuntimePresentation(runtimeTimingsByPackageId?.get(item.id));
    const active = item.status === 'running' || item.status === 'queued';
    const deleting = deletingPackageId === item.id;
    return <article ref={highlightedPackageId === item.id ? highlightedRef : undefined} tabIndex={highlightedPackageId === item.id ? -1 : undefined} className={`workspace-list-item${highlightedPackageId === item.id ? ' is-highlighted' : ''}`} key={item.id} onContextMenu={(event) => { event.preventDefault(); setOpenMenuPackageId(item.id); }}><div className="workspace-status-cell">{enableBatchDeletion && isRecent && <input className="package-selection" type="checkbox" checked={selectedIds.includes(item.id)} disabled={deletionBusy} aria-label={`选择删除${item.displayName}`} onChange={(event) => togglePackageSelection(item.id, event.target.checked)} />}<PackageStatusIcon tone={getPackageTone(item.status, presentation.severity)} /></div><div className="workspace-item-copy"><strong className={isRecent ? `recent-title severity-${presentation.severity}` : undefined} title={presentation.title}>{presentation.title}</strong><span title={presentation.detail}>{isRecent ? presentation.detail : item.sourcePath}</span>{isRecent && runtimePresentation && <span className="analysis-runtime-detail" title={runtimePresentation.detail}>{runtimePresentation.detail}</span>}</div>{!isRecent && <span className="package-size">{formatFileSize(item.sourceSizeBytes)}</span>}<span className="package-time"><Clock3 size={13} aria-hidden="true" />{isRecent ? runtimePresentation?.total ?? '暂无用时记录' : formatDetectedAt(item.detectedAt)}</span><div className="card-actions">{action(item)}<button ref={openMenuPackageId === item.id ? triggerRef : undefined} className="overflow-trigger" type="button" disabled={deletionBusy} aria-label={`打开${item.displayName}的更多操作`} aria-haspopup="menu" aria-expanded={openMenuPackageId === item.id} onClick={() => setOpenMenuPackageId((current) => current === item.id ? undefined : item.id)}><MoreHorizontal size={18} aria-hidden="true" /></button>{openMenuPackageId === item.id && <div ref={menuRef} className="overflow-menu" role="menu"><button type="button" role="menuitem" onClick={() => void locate(item.id, 'packages.locate-source')}><FolderOpen size={15} aria-hidden="true" />定位诊断包</button><button type="button" role="menuitem" onClick={() => void locate(item.id, 'packages.locate-extract')}><FolderOpen size={15} aria-hidden="true" />定位解压目录</button>{onAnalyze && (item.status === 'report-ready' || item.status === 'failed') && <button type="button" role="menuitem" onClick={() => void onAnalyze(item.id)}><Play size={15} aria-hidden="true" />重新分析</button>}<button type="button" role="menuitem" disabled={active || deletionBusy} onClick={() => void remove(item.id, 'records').catch(onError)}>仅删除记录</button><button className="danger" type="button" role="menuitem" disabled={active || deletionBusy} onClick={() => void remove(item.id, 'lifecycle').catch(onError)}>删除诊断包</button></div>}</div></article>;
  })}{pendingDeletion && <PackageDeletionDialog pending={pendingDeletion} submitting={deletionSubmitting} onCancel={cancelDeletion} onConfirm={() => void confirmDeletion()} />}</section>;
}

/** 删除前先展示后端预览结果，所有确认和取消路径都留在应用内，避免触发 iframe 原生模态框限制。 */
function PackageDeletionDialog({ pending, submitting, onCancel, onConfirm }: { pending: PendingPackageDeletion; submitting: boolean; onCancel: () => void; onConfirm: () => void }) {
  const dialogRef = useRef<HTMLElement>(null);
  const title = pending.mode === 'records' ? '确认删除记录' : '确认删除诊断包';
  const message = pending.mode === 'records' ? getPackageRecordDeletionConfirmation(pending.preview) : getPackageDeletionConfirmation(pending.preview);
  useEffect(() => {
    if (!dialogRef.current) return;
    return startDialogLifecycle({ document, scope: dialogRef.current, trigger: pending.trigger ?? { focus: () => undefined }, requestClose: onCancel });
  }, [onCancel, pending.trigger]);
  return <div className="package-deletion-backdrop" role="presentation" onMouseDown={onCancel}><section ref={dialogRef} className="package-deletion-dialog" role="dialog" aria-modal="true" aria-labelledby="package-deletion-title" aria-describedby="package-deletion-message" onMouseDown={(event) => event.stopPropagation()}><header><h2 id="package-deletion-title">{title}</h2></header><p id="package-deletion-message" className="package-deletion-message">{message}</p><footer className="dialog-actions"><button type="button" disabled={submitting} onClick={onCancel}>取消</button><button type="button" className="danger-action" disabled={submitting} onClick={onConfirm}>{submitting ? '删除中…' : '确认删除'}</button></footer></section></div>;
}

function RunningTasks({ tasks, packages, now }: { tasks: TaskItem[]; packages: PackageItem[]; now: number }) { return <section className="workspace-section workspace-list"><header className="workspace-section-heading"><h2>正在分析 <span>{tasks.length}</span></h2></header>{tasks.length === 0 ? <div className="workspace-empty"><span>当前没有运行中的分析任务</span></div> : tasks.map((task) => { const queued = task.status === 'queued'; const elapsed = formatElapsed(queued ? task.createdAt : task.startedAt, now); const detail = queued ? `排队中，前方还有 ${getQueuePosition(task.id, tasks)} 个任务 · ${elapsed.replace('已用时', '已等待')}` : `${task.message} · ${elapsed}`; return <article className="running-task" key={task.id}><div className="running-summary"><LoaderCircle className={queued ? '' : 'is-spinning'} size={20} aria-hidden="true" /><div><strong>{packages.find((item) => item.id === task.packageId)?.displayName ?? '诊断包'}</strong><span>{detail}</span></div><div className="task-progress"><progress value={task.progress} max={100}>{task.progress}%</progress><strong>{task.progress}%</strong></div></div><ol className="stage-progress" aria-label="分析阶段">{getAnalysisStageItems(task.stage).map((stage) => <li className={`state-${stage.state}`} key={stage.id}><span aria-hidden="true">{stage.state === 'complete' ? '✓' : ''}</span>{stage.label}</li>)}</ol></article>; })}</section>; }

function PackageStatusIcon({ tone }: { tone: ReturnType<typeof getPackageTone> }) { if (tone === 'danger') return <CircleAlert className="package-status-icon is-danger" size={19} aria-label="严重诊断或分析失败" />; if (tone === 'warning') return <CircleAlert className="package-status-icon is-warning" size={19} aria-label="警告诊断" />; if (tone === 'success') return <CircleCheck className="package-status-icon is-success" size={19} aria-label="分析完成" />; return <FilePlus2 className="package-status-icon" size={19} aria-hidden="true" />; }

function ResultMoreMenu({ packageId }: { packageId: string }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const closeFromOutside = (event: PointerEvent) => { if (open && isOutsideOverflowMenu(event.target, menuRef.current, triggerRef.current)) setOpen(false); };
    const closeFromEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); triggerRef.current?.focus(); } };
    document.addEventListener('pointerdown', closeFromOutside);
    document.addEventListener('keydown', closeFromEscape);
    return () => { document.removeEventListener('pointerdown', closeFromOutside); document.removeEventListener('keydown', closeFromEscape); };
  }, [open]);
  const locate = async (method: 'packages.locate-source' | 'packages.locate-extract') => { const path = await host.invoke<string>(method, { packageId }); await host.invoke('host.showItemInFolder', { path }); setOpen(false); };
  return <div className="result-more"><button ref={triggerRef} type="button" className="icon-button" title="更多操作" aria-label="打开结果更多操作" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}><MoreHorizontal size={18} aria-hidden="true" /></button>{open && <div ref={menuRef} className="overflow-menu" role="menu"><button type="button" role="menuitem" onClick={() => void locate('packages.locate-source')}><FolderOpen size={15} aria-hidden="true" />定位原始诊断包</button><button type="button" role="menuitem" onClick={() => void locate('packages.locate-extract')}><FolderOpen size={15} aria-hidden="true" />定位解压目录</button></div>}</div>;
}

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

function SettingsDialog({ draft, error, status, trigger, onClose, onChoose, onChange, onSave }: { draft: MonitorSettings; error: string; status: { state: string; warning?: string }; trigger: HTMLButtonElement | null; onClose: () => void; onChoose: () => void; onChange: (value: MonitorSettings) => void; onSave: () => void }) {
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!dialogRef.current) return;
    return startDialogLifecycle({ document, scope: dialogRef.current, trigger: trigger ?? { focus: () => undefined }, requestClose: onClose });
  }, [onClose, trigger]);
  return <div className="analysis-settings-backdrop" role="presentation" onMouseDown={onClose}><section ref={dialogRef} className="analysis-settings-popover" role="dialog" aria-modal="true" aria-label="分析中心设置" onMouseDown={(event) => event.stopPropagation()}><header className="settings-heading"><h2>分析中心设置</h2><button className="icon-button" aria-label="关闭设置" onClick={onClose}><X size={16} aria-hidden="true" /></button></header><section className="settings-group"><h3>监控目录</h3><label className="switch-field"><span><strong>启用目录监控</strong><small>按固定间隔检查目录中的新文件</small></span><input type="checkbox" checked={draft.enabled} onChange={(event) => onChange({ ...draft, enabled: event.target.checked })} /></label><label className="switch-field"><span><strong>发现后自动分析</strong><small>仅处理启用监控后新增且稳定的诊断包</small></span><input type="checkbox" checked={draft.autoAnalyzeEnabled} onChange={(event) => onChange({ ...draft, autoAnalyzeEnabled: event.target.checked })} /></label><div className="settings-field"><span>监控目录</span><div className="directory-item"><code title={draft.directory}>{draft.directory ?? '尚未选择目录'}</code><button onClick={onChoose}>选择</button></div></div><label className="settings-field"><span>扫描间隔</span><select value={draft.scanIntervalSeconds} onChange={(event) => onChange({ ...draft, scanIntervalSeconds: Number(event.currentTarget.value) })}><option value={10}>10 秒</option><option value={20}>20 秒</option><option value={30}>30 秒</option><option value={40}>40 秒</option><option value={50}>50 秒</option><option value={60}>60 秒</option></select></label><p className="settings-note">启用或重新选择目录时，已有诊断包只建立基线，不会自动导入。需要处理存量时，请在首页点击“扫描存量”；扫描结果只进入待分析。</p></section><section className="settings-group settings-formats"><h3>支持格式</h3><div><span>.tgz</span><span>.tgz.temp</span><span>.zip</span></div><p>ZIP 文件名需以 nas_server_log 开头。</p></section><section className="settings-status"><span className={`monitor-indicator state-${status.state}`} aria-hidden="true" /><strong>当前状态：{status.state === 'watching' ? '正在监控' : status.state === 'paused' ? '已暂停' : '已关闭'}</strong></section>{status.state === 'paused' && <p className="message" role="alert">监控已暂停：{status.warning}</p>}{error && <p className="message" role="alert">{error}</p>}<footer className="dialog-actions"><button onClick={onClose}>取消</button><button className="primary-action" onClick={onSave}>保存</button></footer></section></div>;
}

function formatDetectedAt(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(date); }
