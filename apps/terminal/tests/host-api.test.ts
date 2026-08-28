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
});
