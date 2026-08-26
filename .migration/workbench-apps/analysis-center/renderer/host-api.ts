import type { AppHostEvent } from '../../../src/shared/app-contract';

interface RpcMessage {
  type: 'workbench-app-rpc';
  appId: string;
  requestId: string;
  method: string;
  payload: unknown;
}

interface RpcResponse {
  type: 'workbench-app-rpc-response';
  appId: string;
  requestId: string;
  ok: boolean;
  result?: unknown;
  errorMessage?: string;
}

/** iframe 内唯一的宿主通信入口，来源和请求 ID 均由父窗口校验后才会得到响应。 */
export class AppHostClient {
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly eventListeners = new Set<(event: AppHostEvent) => void>();

  public constructor(private readonly appId: string) {
    window.addEventListener('message', (event: MessageEvent<RpcResponse | { type: 'workbench-app-event'; event: AppHostEvent }>) => {
      if (event.source !== window.parent || !event.data) return;
      if (event.data.type === 'workbench-app-event') {
        const appEvent = (event.data as { type: 'workbench-app-event'; event: AppHostEvent }).event;
        if (appEvent.appId !== this.appId) return;
        this.eventListeners.forEach((listener) => listener(appEvent));
        return;
      }
      if (event.data.type !== 'workbench-app-rpc-response' || event.data.appId !== this.appId) return;
      const pending = this.pending.get(event.data.requestId);
      if (!pending) return;
      this.pending.delete(event.data.requestId);
      event.data.ok ? pending.resolve(event.data.result) : pending.reject(new Error(event.data.errorMessage ?? '宿主请求失败'));
    });
  }

  public invoke<T = unknown>(method: string, payload?: unknown): Promise<T> {
    const requestId = crypto.randomUUID();
    const message: RpcMessage = { type: 'workbench-app-rpc', appId: this.appId, requestId, method, payload };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, { resolve: (value) => resolve(value as T), reject });
      window.parent.postMessage(message, '*');
    });
  }

  public onEvent(listener: (event: AppHostEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }
}
