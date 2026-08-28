/**
 * Terminal renderer 的唯一宿主协议客户端。
 * RPC、文件拖放、运行时事件和临时键盘捕获都通过同一个受控 parent 消息边界传递；
 * 客户端不直接访问 Workbench preload，也不把 SSH 凭据或会话状态存放在页面消息之外。
 */
export class AppHostClient {
  private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  private readonly listeners = new Set<(event: { event: string; payload: unknown }) => void>();
  private readonly keyboardListeners = new Set<(event: { key: 'Tab' }) => void>();
  public constructor() { window.addEventListener('message', (event) => { if (event.source !== window.parent || !event.data) return; const value = event.data; if (value.type === 'workbench-app-event') this.listeners.forEach((listener) => listener(value.event)); else if (value.type === 'workbench-app-keyboard-input' && value.key === 'Tab') this.keyboardListeners.forEach((listener) => listener({ key: 'Tab' })); else if (value.type === 'workbench-app-rpc-response' || value.type === 'workbench-app-file-drop-response') { const item = this.pending.get(value.requestId); if (!item) return; this.pending.delete(value.requestId); value.ok ? item.resolve(value.type === 'workbench-app-file-drop-response' ? value.paths : value.result) : item.reject(new Error(value.errorMessage ?? '请求失败')); } }); }
  public invoke<T>(method: string, payload?: unknown): Promise<T> { const requestId = crypto.randomUUID(); window.parent.postMessage({ type: 'workbench-app-rpc', appId: 'terminal', requestId, method, payload }, '*'); return new Promise((resolve, reject) => this.pending.set(requestId, { resolve: resolve as (value: unknown) => void, reject })); }
  public resolveDroppedFiles(files: File[]): Promise<string[]> { const requestId = crypto.randomUUID(); window.parent.postMessage({ type: 'workbench-app-file-drop', appId: 'terminal', requestId, files }, '*'); return new Promise((resolve, reject) => this.pending.set(requestId, { resolve: resolve as (value: unknown) => void, reject })); }
  public readClipboardText(): Promise<string> { return this.invoke<string>('host.clipboard.readText'); }
  public writeClipboardText(text: string): Promise<void> { return this.invoke<void>('host.clipboard.writeText', { text }); }
  public onEvent(listener: (event: { event: string; payload: unknown }) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  public setKeyboardCapture(key: 'Tab', enabled: boolean): void { window.parent.postMessage({ type: 'workbench-app-keyboard-capture', appId: 'terminal', key, enabled }, '*'); }
  public onKeyboardInput(listener: (event: { key: 'Tab' }) => void) { this.keyboardListeners.add(listener); return () => { this.keyboardListeners.delete(listener); }; }
}
