import type { AppHostEvent } from '../../../sdk/app-contract';

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

interface AppCommand {
  type: 'workbench-app-command';
  appId: string;
  command: string;
}

let requestSequence = 0;

/**
 * 自定义 workbench-app 协议下的 Chromium 可能没有实现 crypto.randomUUID。
 * 请求 ID 只用于匹配本次 iframe RPC 响应，不承担鉴权或密钥用途，因此降级到进程内唯一值即可。
 */
function createRequestId(): string {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (typeof randomUUID === 'function') return randomUUID.call(globalThis.crypto);
  requestSequence += 1;
  return `analysis-${Date.now().toString(36)}-${requestSequence.toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** iframe 内唯一的宿主通信入口，来源和请求 ID 均由父窗口校验后才会得到响应。 */
export class AppHostClient {
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly eventListeners = new Set<(event: AppHostEvent) => void>();
  private readonly commandListeners = new Set<(command: string) => void>();

  public constructor(private readonly appId: string) {
    window.addEventListener('message', (event: MessageEvent<RpcResponse | { type: 'workbench-app-event'; event: AppHostEvent } | AppCommand>) => {
      if (event.source !== window.parent || !event.data) return;
      if (event.data.type === 'workbench-app-command') {
        const command = event.data.command;
        if (event.data.appId === this.appId) this.commandListeners.forEach((listener) => listener(command));
        return;
      }
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
    const requestId = createRequestId();
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

  /** 宿主标题栏等壳层控件通过命令驱动应用内的临时界面，不越权访问应用数据。 */
  public onCommand(listener: (command: string) => void): () => void {
    this.commandListeners.add(listener);
    return () => this.commandListeners.delete(listener);
  }
}
