import { Plus, RotateCcw, X } from 'lucide-react';
import { useCallback, useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { SessionSummary } from '../shared/types';
import type { AppHostClient } from './host-api';

interface TerminalWorkspaceProps {
  host: AppHostClient;
  sessions: SessionSummary[];
  activeId?: string;
  onActive(id: string): void;
  onDisconnect(id: string): void;
  onReconnect(id: string): void;
  onNew(): void;
}

interface TerminalRecord {
  terminal: Terminal;
  fit: FitAddon;
  loadingSnapshot: boolean;
  pendingData: string[];
}

/**
 * 管理窗口内多标签 xterm 展示。
 * backend 是会话真源，组件重建时先恢复最多 1 MiB 快照，再追加恢复期间收到的数据，避免
 * 独立窗口关闭重开造成输出丢失或乱序。
 */
export function TerminalWorkspace({ host, sessions, activeId, onActive, onDisconnect, onReconnect, onNew }: TerminalWorkspaceProps) {
  const records = useRef(new Map<string, TerminalRecord>());
  const workspaceRef = useRef<HTMLElement>(null);

  const mountTerminal = useCallback((sessionId: string, element: HTMLDivElement | null) => {
    if (!element || records.current.has(sessionId)) return;
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: '"Cascadia Mono", "JetBrains Mono", Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.28,
      scrollback: 10_000,
      theme: {
        background: '#0b1118', foreground: '#d9e2ec', cursor: '#74a7ff', selectionBackground: '#2a4c78aa',
        black: '#111827', red: '#ff6b7a', green: '#52d273', yellow: '#f0c75e', blue: '#68a4ff',
        magenta: '#c990ff', cyan: '#56c8d8', white: '#d9e2ec', brightBlack: '#65758b'
      }
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element);
    terminal.onData((data) => { void host.invoke('sessions.input', { id: sessionId, data }).catch(() => undefined); });
    const record: TerminalRecord = { terminal, fit, loadingSnapshot: true, pendingData: [] };
    records.current.set(sessionId, record);
    void host.invoke<string>('sessions.snapshot', { id: sessionId })
      .then((snapshot) => {
        if (!records.current.has(sessionId)) return;
        terminal.write(snapshot || '');
        record.pendingData.forEach((data) => terminal.write(data));
      })
      .finally(() => { record.loadingSnapshot = false; record.pendingData = []; });
  }, [host]);

  useEffect(() => host.onEvent((event) => {
    if (event.event !== 'session.data') return;
    const value = event.payload as { id: string; data: string };
    const record = records.current.get(value.id);
    if (!record) return;
    if (record.loadingSnapshot) record.pendingData.push(value.data);
    else record.terminal.write(value.data);
  }), [host]);

  useEffect(() => {
    const ids = new Set(sessions.map((session) => session.id));
    for (const [id, record] of records.current) {
      if (ids.has(id)) continue;
      record.terminal.dispose();
      records.current.delete(id);
    }
  }, [sessions]);

  useEffect(() => {
    if (!activeId || !workspaceRef.current) return;
    const fitActive = () => {
      const record = records.current.get(activeId);
      if (!record) return;
      try {
        record.fit.fit();
        if (record.terminal.cols > 0 && record.terminal.rows > 0) void host.invoke('sessions.resize', { id: activeId, cols: record.terminal.cols, rows: record.terminal.rows });
      } catch { /* 布局切换期间容器可能暂时不可见，下次 ResizeObserver 会重试。 */ }
    };
    fitActive();
    const observer = new ResizeObserver(fitActive);
    observer.observe(workspaceRef.current);
    records.current.get(activeId)?.terminal.focus();
    return () => observer.disconnect();
  }, [activeId, host, sessions.length]);

  useEffect(() => () => {
    for (const record of records.current.values()) record.terminal.dispose();
    records.current.clear();
  }, []);

  return <section className="terminal-workspace" ref={workspaceRef} aria-label="SSH 终端会话">
    <div className="terminal-tabs" role="tablist" aria-label="终端会话">
      {sessions.map((session) => <div className={`terminal-tab${session.id === activeId ? ' active' : ''}`} key={session.id}>
        <button type="button" role="tab" aria-selected={session.id === activeId} onClick={() => onActive(session.id)}>
          <span className={`state-dot ${session.state}`} aria-hidden="true" />{session.title}
        </button>
        {session.state === 'disconnected' || session.state === 'error'
          ? <button className="tab-action" type="button" aria-label={`重新连接 ${session.title}`} title="重新连接" onClick={() => onReconnect(session.id)}><RotateCcw size={13} aria-hidden="true" /></button>
          : null}
        <button className="tab-action" type="button" aria-label={`关闭 ${session.title}`} title="关闭会话" onClick={() => onDisconnect(session.id)}><X size={13} aria-hidden="true" /></button>
      </div>)}
      <button className="new-tab-button" type="button" aria-label="新建 SSH 连接" title="新建连接" onClick={onNew}><Plus size={16} aria-hidden="true" /></button>
    </div>
    <div className="terminal-panes">
      {sessions.length === 0 && <div className="terminal-empty"><span>尚未连接远端设备</span></div>}
      {sessions.map((session) => <div key={session.id} className={`terminal-pane${session.id === activeId ? ' active' : ''}`} aria-hidden={session.id !== activeId} ref={(element) => mountTerminal(session.id, element)} />)}
    </div>
  </section>;
}
