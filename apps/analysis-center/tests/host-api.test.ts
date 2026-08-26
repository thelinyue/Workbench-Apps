import { describe, expect, it, vi } from 'vitest';
import { AppHostClient } from '../renderer/host-api';

describe('分析中心宿主通信', () => {
  it('在 randomUUID 不可用时仍能发出并完成请求', async () => {
    let messageListener: ((event: MessageEvent) => void) | undefined;
    const postMessage = vi.fn();
    const parent = { postMessage };
    vi.stubGlobal('crypto', {});
    vi.stubGlobal('window', {
      parent,
      addEventListener: (_type: string, listener: (event: MessageEvent) => void) => { messageListener = listener; }
    });

    const client = new AppHostClient('analysis-center');
    const request = client.invoke<string[]>('packages.list');
    const message = postMessage.mock.calls[0]?.[0] as { requestId: string };
    messageListener?.({ source: parent, data: { type: 'workbench-app-rpc-response', appId: 'analysis-center', requestId: message.requestId, ok: true, result: [] } } as MessageEvent);

    await expect(request).resolves.toEqual([]);
    expect(message.requestId).toEqual(expect.any(String));
    expect(message.requestId).not.toHaveLength(0);
    vi.unstubAllGlobals();
  });
});
