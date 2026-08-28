import { ClipboardPaste, Copy, Plus, RotateCcw, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
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
  onError(error: unknown): void;
}

interface TerminalRecord {
  terminal: Terminal;
  fit: FitAddon;
  loadingSnapshot: boolean;
  pendingData: string[];
  releaseKeyboardCapture(): void;
}

interface TerminalShortcutEvent {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

interface TerminalContextMenuState {
  sessionId: string;
  position: { x: number; y: number };
  canCopy: boolean;
}

interface TerminalContextMenuProps {
  menuRef?: RefObject<HTMLDivElement | null>;
  position: { x: number; y: number };
  canCopy: boolean;
  canPaste: boolean;
  onCopy(): void;
  onPaste(): void;
}

const CONTEXT_MENU_WIDTH = 152;
const CONTEXT_MENU_HEIGHT = 84;

/** 保留 Ctrl+C 的远端中断语义，仅在存在选区时把无 Shift 的组合解释为复制。 */
export function resolveTerminalClipboardShortcut(event: TerminalShortcutEvent, hasSelection: boolean): 'copy' | 'paste' | undefined {
  if (!event.ctrlKey || event.altKey || event.metaKey) return undefined;
  const key = event.key.toLowerCase();
  if (key === 'c' && (event.shiftKey || hasSelection)) return 'copy';
  if (key === 'v') return 'paste';
  return undefined;
}

/** 固定定位菜单必须完整留在 iframe 可视区域内，不能遮住后续窗口边缘控件。 */
export function clampTerminalContextMenuPosition(x: number, y: number, viewportWidth: number, viewportHeight: number): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(x, viewportWidth - CONTEXT_MENU_WIDTH)),
    y: Math.max(0, Math.min(y, viewportHeight - CONTEXT_MENU_HEIGHT))
  };
}

/** 终端右键菜单保持操作集合克制，复制与粘贴的可用性由活动 Session 即时决定。 */
export function TerminalContextMenu({ menuRef, position, canCopy, canPaste, onCopy, onPaste }: TerminalContextMenuProps) {
  return <div ref={menuRef} className="terminal-context-menu" role="menu" aria-label="终端操作" style={{ left: position.x, top: position.y }}>
    <button type="button" role="menuitem" disabled={!canCopy} autoFocus={canCopy} onClick={onCopy}><Copy size={15} aria-hidden="true" />复制</button>
    <button type="button" role="menuitem" disabled={!canPaste} autoFocus={!canCopy && canPaste} onClick={onPaste}><ClipboardPaste size={15} aria-hidden="true" />粘贴</button>
  </div>;
}

/** 跨来源 iframe 失焦时 relatedTarget 为 null，应把该次 Tab 交给宿主回送；iframe 内部切换焦点则立即释放捕获。 */
export function shouldReleaseTerminalTabCapture(relatedTarget: EventTarget | null): boolean {
  return relatedTarget !== null;
}

/**
 * 管理窗口内多标签 xterm 展示。
 * backend 是会话真源，组件重建时先恢复最多 1 MiB 快照，再追加恢复期间收到的数据，避免
 * 独立窗口关闭重开造成输出丢失或乱序。xterm 聚焦期间还会临时申请 Tab 捕获，以修复
 * Electron 跨来源 iframe 把补全键重定向到宿主 BODY 的问题，失焦后立即恢复常规焦点导航。
 */
