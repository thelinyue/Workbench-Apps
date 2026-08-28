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
});
