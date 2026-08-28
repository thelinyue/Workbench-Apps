import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppHostClient } from '../renderer/host-api';

interface PostedMessage { type: string; requestId: string; }

function createHostHarness() {
  let messageListener: ((event: MessageEvent) => void) | undefined;
  const postMessage = vi.fn();
  const parent = { postMessage };
  vi.stubGlobal('crypto', {});
  vi.stubGlobal('window', {
    parent,
    addEventListener: (_type: string, listener: (event: MessageEvent) => void) => { messageListener = listener; }
  });
  return {
    parent,
    postMessage,
    dispatch(data: unknown) {
      messageListener?.({ source: parent, data } as MessageEvent);
    }
  };
}

describe('分析中心宿主通信', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('在 randomUUID 不可用时仍能发出并完成请求', async () => {
    const harness = createHostHarness();
    const client = new AppHostClient('analysis-center');
    const request = client.invoke<string[]>('packages.list');
    const message = harness.postMessage.mock.calls[0]?.[0] as PostedMessage;
    harness.dispatch({ type: 'workbench-app-rpc-response', appId: 'analysis-center', requestId: message.requestId, ok: true, result: [] });

    await expect(request).resolves.toEqual([]);
    expect(message.requestId).toEqual(expect.any(String));
    expect(message.requestId).not.toHaveLength(0);
  });

  it('只用匹配的应用和请求 ID 完成拖入文件路径请求', async () => {
    const harness = createHostHarness();
    const client = new AppHostClient('analysis-center');
    const request = client.resolveDroppedFiles([{ name: 'diagnostic.tgz' } as File]);
    const message = harness.postMessage.mock.calls[0]?.[0] as PostedMessage & { files: File[] };
    const settled = vi.fn();
    void request.then(settled);

    expect(message).toMatchObject({ type: 'workbench-app-file-drop', requestId: expect.any(String) });
    expect(message.requestId).not.toHaveLength(0);
    expect(message.files).toHaveLength(1);

    harness.dispatch({ type: 'workbench-app-file-drop-response', appId: 'another-app', requestId: message.requestId, ok: true, paths: ['D:/wrong-app.tgz'] });
    harness.dispatch({ type: 'workbench-app-file-drop-response', appId: 'analysis-center', requestId: 'wrong-request', ok: true, paths: ['D:/wrong-request.tgz'] });
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    harness.dispatch({ type: 'workbench-app-file-drop-response', appId: 'analysis-center', requestId: message.requestId, ok: true, paths: ['D:/inbox/diagnostic.tgz'] });
    await expect(request).resolves.toEqual(['D:/inbox/diagnostic.tgz']);
  });

  it('宿主解析拖入文件失败时保留中文错误信息', async () => {
    const harness = createHostHarness();
    const client = new AppHostClient('analysis-center');
    const request = client.resolveDroppedFiles([{ name: 'diagnostic.tgz' } as File]);
    const message = harness.postMessage.mock.calls[0]?.[0] as PostedMessage;

    harness.dispatch({ type: 'workbench-app-file-drop-response', appId: 'analysis-center', requestId: message.requestId, ok: false, errorMessage: '无法读取拖入文件的本地路径。' });

    await expect(request).rejects.toThrow('无法读取拖入文件的本地路径。');
  });

  it('RPC 响应和拖入文件响应不会交叉完成请求', async () => {
    const harness = createHostHarness();
    const client = new AppHostClient('analysis-center');
    const rpcRequest = client.invoke<string>('settings.get');
    const dropRequest = client.resolveDroppedFiles([{ name: 'diagnostic.tgz' } as File]);
    const messages = harness.postMessage.mock.calls.map(([message]) => message as PostedMessage);
    const rpcMessage = messages.find((message) => message.type === 'workbench-app-rpc')!;
    const dropMessage = messages.find((message) => message.type === 'workbench-app-file-drop')!;
    const rpcSettled = vi.fn();
    const dropSettled = vi.fn();
    void rpcRequest.then(rpcSettled);
    void dropRequest.then(dropSettled);

    harness.dispatch({ type: 'workbench-app-rpc-response', appId: 'analysis-center', requestId: dropMessage.requestId, ok: true, result: '错误的 RPC 结果' });
    harness.dispatch({ type: 'workbench-app-file-drop-response', appId: 'analysis-center', requestId: rpcMessage.requestId, ok: true, paths: ['D:/wrong-channel.tgz'] });
    await Promise.resolve();
    expect(rpcSettled).not.toHaveBeenCalled();
    expect(dropSettled).not.toHaveBeenCalled();

    harness.dispatch({ type: 'workbench-app-rpc-response', appId: 'analysis-center', requestId: rpcMessage.requestId, ok: true, result: 'rpc-ok' });
    harness.dispatch({ type: 'workbench-app-file-drop-response', appId: 'analysis-center', requestId: dropMessage.requestId, ok: true, paths: ['D:/drop-ok.tgz'] });
    await expect(rpcRequest).resolves.toBe('rpc-ok');
    await expect(dropRequest).resolves.toEqual(['D:/drop-ok.tgz']);
  });
});
