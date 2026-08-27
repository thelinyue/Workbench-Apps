import { ChevronLeft, Copy, ExternalLink, FilePlus2, FolderCog, FolderOpen, MoreHorizontal, Play, Save, ShieldAlert } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppHostClient } from './host-api';

interface PackageItem { id: string; displayName: string; sourcePath: string; status: 'pending' | 'queued' | 'running' | 'report-ready' | 'failed' | 'cancelled'; reportPath?: string; }
interface TaskItem { id: string; packageId: string; status: string; progress: number; message: string; errorMessage?: string; }
interface MonitorSettings { directory?: string; enabled: boolean; }
interface Finding { id: string; title: string; summary: string; severity: string; evidenceIds: string[]; }
interface Evidence { id: string; sourceFile: string; lineNumber?: number; rawMessage: string; }
interface DeviceAssessment { resource: string; label?: string; model?: string; serial?: string; slot?: string; usedFor?: string; smartRiskAttributes: Array<{ id: number; name: string; raw: number }>; ioErrorCount: number; }
interface Diagnosis { id: string; title: string; summary: string; severity: string; confidence: string; affectedResources: string[]; affectedDeviceResources?: string[]; findingIds: string[]; userConclusion?: string; engineerConclusion?: string; }
interface Result { diagnoses: Diagnosis[]; findings: Finding[]; evidence: Evidence[]; deviceAssessments?: DeviceAssessment[]; recommendations: Array<{ id: string; priority: number; title: string; reason: string; risk: string }>; metadata: { source: string; missingData: string[] }; }
interface EvidenceContext { available: boolean; lines: string[]; message?: string; }

const host = new AppHostClient('analysis-center');

/** V1 第一屏展示工程结论，原始证据仅在工程师需要追溯时展开。 */
export function AnalysisCenterApp() {
  const [packages, setPackages] = useState<PackageItem[]>([]);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [monitor, setMonitor] = useState<MonitorSettings>({ enabled: false });
  const [resultPackageId, setResultPackageId] = useState<string>();
  const [result, setResult] = useState<Result>();
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const [message, setMessage] = useState('');
  const openedTaskIds = useRef(new Set<string>());
  const showError = (error: unknown) => setMessage(error instanceof Error ? error.message : String(error));

  const load = useCallback(async () => {
    const [nextPackages, nextTasks, nextMonitor] = await Promise.all([
      host.invoke<PackageItem[]>('packages.list'), host.invoke<TaskItem[]>('tasks.list'), host.invoke<MonitorSettings>('settings.get')
    ]);
    setPackages(nextPackages); setTasks(nextTasks); setMonitor(nextMonitor);
    const completedTask = nextTasks.find((task) => task.status === 'succeeded' && !openedTaskIds.current.has(task.id));
    if (completedTask) {
      openedTaskIds.current.add(completedTask.id);
      const completedResult = await host.invoke<Result | null>('results.get', { packageId: completedTask.packageId });
      if (completedResult) { setResult(completedResult); setResultPackageId(completedTask.packageId); setEvidenceOpen(false); }
    }
  }, []);
  useEffect(() => { void load().catch(showError); return host.onEvent(() => { void load().catch(showError); }); }, [load]);

  const failureByPackageId = useMemo(() => new Map(tasks.filter((task) => task.status === 'failed').map((task) => [task.packageId, task.errorMessage ?? task.message])), [tasks]);
  const openResult = async (packageId: string) => { const value = await host.invoke<Result | null>('results.get', { packageId }); if (value) { setResult(value); setResultPackageId(packageId); setEvidenceOpen(false); } };
  const importPackages = async () => { try { for (const path of await host.invoke<string[]>('host.chooseFiles')) await host.invoke('packages.import', { sourcePath: path }); await load(); } catch (error) { showError(error); } };
  const analyze = async (packageId: string) => { try { await host.invoke('analysis.start', { packageId }); await load(); } catch (error) { showError(error); } };
  const selectMonitorDirectory = async () => { try { const [directory] = await host.invoke<string[]>('host.chooseDirectory'); if (!directory) return; await host.invoke('settings.save', { directory, enabled: true }); await load(); } catch (error) { showError(error); } };
  const setMonitorEnabled = async (enabled: boolean) => { try { await host.invoke('settings.save', { directory: monitor.directory, enabled }); await load(); } catch (error) { showError(error); } };
  const openBrowser = async () => { const item = packages.find((value) => value.id === resultPackageId); if (item?.reportPath) await host.invoke('host.openPath', { path: item.reportPath }); };
  const saveHtml = async () => { try { const item = packages.find((value) => value.id === resultPackageId); if (!item) return; const content = await host.invoke<string>('results.html', { packageId: item.id }); await host.invoke('host.saveFile', { fileName: `${item.displayName}.html`, content, kind: 'html' }); } catch (error) { showError(error); } };

  if (result && resultPackageId) return <main className="analysis-v1 result-view"><header className="result-toolbar"><button className="icon-button" title="返回分析工作区" aria-label="返回分析工作区" onClick={() => { setResult(undefined); setResultPackageId(undefined); }}><ChevronLeft size={18} /></button><span>{result.metadata.source}</span><div><button onClick={() => void openBrowser()}><ExternalLink size={15} />在浏览器打开</button><button title="另存为 HTML" aria-label="另存为 HTML" onClick={() => void saveHtml()}><Save size={15} /></button></div></header><div className="result-grid"><section className="result-main"><DiagnosisView result={result} onEvidence={() => setEvidenceOpen(true)} /></section>{evidenceOpen && <EvidenceDrawer packageId={resultPackageId} result={result} onClose={() => setEvidenceOpen(false)} />}</div></main>;

  const pending = packages.filter((item) => item.status === 'pending');
  const running = tasks.filter((item) => item.status === 'running' || item.status === 'queued');
  const recent = packages.filter((item) => item.status === 'report-ready').slice(0, 20);
  const failed = packages.filter((item) => item.status === 'failed');
  return <main className="analysis-v1">{message && <div className="message" role="alert">{message}</div>}<section className="quick-analysis"><div><h1>分析中心</h1><p>系统异常与存储故障诊断</p></div><button onClick={() => void importPackages()}><FilePlus2 size={16} />选择诊断包</button></section><section className="workspace-section monitor"><div><h2>监控目录</h2><p>{monitor.directory ?? '未选择目录'}{monitor.enabled ? '，正在监控稳定的诊断包。' : '，监控已停用。'}</p></div><div className="monitor-actions"><button title="更换目录" aria-label="更换目录" onClick={() => void selectMonitorDirectory()}><FolderCog size={16} /></button><label><input type="checkbox" checked={monitor.enabled} disabled={!monitor.directory} onChange={(event) => void setMonitorEnabled(event.target.checked)} />启用监控</label></div></section><WorkspaceList title={`待分析 ${pending.length}`} items={pending} onChanged={load} action={(item) => <button onClick={() => void analyze(item.id)}><Play size={15} />分析</button>} /><section className="workspace-section"><h2>正在分析</h2>{running.length ? running.map((task) => <div className="task-row" key={task.packageId}><strong>{packages.find((item) => item.id === task.packageId)?.displayName ?? '诊断包'}</strong><span>{task.message}</span><progress value={task.progress} max={100}>{task.progress}%</progress></div>) : <p className="muted">暂无正在运行的分析。</p>}</section>{failed.length > 0 && <WorkspaceList title="分析失败" items={failed} onChanged={load} failureByPackageId={failureByPackageId} action={() => null} />}<WorkspaceList title="最近分析" items={recent} onChanged={load} action={(item) => <button onClick={() => void openResult(item.id).catch(showError)}>查看结论</button>} /></main>;
}

