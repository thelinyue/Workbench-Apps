export class AppHostClient {
  private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  private readonly listeners = new Set<(event: { event: string; payload: unknown }) => void>();
  public constructor() { window.addEventListener('message', (event) => { if (event.source !== window.parent || !event.data) return; const value = event.data; if (value.type === 'workbench-app-event') this.listeners.forEach((listener) => listener(value.event)); else if (value.type === 'workbench-app-rpc-response') { const item = this.pending.get(value.requestId); if (!item) return; this.pending.delete(value.requestId); value.ok ? item.resolve(value.result) : item.reject(new Error(value.errorMessage ?? '请求失败')); } }); }
  public invoke<T>(method: string, payload?: unknown): Promise<T> { const requestId = crypto.randomUUID(); window.parent.postMessage({ type: 'workbench-app-rpc', appId: 'ssh-terminal', requestId, method, payload }, '*'); return new Promise((resolve, reject) => this.pending.set(requestId, { resolve: resolve as (value: unknown) => void, reject })); }
  public onEvent(listener: (event: { event: string; payload: unknown }) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
}
