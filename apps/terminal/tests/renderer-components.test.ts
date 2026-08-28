import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ConnectionDialog } from '../renderer/connection-dialog';
import { DeviceSidebar } from '../renderer/device-sidebar';
import { FilePanel } from '../renderer/file-panel';
import { SplitPaneHandle } from '../renderer/split-pane-handle';
import { TerminalContextMenu, TerminalWorkspace } from '../renderer/terminal-workspace';
import * as terminalWorkspaceModule from '../renderer/terminal-workspace';
import { TransferTaskPopover } from '../renderer/transfer-task-popover';

describe('SSH 工作区组件', () => {
  it('按 Windows Terminal 语义区分复制、粘贴和远端中断快捷键', () => {
    const resolveShortcut = (terminalWorkspaceModule as unknown as {
      resolveTerminalClipboardShortcut?: (event: { key: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }, hasSelection: boolean) => 'copy' | 'paste' | undefined;
    }).resolveTerminalClipboardShortcut;
    const key = (value: string, shiftKey = false) => ({ key: value, ctrlKey: true, shiftKey, altKey: false, metaKey: false });

    expect(resolveShortcut).toBeTypeOf('function');
    expect(resolveShortcut?.(key('c'), true)).toBe('copy');
    expect(resolveShortcut?.(key('c'), false)).toBeUndefined();
    expect(resolveShortcut?.(key('c', true), false)).toBe('copy');
    expect(resolveShortcut?.(key('v'), false)).toBe('paste');
    expect(resolveShortcut?.(key('v', true), false)).toBe('paste');
    expect(resolveShortcut?.({ ...key('v'), altKey: true }, false)).toBeUndefined();
  });

  it('右键菜单呈现复制粘贴状态并限制在可视区域内', () => {
    const clampPosition = (terminalWorkspaceModule as unknown as {
      clampTerminalContextMenuPosition?: (x: number, y: number, viewportWidth: number, viewportHeight: number) => { x: number; y: number };
    }).clampTerminalContextMenuPosition;
    const markup = renderToStaticMarkup(createElement(TerminalContextMenu, {
      position: { x: 100, y: 120 }, canCopy: false, canPaste: true,
      onCopy: () => undefined, onPaste: () => undefined
    }));

    expect(markup).toContain('role="menu"');
    expect(markup).toContain('role="menuitem" disabled=""');
    expect(markup).toContain('>复制<');
    expect(markup).toContain('>粘贴<');
    expect(clampPosition?.(790, 590, 800, 600)).toEqual({ x: 648, y: 516 });
  });

  it('仅在焦点转移到 iframe 内其他控件时释放终端 Tab 捕获', () => {
    const shouldReleaseTerminalTabCapture = (terminalWorkspaceModule as unknown as {
      shouldReleaseTerminalTabCapture?: (relatedTarget: EventTarget | null) => boolean;
    }).shouldReleaseTerminalTabCapture;

    expect(shouldReleaseTerminalTabCapture).toBeTypeOf('function');
    expect(shouldReleaseTerminalTabCapture?.({} as EventTarget)).toBe(true);
    expect(shouldReleaseTerminalTabCapture?.(null)).toBe(false);
  });

  it('设备栏区分最近连接与已保存连接并提供明确操作名称', () => {
    const markup = renderToStaticMarkup(createElement(DeviceSidebar, {
      collapsed: false,
      connections: {
        recent: [{ id: 'recent-1', name: '临时机', host: '10.0.0.8', port: 22, username: 'ops', auth: 'password', lastConnectedAt: '2026-08-28T10:00:00Z' }],
        saved: [{ id: 'saved-1', name: '生产机', host: '10.0.0.9', port: 22, username: 'root', auth: 'password' }]
      },
      onNew: () => undefined,
      onConnect: () => undefined,
      onEdit: () => undefined,
      onDelete: () => undefined,
      onClearRecent: () => undefined
    }));

    expect(markup).toContain('最近连接');
    expect(markup).toContain('已保存连接');
    expect(markup).toContain('aria-label="编辑生产机"');
    expect(markup).toContain('ops@10.0.0.8:22');
  });

  it('连接对话框使用单行 JSON 快速填充且不渲染设计说明栏和目录跟随选项', () => {
    const markup = renderToStaticMarkup(createElement(ConnectionDialog, {
      open: true,
      onCancel: () => undefined,
      onSubmit: () => undefined,
      onChoosePrivateKey: async () => undefined
    }));

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('连接模板（粘贴 JSON）');
    expect(markup).toContain('认证方式');
    expect(markup).toContain('连接后自动切换到 root 用户');
    expect(markup).toContain('保存此设备');
    expect(markup).toContain('placeholder="{&quot;port&quot;:8888,&quot;ip&quot;:&quot;192.168.1.1&quot;}"');
    expect(markup).toContain('<input id="connection-json"');
    expect(markup).not.toContain('<textarea');
    expect(markup).not.toContain('aria-label="连接帮助"');
    expect(markup).not.toContain('跟随终端当前目录');
    expect(markup).toContain('class="form-options-grid"');
  });

  it('只在顶部工具栏保留带文字的新建连接主操作', () => {
    const sidebarMarkup = renderToStaticMarkup(createElement(DeviceSidebar, {
      collapsed: false,
      connections: { recent: [], saved: [] },
      onNew: () => undefined,
      onConnect: () => undefined,
      onEdit: () => undefined,
      onDelete: () => undefined,
      onClearRecent: () => undefined
    }));
    const workspaceMarkup = renderToStaticMarkup(createElement(TerminalWorkspace, {
      host: { invoke: async () => undefined, onEvent: () => () => undefined } as never,
      sessions: [],
      onActive: () => undefined,
      onDisconnect: () => undefined,
      onReconnect: () => undefined,
      onNew: () => undefined,
      onError: () => undefined
    }));

    expect(sidebarMarkup).not.toContain('>新建连接<');
    expect(workspaceMarkup).not.toContain('>新建连接<');
    expect(workspaceMarkup).toContain('aria-label="新建 SSH 连接"');
  });

  it('Split Pane 分隔线提供鼠标和键盘共用的可访问尺寸语义', () => {
    const markup = renderToStaticMarkup(createElement(SplitPaneHandle, {
      side: 'left',
      value: 274,
      minimum: 200,
      maximum: 420,
      onResize: () => undefined
    }));

    expect(markup).toContain('role="separator"');
    expect(markup).toContain('aria-orientation="vertical"');
    expect(markup).toContain('aria-label="调整设备栏宽度"');
    expect(markup).toContain('aria-valuenow="274"');
    expect(markup).toContain('tabindex="0"');
  });

  it('目录跟随开关只在文件侧栏显示完整名称', () => {
    const markup = renderToStaticMarkup(createElement(FilePanel, {
      host: { invoke: async () => undefined, onEvent: () => () => undefined } as never,
      session: {
        id: 'session-1', title: '生产机', state: 'connected', integration: 'following',
        profile: { name: '生产机', host: '10.0.0.9', port: 22, username: 'root', auth: 'password' }
      },
      open: true,
      onClose: () => undefined
    }));

    expect(markup).toContain('跟随终端当前目录');
  });

  it('被动监听已开启但尚无 OSC 7 时保持勾选并提示独立导航', () => {
    const markup = renderToStaticMarkup(createElement(FilePanel, {
      host: { invoke: async () => undefined, onEvent: () => () => undefined } as never,
      session: {
        id: 'session-passive', title: '运维机', state: 'connected', integration: 'independent',
        message: '远端尚未主动上报当前目录，文件面板使用独立导航。',
        profile: { name: '运维机', host: '10.0.0.8', port: 22, username: 'ops', auth: 'password', shellIntegration: true }
      },
      open: true,
      onClose: () => undefined
    }));

    expect(markup).toContain('<input type="checkbox" checked=""/>');
    expect(markup).toContain('远端尚未上报目录，当前为独立导航');
  });

  it('未选择会话时仍显示禁用的目录跟随勾选框', () => {
    const markup = renderToStaticMarkup(createElement(FilePanel, {
      host: { invoke: async () => undefined, onEvent: () => () => undefined } as never,
      open: true,
      onClose: () => undefined
    }));

    expect(markup).toContain('<input type="checkbox" disabled=""/>');
    expect(markup).toContain('<span>跟随终端当前目录</span>');
  });

  it('没有凭据 ID 的已保存设备仍保持编辑身份和保存选项', () => {
    const markup = renderToStaticMarkup(createElement(ConnectionDialog, {
      open: true,
      initial: { id: 'saved-without-secret', name: '免密设备', host: '10.0.0.10', port: 22, username: 'ops', auth: 'privateKey' },
      onCancel: () => undefined,
      onSubmit: () => undefined,
      onChoosePrivateKey: async () => undefined
    }));

    expect(markup).toContain('编辑 SSH 连接');
    expect(markup).toContain('<input type="checkbox" checked=""/><span>保存此设备</span>');
  });

  it('传输弹层用进度语义和可访问名称呈现任务操作', () => {
    const markup = renderToStaticMarkup(createElement(TransferTaskPopover, {
      open: true,
      tasks: [{
        id: 'transfer-1', sessionId: 'session-1', direction: 'download', name: 'system.log',
        localPath: 'D:/system.log', remotePath: '/var/log/system.log', transferredBytes: 50,
        totalBytes: 100, state: 'running', speedBytesPerSecond: 1024
      }],
      onClose: () => undefined,
      onPause: () => undefined,
      onResume: () => undefined,
      onCancel: () => undefined,
      onRetry: () => undefined,
      onPauseAll: () => undefined,
      onClearCompleted: () => undefined
    }));

    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('aria-valuenow="50"');
    expect(markup).toContain('aria-label="暂停 system.log"');
  });
});
