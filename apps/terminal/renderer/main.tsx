import { StrictMode, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import { Files, PanelLeftClose, PanelLeftOpen, PanelRightClose, Plus, UploadCloud } from 'lucide-react';
import '@xterm/xterm/css/xterm.css';
import type { ConnectionCollection, ConnectionProfile, ConnectionTarget, RecentConnection, SessionSummary, TransferTask } from '../shared/types';
import { ConnectionDialog, type ConnectionDialogValue } from './connection-dialog';
import { DeviceSidebar } from './device-sidebar';
import { FilePanel } from './file-panel';
import { AppHostClient } from './host-api';
import { HostKeyDialog, type HostKeyRequest } from './host-key-dialog';
import { SplitPaneHandle } from './split-pane-handle';
import {
  LEFT_PANE_MAX,
  LEFT_PANE_MIN,
  RIGHT_PANE_MAX,
  RIGHT_PANE_MIN,
  loadSplitLayout,
  resolvePaneVisibility,
  resizePane,
  saveSplitLayout,
  type SplitPaneSide
} from './split-pane-layout';
import { TerminalWorkspace } from './terminal-workspace';
import { TransferTaskPopover } from './transfer-task-popover';
import './style.css';

const host = new AppHostClient();

interface PendingAttempt {
  profile: ConnectionTarget;
  secret?: string;
  sudoSecret?: string;
}

function App() {
  const [connections, setConnections] = useState<ConnectionCollection>({ saved: [], recent: [] });
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [transfers, setTransfers] = useState<TransferTask[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [splitLayout, setSplitLayout] = useState(() => loadSplitLayout(window.localStorage, window.innerWidth));
  const [workspaceWidth, setWorkspaceWidth] = useState(window.innerWidth);
  const [preferredPane, setPreferredPane] = useState<SplitPaneSide>('left');
  const [transfersOpen, setTransfersOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogInitial, setDialogInitial] = useState<ConnectionProfile | RecentConnection>();
  const [hostKeyRequest, setHostKeyRequest] = useState<HostKeyRequest>();
  const [notice, setNotice] = useState('');
  const pendingAttempts = useRef(new Map<string, PendingAttempt>());
  const workspaceRef = useRef<HTMLElement>(null);

  const refreshConnections = () => host.invoke<ConnectionCollection>('connections.list').then(setConnections);
  const refreshSessions = () => host.invoke<SessionSummary[]>('sessions.list').then((items) => {
    setSessions(items);
    setActiveId((current) => current && items.some((item) => item.id === current) ? current : items[0]?.id);
  });
  const refreshTransfers = () => host.invoke<TransferTask[]>('transfers.list').then(setTransfers);

  useEffect(() => {
    void Promise.all([refreshConnections(), refreshSessions(), refreshTransfers()]).catch(showError);
    return host.onEvent((event) => {
      if (event.event === 'session.state' || event.event === 'session.ready') {
        const session = event.payload as SessionSummary;
        setSessions((current) => upsertById(current, session));
        if (event.event === 'session.ready') { setActiveId(session.id); void refreshConnections(); }
      } else if (event.event === 'session.cwd') {
        const value = event.payload as { id: string; cwd: string };
        setSessions((current) => current.map((item) => item.id === value.id ? { ...item, cwd: value.cwd } : item));
      } else if (event.event === 'session.host-key') {
        setHostKeyRequest(event.payload as HostKeyRequest);
      } else if (event.event === 'transfer.changed') {
        setTransfers((current) => upsertById(current, event.payload as TransferTask));
      }
    });
  }, []);

  useEffect(() => {
    saveSplitLayout(window.localStorage, splitLayout);
  }, [splitLayout]);

  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const updateWidth = () => setWorkspaceWidth(workspace.clientWidth);
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(workspace);
    return () => observer.disconnect();
  }, []);

  const activeSession = useMemo(() => sessions.find((session) => session.id === activeId), [sessions, activeId]);
  const activeTransfers = transfers.filter((task) => task.state === 'queued' || task.state === 'running' || task.state === 'paused').length;
  const paneVisibility = useMemo(
    () => resolvePaneVisibility(splitLayout, workspaceWidth, preferredPane),
    [splitLayout, workspaceWidth, preferredPane]
  );

  const openNewDialog = () => { setDialogInitial(undefined); setDialogOpen(true); };
  const openEditDialog = (profile: ConnectionProfile | RecentConnection) => { setDialogInitial(profile); setDialogOpen(true); };

  const connectNow = async (profile: ConnectionTarget, secret?: string, sudoSecret?: string) => {
    pendingAttempts.current.set(targetKey(profile), { profile, secret, sudoSecret });
    const result = await host.invoke<{ id: string }>('sessions.connect', { profile, secret, sudoSecret });
    setActiveId(result.id);
    await refreshSessions();
  };

  const connectDevice = async (item: ConnectionProfile | RecentConnection) => {
    try {
      if ('savedProfileId' in item && item.savedProfileId) {
        const saved = connections.saved.find((profile) => profile.id === item.savedProfileId);
        if (saved) { await connectSaved(saved); return; }
      }
      if (connections.saved.some((profile) => profile.id === item.id)) { await connectSaved(item as ConnectionProfile); return; }
      openEditDialog(item);
    } catch (caught) { showError(caught); }
  };

  const connectSaved = async (profile: ConnectionProfile, secretOverride?: string, sudoOverride?: string) => {
    const secret = secretOverride ?? (profile.credentialId ? await host.invoke<string | null>('ssh.credentials.read', { credentialId: profile.credentialId }) ?? undefined : undefined);
    const sudoSecret = sudoOverride ?? (profile.sudoCredentialId ? await host.invoke<string | null>('ssh.credentials.read', { credentialId: profile.sudoCredentialId }) ?? undefined : undefined);
    if (profile.auth === 'password' && !secret) { openEditDialog(profile); return; }
    await connectNow(toTarget(profile), secret, sudoSecret);
  };

  const submitConnection = async (value: ConnectionDialogValue) => {
    if (!value.saveDevice) {
      await connectNow(value.profile, value.secret, value.sudoSecret);
      setDialogOpen(false);
      return;
    }
    const existing = value.profile.id ? connections.saved.find((item) => item.id === value.profile.id) : undefined;
    const id = value.profile.id ?? crypto.randomUUID();
    const credentialId = value.secret ? existing?.credentialId ?? crypto.randomUUID() : existing?.credentialId;
    const sudoCredentialId = value.sudoSecret ? existing?.sudoCredentialId ?? crypto.randomUUID() : existing?.sudoCredentialId;
    if (value.secret && credentialId) await host.invoke('ssh.credentials.write', { credentialId, secret: value.secret });
    if (value.sudoSecret && sudoCredentialId) await host.invoke('ssh.credentials.write', { credentialId: sudoCredentialId, secret: value.sudoSecret });
    const saved = await host.invoke<ConnectionProfile>('connections.save', {
      ...value.profile, id, ...(credentialId ? { credentialId } : {}), ...(sudoCredentialId ? { sudoCredentialId } : {})
    });
    await refreshConnections();
    await connectSaved(saved, value.secret, value.sudoSecret);
    setDialogOpen(false);
  };

  const deleteProfile = async (profile: ConnectionProfile) => {
    if (!window.confirm(`确认删除已保存连接“${profile.name || profile.host}”？`)) return;
    const removed = await host.invoke<ConnectionProfile | undefined>('connections.delete', { id: profile.id });
    if (removed?.credentialId) await host.invoke('ssh.credentials.delete', { credentialId: removed.credentialId });
    if (removed?.sudoCredentialId) await host.invoke('ssh.credentials.delete', { credentialId: removed.sudoCredentialId });
    await refreshConnections();
  };

  const trustHostKey = async (request: HostKeyRequest) => {
    try {
      const attempt = pendingAttempts.current.get(targetKey(request.profile));
      let profile: ConnectionTarget = { ...(attempt?.profile ?? request.profile), hostKey: request.fingerprint };
      if (profile.savedProfileId) {
        const saved = connections.saved.find((item) => item.id === profile.savedProfileId);
        if (saved) {
          await host.invoke('connections.save', { ...saved, hostKey: request.fingerprint });
          await refreshConnections();
        }
      }
      await host.invoke('sessions.disconnect', { id: request.id });
      setHostKeyRequest(undefined);
      await connectNow(profile, attempt?.secret, attempt?.sudoSecret);
    } catch (caught) { showError(caught); }
  };

  const disconnect = async (id: string) => {
    try { await host.invoke('sessions.disconnect', { id }); await refreshSessions(); }
    catch (caught) { showError(caught); }
  };

  const invokeTransfer = (method: string, id?: string) => void host.invoke(method, id ? { id } : {}).catch(showError);
  const resizeSide = (side: SplitPaneSide, width: number) => {
    const availableWidth = workspaceRef.current?.clientWidth ?? window.innerWidth;
    setSplitLayout((current) => {
      const effective = { ...current, ...resolvePaneVisibility(current, availableWidth, preferredPane) };
      const resized = resizePane(effective, side, width, availableWidth);
      return side === 'left' ? { ...current, leftWidth: resized.leftWidth } : { ...current, rightWidth: resized.rightWidth };
    });
  };
  const toggleDevicePanel = () => {
    setPreferredPane('left');
    if (paneVisibility.leftHidden && !splitLayout.leftHidden) return;
    setSplitLayout((current) => ({ ...current, leftHidden: !current.leftHidden }));
  };
  const toggleFilePanel = () => {
    if (!paneVisibility.rightHidden) {
      setPreferredPane('left');
      setSplitLayout((current) => ({ ...current, rightHidden: true }));
      return;
    }
    setPreferredPane('right');
    setSplitLayout((current) => {
      const opening = { ...current, rightHidden: false };
      const resized = resizePane({ ...opening, leftHidden: true }, 'right', opening.rightWidth, workspaceWidth);
      return { ...opening, rightWidth: resized.rightWidth };
    });
  };
  const closeFilePanel = () => {
    setPreferredPane('left');
    setSplitLayout((current) => ({ ...current, rightHidden: true }));
  };

  function showError(caught: unknown) {
    setNotice(caught instanceof Error ? caught.message : String(caught));
    window.setTimeout(() => setNotice(''), 5000);
  }

  const splitStyle = {
    '--left-pane-width': `${paneVisibility.leftHidden ? 0 : splitLayout.leftWidth}px`,
    '--right-pane-width': `${paneVisibility.rightHidden ? 0 : splitLayout.rightWidth}px`
  } as CSSProperties;
  const filePanelOpen = !paneVisibility.rightHidden;

  return <main className="terminal-app-shell">
    <header className="workspace-toolbar">
      <div className="toolbar-primary-zone">
        <button className="primary-button" type="button" onClick={openNewDialog}><Plus size={17} aria-hidden="true" />新建连接</button>
        <button className="icon-button pane-visibility-button" type="button" aria-label={paneVisibility.leftHidden ? '显示设备栏' : '隐藏设备栏'} title={paneVisibility.leftHidden ? '显示设备栏' : '隐藏设备栏'} onClick={toggleDevicePanel}>{paneVisibility.leftHidden ? <PanelLeftOpen size={18} aria-hidden="true" /> : <PanelLeftClose size={18} aria-hidden="true" />}</button>
      </div>
      <div className="toolbar-group">
        <button className={`secondary-button${filePanelOpen ? ' selected' : ''}`} type="button" aria-pressed={filePanelOpen} onClick={toggleFilePanel}><Files size={17} aria-hidden="true" />文件</button>
      </div>
    </header>
    <section ref={workspaceRef} className={`workspace-body${paneVisibility.leftHidden ? ' left-pane-hidden' : ''}${paneVisibility.rightHidden ? ' right-pane-hidden' : ''}`} style={splitStyle}>
      {!paneVisibility.leftHidden && <DeviceSidebar collapsed={false} connections={connections} onNew={openNewDialog} onConnect={(profile) => void connectDevice(profile)} onEdit={openEditDialog} onDelete={(profile) => void deleteProfile(profile).catch(showError)} onClearRecent={() => void host.invoke('connections.clearRecent').then(refreshConnections).catch(showError)} />}
      {!paneVisibility.leftHidden && <SplitPaneHandle side="left" value={splitLayout.leftWidth} minimum={LEFT_PANE_MIN} maximum={LEFT_PANE_MAX} onResize={(width) => resizeSide('left', width)} />}
      <TerminalWorkspace host={host} sessions={sessions} activeId={activeId} onActive={setActiveId} onDisconnect={(id) => void disconnect(id)} onReconnect={(id) => void host.invoke<{ id: string }>('sessions.reconnect', { id }).then(() => setActiveId(id)).catch(showError)} onNew={openNewDialog} onError={showError} />
      {!paneVisibility.rightHidden && <SplitPaneHandle side="right" value={splitLayout.rightWidth} minimum={RIGHT_PANE_MIN} maximum={RIGHT_PANE_MAX} onResize={(width) => resizeSide('right', width)} />}
      {!paneVisibility.rightHidden && <FilePanel
        host={host}
        session={activeSession}
        open={filePanelOpen}
        onClose={closeFilePanel}
        headerActions={<>
          <div className="transfer-anchor"><button className={`secondary-button transfer-button${transfersOpen ? ' selected' : ''}`} type="button" aria-expanded={transfersOpen} onClick={() => setTransfersOpen((value) => !value)}><UploadCloud size={16} aria-hidden="true" />传输任务{activeTransfers > 0 && <span className="count-badge">{activeTransfers}</span>}</button>
            <TransferTaskPopover open={transfersOpen} tasks={transfers} onClose={() => setTransfersOpen(false)} onPause={(id) => invokeTransfer('transfers.pause', id)} onResume={(id) => invokeTransfer('transfers.resume', id)} onCancel={(id) => invokeTransfer('transfers.cancel', id)} onRetry={(id) => invokeTransfer('transfers.retry', id)} onPauseAll={() => invokeTransfer('transfers.pauseAll')} onClearCompleted={() => { void host.invoke('transfers.clearCompleted').then(refreshTransfers).catch(showError); }} />
          </div>
          <button className="icon-button desktop-pane-close" type="button" aria-label="隐藏文件栏" title="隐藏文件栏" onClick={closeFilePanel}><PanelRightClose size={17} aria-hidden="true" /></button>
        </>}
      />}
    </section>
    <footer className="connection-statusbar">
      <span><i className={`state-dot ${activeSession?.state ?? 'disconnected'}`} />{activeSession ? stateLabel(activeSession.state) : '未连接'}</span>
      {activeSession && <><span>{activeSession.title}</span><span>{activeSession.profile.username}@{activeSession.profile.host}:{activeSession.profile.port}</span><span>{activeSession.integration === 'following' ? '目录跟随' : '独立导航'}</span></>}
      <span className="status-encoding">UTF-8</span>
    </footer>
    <ConnectionDialog open={dialogOpen} initial={dialogInitial} onCancel={() => setDialogOpen(false)} onSubmit={submitConnection} onChoosePrivateKey={async () => (await host.invoke<string[]>('host.chooseFiles', { multiple: false, filters: [{ name: 'SSH 私钥', extensions: ['pem', 'key', 'ppk'] }] }))[0]} />
    <HostKeyDialog request={hostKeyRequest} onCancel={() => setHostKeyRequest(undefined)} onTrust={(request) => void trustHostKey(request)} />
    {notice && <div className="notice-toast" role="alert">{notice}</div>}
  </main>;
}

function toTarget(profile: ConnectionProfile): ConnectionTarget {
  const { id, credentialId: _credentialId, sudoCredentialId: _sudoCredentialId, lastConnectedAt: _lastConnectedAt, ...target } = profile;
  return { ...target, savedProfileId: id };
}

function targetKey(profile: Pick<ConnectionTarget, 'host' | 'port' | 'username'>): string {
  return `${profile.username}\u0000${profile.host.toLowerCase()}\u0000${profile.port}`;
}

function upsertById<T extends { id: string }>(items: T[], value: T): T[] {
  return items.some((item) => item.id === value.id) ? items.map((item) => item.id === value.id ? value : item) : [...items, value];
}

function stateLabel(state: SessionSummary['state']): string {
  return ({ connecting: '连接中', connected: '已连接', disconnected: '已断开', error: '连接错误' })[state];
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
