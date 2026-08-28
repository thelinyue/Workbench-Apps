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

interface FileDropMessage {
  type: 'workbench-app-file-drop';
  appId: string;
  requestId: string;
  files: File[];
}

interface FileDropResponse {
  type: 'workbench-app-file-drop-response';
  appId: string;
  requestId: string;
  ok: boolean;
  paths?: string[];
  errorMessage?: string;
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
  private readonly fileDropPending = new Map<string, { resolve: (paths: string[]) => void; reject: (error: Error) => void }>();
  private readonly eventListeners = new Set<(event: AppHostEvent) => void>();

  public constructor(private readonly appId: string) {
    window.addEventListener('message', (event: MessageEvent<RpcResponse | FileDropResponse | { type: 'workbench-app-event'; event: AppHostEvent }>) => {
      if (event.source !== window.parent || !event.data) return;
      if (event.data.type === 'workbench-app-file-drop-response') {
        if (event.data.appId !== this.appId) return;
        const pending = this.fileDropPending.get(event.data.requestId);
        if (!pending) return;
        this.fileDropPending.delete(event.data.requestId);
        event.data.ok
          ? pending.resolve(event.data.paths ?? [])
          : pending.reject(new Error(event.data.errorMessage ?? '宿主未能解析拖入文件的本地路径。'));
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

  /**
   * 仅向宿主请求 Chromium File 对应的本地路径，诊断包导入仍由分析中心负责。
   * 文件投递与普通 RPC 使用独立 pending 表，避免相同请求 ID 或错误消息类型造成串线。
   */
  public resolveDroppedFiles(files: File[]): Promise<string[]> {
    const requestId = createRequestId();
    const message: FileDropMessage = { type: 'workbench-app-file-drop', appId: this.appId, requestId, files };
    return new Promise<string[]>((resolve, reject) => {
      this.fileDropPending.set(requestId, { resolve, reject });
      window.parent.postMessage(message, '*');
    });
  }

  public onEvent(listener: (event: AppHostEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }
}