export function TerminalWorkspace({ host, sessions, activeId, onActive, onDisconnect, onReconnect, onNew, onError }: TerminalWorkspaceProps) {
  const records = useRef(new Map<string, TerminalRecord>());
  const sessionsRef = useRef(sessions);
  const workspaceRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [contextMenu, setContextMenu] = useState<TerminalContextMenuState>();
  sessionsRef.current = sessions;

  const copyTerminalSelection = useCallback(async (sessionId: string) => {
    const selection = records.current.get(sessionId)?.terminal.getSelection() ?? '';
    if (!selection) return;
    try { await host.writeClipboardText(selection); } catch (error) { onError(error); }
  }, [host, onError]);

  const pasteIntoTerminal = useCallback(async (sessionId: string) => {
    if (sessionsRef.current.find((session) => session.id === sessionId)?.state !== 'connected') return;
    try {
      const text = await host.readClipboardText();
      const terminal = records.current.get(sessionId)?.terminal;
      if (text && terminal) terminal.paste(text);
      terminal?.focus();
    } catch (error) { onError(error); }
  }, [host, onError]);

  const closeContextMenu = useCallback((restoreFocus = true) => {
    setContextMenu((current) => {
      if (restoreFocus && current) queueMicrotask(() => records.current.get(current.sessionId)?.terminal.focus());
      return undefined;
    });
  }, []);

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
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true;
      const action = resolveTerminalClipboardShortcut(event, terminal.hasSelection());
      if (!action) return true;
      event.preventDefault();
      event.stopPropagation();
      if (action === 'copy') void copyTerminalSelection(sessionId);
      else void pasteIntoTerminal(sessionId);
      return false;
    });
    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      setContextMenu({
        sessionId,
        position: clampTerminalContextMenuPosition(event.clientX, event.clientY, window.innerWidth, window.innerHeight),
        canCopy: terminal.hasSelection()
      });
    };
    element.addEventListener('contextmenu', onContextMenu);
    const textarea = element.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea');
    const onFocus = () => {
      host.setKeyboardCapture('Tab', true);
    };
    const onBlur = (event: FocusEvent) => {
      if (shouldReleaseTerminalTabCapture(event.relatedTarget)) host.setKeyboardCapture('Tab', false);
    };
    textarea?.addEventListener('focus', onFocus);
    textarea?.addEventListener('blur', onBlur);
    const releaseKeyboardCapture = () => {
      const wasFocused = document.activeElement === textarea;
      textarea?.removeEventListener('focus', onFocus);
      textarea?.removeEventListener('blur', onBlur);
      element.removeEventListener('contextmenu', onContextMenu);
      if (wasFocused) host.setKeyboardCapture('Tab', false);
    };
    const record: TerminalRecord = { terminal, fit, loadingSnapshot: true, pendingData: [], releaseKeyboardCapture };
    records.current.set(sessionId, record);
    void host.invoke<string>('sessions.snapshot', { id: sessionId })
      .then((snapshot) => {
        if (!records.current.has(sessionId)) return;
        terminal.write(snapshot || '');
        record.pendingData.forEach((data) => terminal.write(data));
      })
      .finally(() => { record.loadingSnapshot = false; record.pendingData = []; });
  }, [copyTerminalSelection, host, pasteIntoTerminal]);

  useEffect(() => {
    if (!contextMenu) return;
    const closeFromOutside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) closeContextMenu();
    };
    const closeFromKeyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeContextMenu();
    };
    const closeFromViewport = () => closeContextMenu();
    window.addEventListener('pointerdown', closeFromOutside);
    window.addEventListener('keydown', closeFromKeyboard);
    window.addEventListener('resize', closeFromViewport);
    window.addEventListener('blur', closeFromViewport);
    return () => {
      window.removeEventListener('pointerdown', closeFromOutside);
      window.removeEventListener('keydown', closeFromKeyboard);
      window.removeEventListener('resize', closeFromViewport);
      window.removeEventListener('blur', closeFromViewport);
    };
  }, [closeContextMenu, contextMenu]);

  useEffect(() => { closeContextMenu(false); }, [activeId, closeContextMenu]);

  useEffect(() => host.onEvent((event) => {
    if (event.event !== 'session.data') return;
    const value = event.payload as { id: string; data: string };
    const record = records.current.get(value.id);
    if (!record) return;
    if (record.loadingSnapshot) record.pendingData.push(value.data);
    else record.terminal.write(value.data);
  }), [host]);

  useEffect(() => host.onKeyboardInput((event) => {
    if (event.key !== 'Tab' || !activeId) return;
    const record = records.current.get(activeId);
    if (!record) return;
    record.terminal.focus();
    void host.invoke('sessions.input', { id: activeId, data: '\t' }).catch(() => undefined);
  }), [activeId, host]);

  useEffect(() => {
    const ids = new Set(sessions.map((session) => session.id));
    for (const [id, record] of records.current) {
      if (ids.has(id)) continue;
      record.releaseKeyboardCapture();
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
    for (const record of records.current.values()) {
      record.releaseKeyboardCapture();
      record.terminal.dispose();
    }
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
    {contextMenu && <TerminalContextMenu
      menuRef={menuRef}
      position={contextMenu.position}
      canCopy={contextMenu.canCopy}
      canPaste={sessions.some((session) => session.id === contextMenu.sessionId && session.state === 'connected')}
      onCopy={() => { void copyTerminalSelection(contextMenu.sessionId); closeContextMenu(); }}
      onPaste={() => { void pasteIntoTerminal(contextMenu.sessionId); closeContextMenu(); }}
    />}
  </section>;
}