function WorkspaceList({ title, items, action, onChanged, failureByPackageId }: { title: string; items: PackageItem[]; action: (item: PackageItem) => React.ReactNode; onChanged: () => Promise<void>; failureByPackageId?: Map<string, string> }) {
  const [openMenuPackageId, setOpenMenuPackageId] = useState<string>();
  const locate = async (packageId: string, method: 'packages.locate-source' | 'packages.locate-extract') => { const path = await host.invoke<string>(method, { packageId }); await host.invoke('host.showItemInFolder', { path }); };
  const remove = async (packageId: string) => { const preview = await host.invoke<{ packageCount: number; confirmationToken: string }>('packages.delete-preview', { packageIds: [packageId] }); if (!window.confirm(`将永久删除 ${preview.packageCount} 个诊断包及其分析记录，是否继续？`)) return; await host.invoke('packages.delete', { packageIds: [packageId], confirmationToken: preview.confirmationToken }); await onChanged(); };
  return <section className="workspace-section"><h2>{title}</h2>{items.length ? items.map((item) => <div className="input-row" key={item.id} onContextMenu={() => setOpenMenuPackageId(item.id)}><div><strong>{item.displayName}</strong><span>{item.status === 'failed' ? failureByPackageId?.get(item.id) ?? '分析失败，请查看失败原因。' : item.sourcePath}</span></div><div className="card-actions">{action(item)}<button className="overflow-trigger" type="button" aria-label={`打开${item.displayName}的更多操作`} aria-haspopup="menu" aria-expanded={openMenuPackageId === item.id} onClick={() => setOpenMenuPackageId((current) => current === item.id ? undefined : item.id)}><MoreHorizontal size={17} /></button>{openMenuPackageId === item.id && <div className="overflow-menu" role="menu"><button type="button" role="menuitem" onClick={() => void locate(item.id, 'packages.locate-source')}><FolderOpen size={15} />定位诊断包</button><button type="button" role="menuitem" onClick={() => void locate(item.id, 'packages.locate-extract')}><FolderOpen size={15} />定位解压目录</button><button className="danger" type="button" role="menuitem" disabled={item.status === 'running' || item.status === 'queued'} onClick={() => void remove(item.id)}>删除诊断包</button></div>}</div></div>) : <p className="muted">暂无项目。</p>}</section>;
}

