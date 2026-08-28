import { ArrowUp, Download, File, Folder, FolderOpen, RefreshCw, Upload, X } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { RemoteFileEntry, SessionSummary } from '../shared/types';
import type { AppHostClient } from './host-api';

interface FilePanelProps {
  host: AppHostClient;
  session?: SessionSummary;
  open: boolean;
  headerActions?: ReactNode;
  onClose(): void;
}

/** 右侧文件面板始终绑定活动 Session，导航只调用 SFTP，不会反向修改 shell cwd。 */
export function FilePanel({ host, session, open, headerActions, onClose }: FilePanelProps) {
  const [path, setPath] = useState('');
  const [pathInput, setPathInput] = useState('');
  const [entries, setEntries] = useState<RemoteFileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [overwrite, setOverwrite] = useState<{ paths: string[]; remoteDirectory: string }>();
  const connected = session?.state === 'connected';
  const passiveFollowEnabled = Boolean(session && session.profile.shellIntegration !== false);

  const load = async (requestedPath?: string) => {
    if (!session || !connected) return;
    setLoading(true);
    setError('');
    try {
      const result = await host.invoke<{ path: string; entries: RemoteFileEntry[] }>('sftp.list', { id: session.id, ...(requestedPath ? { path: requestedPath } : {}) });
      setPath(result.path);
      setPathInput(result.path);
      setEntries(result.entries);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setEntries([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setPath(''); setPathInput(''); setEntries([]); setError('');
    if (session?.state === 'connected') void load();
  }, [session?.id, session?.cwd, session?.state]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  const uploadPaths = async (paths: string[]) => {
    if (!session || !path || paths.length === 0) return;
    const remoteNames = new Set(entries.filter((entry) => entry.kind !== 'directory').map((entry) => entry.name));
    const conflicts = paths.some((localPath) => remoteNames.has(localPath.replace(/^.*[\\/]/, '')));
    if (conflicts) { setOverwrite({ paths, remoteDirectory: path }); return; }
    await startUpload(paths, false);
  };

  const startUpload = async (paths: string[], allowOverwrite: boolean) => {
    if (!session) return;
    setError('');
    try {
      await host.invoke('sftp.upload', { sessionId: session.id, localPaths: paths, remoteDirectory: path, overwrite: allowOverwrite });
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  };

  const chooseUpload = async () => {
    const paths = await host.invoke<string[]>('host.chooseFiles', { multiple: true });
    await uploadPaths(paths);
  };

  const download = async (entry: RemoteFileEntry) => {
    if (!session || entry.kind === 'directory') return;
    const result = await host.invoke<{ path: string } | null>('host.chooseSavePath', { suggestedName: entry.name });
    if (!result) return;
    await host.invoke('sftp.download', { sessionId: session.id, remotePath: entry.path, localPath: result.path, overwrite: true });
  };

  const parentPath = useMemo(() => {
    if (!path || path === '/') return '/';
    const parts = path.split('/').filter(Boolean);
    parts.pop();
    return `/${parts.join('/')}` || '/';
  }, [path]);

  return <aside className={`file-panel${open ? ' is-open' : ''}`} aria-label="远端文件">
    <header className="panel-heading">
      <div><strong>文件</strong>{session && <small>{session.title}</small>}</div>
      <div className="panel-heading-actions">{headerActions}<button className="icon-button drawer-close" type="button" aria-label="关闭文件面板" title="关闭文件面板" onClick={onClose}><X size={17} aria-hidden="true" /></button></div>
    </header>
    <div className="integration-row">
      <label><input type="checkbox" checked={passiveFollowEnabled} disabled={!connected} onChange={(event) => { if (session) void host.invoke('sessions.integration', { id: session.id, enabled: event.target.checked }); }} /><span>跟随终端当前目录</span></label>
      {session?.integration === 'pending' && <small>等待远端终端主动上报目录</small>}
      {session?.integration === 'independent' && passiveFollowEnabled && <small title={session.message}>远端尚未上报目录，当前为独立导航</small>}
      {session?.integration === 'independent' && !passiveFollowEnabled && <small>独立导航</small>}
    </div>
    <div className="path-toolbar">
      <button className="icon-button" type="button" aria-label="返回上级目录" title="返回上级目录" disabled={!connected || path === '/'} onClick={() => void load(parentPath)}><ArrowUp size={16} aria-hidden="true" /></button>
      <input aria-label="远端路径" value={pathInput} disabled={!connected} onChange={(event) => setPathInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void load(pathInput); }} />
      <button className="icon-button" type="button" aria-label="刷新远端目录" title="刷新" disabled={!connected || loading} onClick={() => void load(path)}><RefreshCw className={loading ? 'spin' : ''} size={16} aria-hidden="true" /></button>
    </div>
    <div className="file-actions"><button className="secondary-button" type="button" disabled={!connected} onClick={() => void chooseUpload()}><Upload size={16} aria-hidden="true" />上传文件</button></div>
    <div className="file-table-heading"><span>名称</span><span>大小</span><span>修改时间</span><span /></div>
    <div className="file-list" onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }} onDrop={(event) => { event.preventDefault(); void host.resolveDroppedFiles([...event.dataTransfer.files]).then(uploadPaths).catch((caught) => setError(caught instanceof Error ? caught.message : String(caught))); }}>
      {!session && <p className="panel-empty">选择一个终端会话</p>}
      {session && !connected && <p className="panel-empty">当前会话未连接</p>}
      {connected && loading && <div className="file-loading" role="status"><span /><span /><span /></div>}
      {connected && !loading && error && <p className="panel-error" role="alert">{error}</p>}
      {connected && !loading && !error && entries.length === 0 && <p className="panel-empty">此目录为空</p>}
      {connected && !loading && !error && entries.map((entry) => <div className="file-row" key={entry.path} onDoubleClick={() => entry.kind === 'directory' ? void load(entry.path) : void download(entry)}>
        <button className="file-name" type="button" onClick={() => entry.kind === 'directory' ? void load(entry.path) : undefined} title={entry.path}>{entry.kind === 'directory' ? <Folder size={17} aria-hidden="true" /> : entry.kind === 'link' ? <FolderOpen size={17} aria-hidden="true" /> : <File size={17} aria-hidden="true" />}<span>{entry.name}</span></button>
        <span>{entry.kind === 'directory' ? '-' : formatBytes(entry.size)}</span>
        <span>{entry.modifiedAt ? formatDate(entry.modifiedAt) : '-'}</span>
        <span>{entry.kind !== 'directory' && <button className="icon-button small" type="button" aria-label={`下载 ${entry.name}`} title="下载" onClick={() => void download(entry)}><Download size={14} aria-hidden="true" /></button>}</span>
      </div>)}
    </div>
    {overwrite && <div className="dialog-backdrop local-confirm"><section className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="overwrite-title"><strong id="overwrite-title">远端文件已存在</strong><p>继续上传将覆盖同名文件。</p><footer><button className="secondary-button" type="button" onClick={() => setOverwrite(undefined)}>取消</button><button className="danger-button" type="button" onClick={() => { const pending = overwrite; setOverwrite(undefined); void startUpload(pending.paths, true); }}>确认覆盖</button></footer></section></div>}
  </aside>;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatDate(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(value);
}
