import { Archive, FolderOpen, MoreHorizontal } from 'lucide-react';
import { useCallback, useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { AppHostClient } from './host-api';

interface PackageItem { id: string; displayName: string; sourcePath: string; status: string; reportPath?: string; taskIds: string[]; }
interface TaskItem { id: string; packageId: string; status: string; progress: number; message: string; errorMessage?: string; }
interface DeletePreview { packageCount: number; taskCount: number; estimatedBytes: number; confirmationToken: string; packageIds: string[]; }

const host = new AppHostClient('analysis-center');

/** 分析中心独立 renderer，所有本地操作均通过版本化 App Host API 调用 backend Worker。 */
export function AnalysisCenterApp() {
  const [packages, setPackages] = useState<PackageItem[]>([]);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [openMenuPackageId, setOpenMenuPackageId] = useState<string | null>(null);
  const [directories, setDirectories] = useState<string[]>([]);
  const [scanIntervalMinutes, setScanIntervalMinutes] = useState(5);

  const load = useCallback(async () => {
    try {
      const [nextPackages, nextTasks, settings] = await Promise.all([
        host.invoke<PackageItem[]>('packages.list'),
        host.invoke<TaskItem[]>('tasks.list'),
        host.invoke<{ directories: string[]; scanIntervalMinutes: number }>('settings.get')
      ]);
      setPackages(nextPackages); setTasks(nextTasks); setDirectories(settings.directories); setScanIntervalMinutes(settings.scanIntervalMinutes);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  }, []);

  useEffect(() => { void load(); return host.onEvent(() => { void load(); }); }, [load]);
  useEffect(() => {
    const closeMenu = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpenMenuPackageId(null); };
    document.addEventListener('keydown', closeMenu);
    return () => document.removeEventListener('keydown', closeMenu);
  }, []);

  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true); setMessage('');
    try { await action(); setMessage(success); await load(); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); }
  };

  const importPackages = () => void run(async () => {
    const paths = await host.invoke<string[]>('host.chooseFiles');
    for (const sourcePath of paths) await host.invoke('packages.import', { sourcePath });
  }, '诊断包已导入。');

  const scan = () => void run(() => host.invoke('packages.scan'), '监控目录扫描完成。');
  const analyze = (packageId: string, scope: 'comprehensive' | 'storage' = 'comprehensive') => void run(() => host.invoke('analysis.start', { packageId, scope }), '分析任务已创建。');
  const analyzeAll = () => void run(() => host.invoke('analysis.start-all-pending'), '已创建批量分析任务。');
  const openReport = (packageId: string) => void run(async () => {
    const path = await host.invoke<string | null>('reports.path', { packageId });
    if (!path) throw new Error('该诊断包尚未生成报告。');
    await host.invoke('host.openPath', { path });
  }, '已打开报告。');
  const deletePackage = async (packageId: string) => {
    setOpenMenuPackageId(null);
    const preview = await host.invoke<DeletePreview>('packages.delete-preview', { packageIds: [packageId] });
    if (!window.confirm(`将永久删除 ${preview.packageCount} 个诊断包及其分析记录，是否继续？`)) return;
    await run(() => host.invoke('packages.delete', { packageIds: [packageId], confirmationToken: preview.confirmationToken }), '诊断包已永久删除。');
  };
  /** 行内只保留高频分析动作，定位和删除等低频操作统一收纳到可见的更多菜单中。 */
  const locatePackage = (packageId: string, method: 'packages.locate-source' | 'packages.locate-extract', success: string) => {
    setOpenMenuPackageId(null);
    void run(async () => {
    const path = await host.invoke<string>(method, { packageId });
    await host.invoke('host.showItemInFolder', { path });
    }, success);
  };
  const togglePackageMenu = (event: ReactMouseEvent, packageId: string) => {
    event.stopPropagation();
    setOpenMenuPackageId((current) => current === packageId ? null : packageId);
  };
  const openPackageMenuFromContext = (event: ReactMouseEvent, packageId: string) => {
    event.preventDefault();
    setOpenMenuPackageId(packageId);
  };
  const saveSettings = () => void run(() => host.invoke('settings.save', { directories, scanIntervalMinutes }), '分析中心设置已保存。');

  return <main className="analysis-app" onClick={() => setOpenMenuPackageId(null)}><header><div><span>ANALYSIS CENTER</span><h1>分析中心</h1><p>独立数据目录 · 独立版本 · 工作台内嵌运行</p></div><div className="actions"><button disabled={busy} onClick={importPackages}>导入</button><button disabled={busy} onClick={scan}>扫描</button><button disabled={busy} onClick={analyzeAll}>综合分析</button></div></header>
    {message && <div className="message" role="status">{message}</div>}
    <section className="summary"><div><strong>{packages.length}</strong><span>诊断包</span></div><div><strong>{tasks.filter((task) => task.status === 'running' || task.status === 'queued').length}</strong><span>进行中任务</span></div><div><strong>{packages.filter((item) => item.status === 'report-ready').length}</strong><span>可查看报告</span></div></section>
    <section className="content"><div className="package-list"><div className="section-title"><h2>诊断包</h2><small>{packages.length} 个</small></div>{packages.length === 0 ? <div className="empty">还没有诊断包，请导入或扫描监控目录。ZIP 文件名需包含 <code>nas_server_log</code>。</div> : packages.map((item) => <article className="package-card" key={item.id} onContextMenu={(event) => openPackageMenuFromContext(event, item.id)}><div><strong>{item.displayName}</strong><small>{item.status} · {item.sourcePath}</small></div><div className="card-actions">{item.status === 'report-ready' ? <button onClick={() => openReport(item.id)}>打开报告</button> : <><button disabled={busy || item.status === 'running' || item.status === 'queued'} onClick={() => analyze(item.id)}>综合分析</button><button disabled={busy || item.status === 'running' || item.status === 'queued'} onClick={() => analyze(item.id, 'storage')}>存储分析</button></>}<button className="overflow-trigger" type="button" aria-label={`打开${item.displayName}的更多操作`} aria-haspopup="menu" aria-expanded={openMenuPackageId === item.id} onClick={(event) => togglePackageMenu(event, item.id)}><MoreHorizontal size={17} aria-hidden="true" /></button></div>{openMenuPackageId === item.id && <div className="overflow-menu" role="menu" aria-label={`${item.displayName}更多操作`} onClick={(event) => event.stopPropagation()}><div className="overflow-menu-title" title={item.displayName}>{item.displayName}</div><button type="button" role="menuitem" onClick={() => locatePackage(item.id, 'packages.locate-source', '已定位诊断包。')}><FolderOpen size={15} aria-hidden="true" />定位诊断包</button><button type="button" role="menuitem" onClick={() => locatePackage(item.id, 'packages.locate-extract', '已定位解压目录。')}><Archive size={15} aria-hidden="true" />定位解压目录</button><div className="overflow-divider" /><button className="danger" type="button" role="menuitem" disabled={busy || item.status === 'running' || item.status === 'queued'} onClick={() => void deletePackage(item.id)}>删除诊断包</button></div>}</article>)}</div>
      <aside className="settings"><div className="section-title"><h2>设置</h2></div><label>监控目录<textarea value={directories.join('\n')} onChange={(event) => setDirectories(event.target.value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean))} /></label><label>自动扫描间隔（分钟）<input type="number" min={1} value={scanIntervalMinutes} onChange={(event) => setScanIntervalMinutes(Number(event.target.value))} /></label><button onClick={saveSettings} disabled={busy}>保存设置</button></aside></section>
    <section className="tasks"><div className="section-title"><h2>任务进度</h2><small>{tasks.length} 项</small></div>{tasks.map((task) => <div className="task" key={task.id}><span>{task.packageId}</span><strong>{task.message}</strong><progress value={task.progress} max={100} /><small>{task.status}</small></div>)}</section>
  </main>;
}
