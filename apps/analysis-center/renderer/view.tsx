import { Archive, FolderOpen, MoreHorizontal, RefreshCw, X } from 'lucide-react';
import { useCallback, useEffect, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { AppHostClient } from './host-api';

interface PackageItem { id: string; displayName: string; sourcePath: string; status: string; reportPath?: string; taskIds: string[]; }
interface RuleUpdateState { ruleSetId: string; currentVersion: string; source: 'bundled' | 'downloaded'; }
interface RuleUpdateResult { status: 'updated' | 'up-to-date'; previousVersion: string; currentVersion: string; }
interface DeletePreview { packageCount: number; taskCount: number; estimatedBytes: number; confirmationToken: string; packageIds: string[]; }

const host = new AppHostClient('analysis-center');

/**
 * 分析中心以单列表为核心：诊断包操作放在列表标题旁，设置仅在宿主标题栏请求时以浮层出现。
 * 应用仍只通过版本化 Host API 保存自身配置，不让工作台壳层读取或修改诊断数据。
 */
export function AnalysisCenterApp() {
  const [packages, setPackages] = useState<PackageItem[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [openMenuPackageId, setOpenMenuPackageId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [directories, setDirectories] = useState<string[]>([]);
  const [scanIntervalMinutes, setScanIntervalMinutes] = useState(5);
  const [ruleUpdateState, setRuleUpdateState] = useState<RuleUpdateState | null>(null);
  const [ruleUpdateMessage, setRuleUpdateMessage] = useState('');
  const [ruleUpdateBusy, setRuleUpdateBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [nextPackages, settings, nextRuleUpdateState] = await Promise.all([
        host.invoke<PackageItem[]>('packages.list'),
        host.invoke<{ directories: string[]; scanIntervalMinutes: number }>('settings.get'),
        host.invoke<RuleUpdateState>('rules.getUpdateState')
      ]);
      setPackages(nextPackages);
      setDirectories(settings.directories);
      setScanIntervalMinutes(settings.scanIntervalMinutes);
      setRuleUpdateState(nextRuleUpdateState);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => { void load(); return host.onEvent(() => { void load(); }); }, [load]);
  useEffect(() => host.onCommand((command) => { if (command === 'settings.open') setSettingsOpen(true); }), []);
  useEffect(() => {
    const closeTransientUi = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpenMenuPackageId(null);
      setSettingsOpen(false);
    };
    document.addEventListener('keydown', closeTransientUi);
    return () => document.removeEventListener('keydown', closeTransientUi);
  }, []);

  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setMessage('');
    try {
      await action();
      setMessage(success);
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const importPackages = () => void run(async () => {
    const paths = await host.invoke<string[]>('host.chooseFiles');
    for (const sourcePath of paths) await host.invoke('packages.import', { sourcePath });
  }, '诊断包已导入。');
  const scan = () => void run(() => host.invoke('packages.scan'), '监控目录扫描完成。');
  const analyze = (packageId: string, scope: 'comprehensive' | 'storage' = 'comprehensive') => void run(async () => {
    const rules = await host.invoke('rules.getActive');
    await host.invoke('analysis.start', { packageId, scope, rules });
  }, '分析任务已创建。');
  const analyzeAll = () => void run(async () => {
    const rules = await host.invoke('rules.getActive');
    await host.invoke('analysis.start-all-pending', { rules });
  }, '已创建批量分析任务。');
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
  const locatePackage = (packageId: string, method: 'packages.locate-source' | 'packages.locate-extract', success: string) => {
    setOpenMenuPackageId(null);
    void run(async () => {
      const path = await host.invoke<string>(method, { packageId });
      await host.invoke('host.showItemInFolder', { path });
    }, success);
  };
  const chooseDirectories = async () => {
    setBusy(true);
    setMessage('');
    try {
      const selected = await host.invoke<string[]>('host.chooseDirectory');
      if (!selected.length) return;
      setDirectories((current) => [...new Set([...current, ...selected])]);
      setMessage(`已添加 ${selected.length} 个监控目录，请保存设置。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  const saveSettings = () => void run(() => host.invoke('settings.save', { directories, scanIntervalMinutes }), '分析中心设置已保存。');
  const updateRules = async () => {
    setRuleUpdateBusy(true);
    setRuleUpdateMessage('正在检查规则更新...');
    try {
      const result = await host.invoke<RuleUpdateResult>('rules.updateOfficial');
      setRuleUpdateState(await host.invoke<RuleUpdateState>('rules.getUpdateState'));
      setRuleUpdateMessage(result.status === 'updated' ? `规则已更新到 ${result.currentVersion}。` : `当前已是最新规则 ${result.currentVersion}。`);
    } catch (error) {
      setRuleUpdateMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setRuleUpdateBusy(false);
    }
  };

  return <main className="analysis-app" onClick={() => { setOpenMenuPackageId(null); setSettingsOpen(false); }}>
    {message && <div className="message" role="status">{message}</div>}
    <section className="analysis-list">
      <header className="analysis-list-heading"><h1>诊断包</h1><div className="analysis-list-actions"><button type="button" disabled={busy} onClick={importPackages}>导入</button><button type="button" disabled={busy} onClick={scan}>扫描</button><button type="button" disabled={busy} onClick={analyzeAll}>综合分析</button></div></header>
      {packages.length === 0 ? <div className="empty"><strong>还没有诊断包</strong><span>请导入或扫描监控目录。ZIP 文件名需包含 <code>nas_server_log</code>。</span><div><button type="button" disabled={busy} onClick={importPackages}>导入诊断包</button><button type="button" disabled={busy} onClick={scan}>扫描目录</button></div></div> : <div className="package-list">{packages.map((item) => <article className="package-card" key={item.id} onContextMenu={(event) => { event.preventDefault(); setOpenMenuPackageId(item.id); }}><div><strong>{item.displayName}</strong><small>{item.status} · {item.sourcePath}</small></div><div className="card-actions">{item.status === 'report-ready' ? <button type="button" onClick={() => openReport(item.id)}>打开报告</button> : <><button type="button" disabled={busy || item.status === 'running' || item.status === 'queued'} onClick={() => analyze(item.id)}>综合分析</button><button type="button" disabled={busy || item.status === 'running' || item.status === 'queued'} onClick={() => analyze(item.id, 'storage')}>存储分析</button></>}<button className="overflow-trigger" type="button" aria-label={`打开${item.displayName}的更多操作`} aria-haspopup="menu" aria-expanded={openMenuPackageId === item.id} onClick={(event: ReactMouseEvent) => { event.stopPropagation(); setOpenMenuPackageId((current) => current === item.id ? null : item.id); }}><MoreHorizontal size={17} aria-hidden="true" /></button></div>{openMenuPackageId === item.id && <div className="overflow-menu" role="menu" aria-label={`${item.displayName}更多操作`} onClick={(event) => event.stopPropagation()}><div className="overflow-menu-title" title={item.displayName}>{item.displayName}</div><button type="button" role="menuitem" onClick={() => locatePackage(item.id, 'packages.locate-source', '已定位诊断包。')}><FolderOpen size={15} aria-hidden="true" />定位诊断包</button><button type="button" role="menuitem" onClick={() => locatePackage(item.id, 'packages.locate-extract', '已定位解压目录。')}><Archive size={15} aria-hidden="true" />定位解压目录</button><div className="overflow-divider" /><button className="danger" type="button" role="menuitem" disabled={busy || item.status === 'running' || item.status === 'queued'} onClick={() => void deletePackage(item.id)}>删除诊断包</button></div>}</article>)}</div>}
    </section>
    {settingsOpen && <aside className="analysis-settings-popover" role="dialog" aria-modal="false" aria-label="分析中心设置" onClick={(event) => event.stopPropagation()}><div className="settings-heading"><h2>分析中心设置</h2><button className="settings-close" type="button" aria-label="关闭分析中心设置" onClick={() => setSettingsOpen(false)}><X size={16} /></button></div><section><h3>监控目录</h3><button type="button" disabled={busy} onClick={() => void chooseDirectories()}>选择监控目录</button>{directories.length === 0 ? <p>尚未选择监控目录。</p> : <ul className="directory-list">{directories.map((directory) => <li key={directory}><code title={directory}>{directory}</code><button type="button" aria-label={`移除监控目录 ${directory}`} onClick={() => setDirectories((current) => current.filter((item) => item !== directory))}><X size={15} aria-hidden="true" />移除监控目录</button></li>)}</ul>}</section><label className="scan-interval-label">自动扫描间隔（分钟）<input type="number" min={1} value={scanIntervalMinutes} onChange={(event) => setScanIntervalMinutes(Number(event.target.value))} /></label><button type="button" className="save-settings" disabled={busy} onClick={saveSettings}>保存设置</button><div className="rule-update"><div><span>规则版本</span><strong title={ruleUpdateState?.ruleSetId}>{ruleUpdateState?.currentVersion ?? '读取中'}</strong></div><button type="button" onClick={() => void updateRules()} disabled={ruleUpdateBusy} aria-busy={ruleUpdateBusy}><RefreshCw className={ruleUpdateBusy ? 'is-spinning' : undefined} size={15} aria-hidden="true" />{ruleUpdateBusy ? '正在检查' : '检查更新'}</button>{ruleUpdateMessage && <small role="status">{ruleUpdateMessage}</small>}</div></aside>}
  </main>;
}