function DiagnosisView({ result, onEvidence }: { result: Result; onEvidence: () => void }) {
  const primary = result.diagnoses[0];
  const deviceAssessments = result.deviceAssessments ?? [];
  const abnormalDevices = deviceAssessments.filter((device) => device.smartRiskAttributes.length || device.ioErrorCount > 0);
  const copyConclusion = () => { if (primary?.userConclusion) void navigator.clipboard?.writeText(primary.userConclusion); };

  return <>
    {primary?.userConclusion && <section className="user-conclusion"><h2>给用户的结论</h2><p>{primary.userConclusion}</p><button onClick={copyConclusion}><Copy size={15} />复制结论</button></section>}
    {primary ? <section className={`primary-diagnosis severity-${primary.severity}`}><div className="severity-label">{primary.severity === 'critical' ? '严重' : '警告'}</div><h1>{primary.title}</h1><p>{primary.summary}</p><dl><dt>置信度</dt><dd>{primary.confidence}</dd><dt>影响范围</dt><dd>{primary.affectedResources.join('、') || '当前日志无法确认完整影响链路'}</dd></dl><button onClick={onEvidence}>为什么这样判断？</button></section> : <section className="no-issue"><ShieldAlert size={20} /><h1>未发现明确异常</h1><p>本次日志范围内没有发现当前规则已经覆盖的高风险系统或存储故障，不等同于设备绝对正常。</p></section>}
    {abnormalDevices.length > 0 && <section><h2>异常硬盘</h2><div className="device-assessments">{abnormalDevices.map((device) => <article key={device.resource}><strong>{localizeDeviceLabel(device.label, device.resource)}</strong><p>序列号：{device.serial ?? '日志未提供'}　用途：{localizeUsage(device.usedFor)}</p><small>型号：{device.model ?? '日志未提供'}　槽位：{device.slot ?? '日志未提供'}　设备名：{device.resource}</small></article>)}</div></section>}
    {primary?.engineerConclusion && <section><h2>给工程师的结论</h2><p className="engineer-conclusion">{primary.engineerConclusion}</p></section>}
    {primary && !result.deviceAssessments && <section className="partial"><h2>硬盘身份信息不可用</h2><p>该历史结果未保存硬盘身份与双结论信息，请重新分析诊断包以查看硬盘身份和双结论。</p></section>}
    <section><h2>建议处理</h2>{result.recommendations.length ? <ol className="recommendations">{result.recommendations.map((item) => <li key={item.id}><strong>{item.title}</strong><p>{item.reason}</p><small>{item.risk === 'safe' ? '安全检查' : '需要确认'}</small></li>)}</ol> : <p className="muted">当前没有需要立即执行的建议。</p>}</section>
    <section><h2>其他重要发现</h2>{result.findings.map((item) => <article className={`finding severity-${item.severity}`} key={item.id}><strong>{item.title}</strong><p>{item.summary}</p></article>)}</section>
    {result.metadata.missingData.length > 0 && <section className="partial"><h2>分析完成，但缺少部分数据</h2><p>缺少：{result.metadata.missingData.join('、')}。当前诊断置信度可能受到影响。</p></section>}
  </>;
}

function localizeDeviceLabel(label: string | undefined, resource: string): string { if (!label) return resource; const m2 = label.match(/^M\.2\s+Hard Drive\s+(\d+)$/i); if (m2) return `M.2 硬盘 ${m2[1]}`; const disk = label.match(/^Hard Drive\s+(\d+)$/i); return disk ? `硬盘 ${disk[1]}` : label; }
function localizeUsage(usage: string | undefined): string { return usage?.replace(/^Storage Pool\s+(\d+)$/i, '存储池 $1') ?? '日志未提供'; }

function EvidenceDrawer({ packageId, result, onClose }: { packageId: string; result: Result; onClose: () => void }) { const [contexts, setContexts] = useState<Record<string, EvidenceContext>>({}); const ids = new Set(result.diagnoses[0]?.findingIds.flatMap((id) => result.findings.find((item) => item.id === id)?.evidenceIds ?? []) ?? []); const evidence = result.evidence.filter((item) => ids.has(item.id)); useEffect(() => { void Promise.all(evidence.map(async (item) => [item.id, await host.invoke<EvidenceContext>('results.evidence-context', { packageId, evidenceId: item.id })] as const)).then((entries) => setContexts(Object.fromEntries(entries))).catch(() => setContexts({})); }, [packageId, result]); return <aside className="evidence-drawer"><header><h2>证据</h2><button className="icon-button" aria-label="关闭证据" onClick={onClose}>×</button></header>{evidence.map((item) => <article key={item.id}><strong>{item.sourceFile}{item.lineNumber ? `:${item.lineNumber}` : ''}</strong><code>{contexts[item.id]?.available ? contexts[item.id].lines.join('\n') : contexts[item.id]?.message ?? item.rawMessage}</code></article>)}</aside>; }
