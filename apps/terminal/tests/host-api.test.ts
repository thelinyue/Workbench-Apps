import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppHostClient } from '../renderer/host-api';

describe('Terminal Host Client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('通过通用文件拖放协议解析本地路径并按 requestId 返回', async () => {
    let onMessage: ((event: { source: unknown; data: unknown }) => void) | undefined;
    const parent = { postMessage: vi.fn() };
    vi.stubGlobal('window', {
      parent,
      addEventListener: (_name: string, listener: typeof onMessage) => { onMessage = listener; }
    });
    vi.stubGlobal('crypto', { randomUUID: () => 'drop-request' });
    const client = new AppHostClient();

    const result = client.resolveDroppedFiles([{ name: 'one.log' }] as File[]);
    expect(parent.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'workbench-app-file-drop', appId: 'terminal', requestId: 'drop-request'
    }), '*');
    onMessage?.({ source: parent, data: { type: 'workbench-app-file-drop-response', requestId: 'drop-request', ok: true, paths: ['D:/one.log'] } });

    await expect(result).resolves.toEqual(['D:/one.log']);
  });

  it('向宿主声明 Tab 捕获状态并接收被宿主截获的 Tab', () => {
    let onMessage: ((event: { source: unknown; data: unknown }) => void) | undefined;
    const parent = { postMessage: vi.fn() };
    vi.stubGlobal('window', {
      parent,
      addEventListener: (_name: string, listener: typeof onMessage) => { onMessage = listener; }
    });
    const client = new AppHostClient() as AppHostClient & {
      setKeyboardCapture(key: 'Tab', enabled: boolean): void;
      onKeyboardInput(listener: (event: { key: 'Tab' }) => void): () => void;
    };
    const listener = vi.fn();

    client.setKeyboardCapture('Tab', true);
    client.onKeyboardInput(listener);
    onMessage?.({ source: parent, data: { type: 'workbench-app-keyboard-input', key: 'Tab' } });

    expect(parent.postMessage).toHaveBeenCalledWith({
      type: 'workbench-app-keyboard-capture', appId: 'terminal', key: 'Tab', enabled: true
    }, '*');
    expect(listener).toHaveBeenCalledWith({ key: 'Tab' });
  });

  it('通过受控 Host RPC 读写系统纯文本剪贴板', async () => {
    let onMessage: ((event: { source: unknown; data: unknown }) => void) | undefined;
    const parent = { postMessage: vi.fn() };
    let sequence = 0;
    vi.stubGlobal('window', {
      parent,
      addEventListener: (_name: string, listener: typeof onMessage) => { onMessage = listener; }
    });
    vi.stubGlobal('crypto', { randomUUID: () => `clipboard-${++sequence}` });
    const client = new AppHostClient() as AppHostClient & {
      readClipboardText(): Promise<string>;
      writeClipboardText(text: string): Promise<void>;
    };

    const read = client.readClipboardText();
    expect(parent.postMessage).toHaveBeenLastCalledWith({
      type: 'workbench-app-rpc', appId: 'terminal', requestId: 'clipboard-1', method: 'host.clipboard.readText', payload: undefined
    }, '*');
    onMessage?.({ source: parent, data: { type: 'workbench-app-rpc-response', requestId: 'clipboard-1', ok: true, result: '系统文本' } });
    await expect(read).resolves.toBe('系统文本');

    const write = client.writeClipboardText('终端选区');
    expect(parent.postMessage).toHaveBeenLastCalledWith({
      type: 'workbench-app-rpc', appId: 'terminal', requestId: 'clipboard-2', method: 'host.clipboard.writeText', payload: { text: '终端选区' }
    }, '*');
    onMessage?.({ source: parent, data: { type: 'workbench-app-rpc-response', requestId: 'clipboard-2', ok: true } });
    await expect(write).resolves.toBeUndefined();
  });
});
