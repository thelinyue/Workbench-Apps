// @vitest-environment happy-dom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const hostHarness = vi.hoisted(() => {
  const methods: string[] = [];
  return {
    methods,
    reset() { methods.splice(0); },
    invoke(method: string): unknown {
      methods.push(method);
      if (method === 'packages.list' || method === 'tasks.list' || method === 'results.recent') return [];
      if (method === 'settings.get') return { enabled: false, autoAnalyzeEnabled: true, scanIntervalSeconds: 10 };
      if (method === 'monitor.status') return { state: 'disabled' };
      if (method === 'analysis-rules.get-state') return { currentVersion: '1.0.0', source: 'bundled' };
      if (method === 'analysis-rules.update') return { status: 'up-to-date', previousVersion: '1.0.0', currentVersion: '1.0.0' };
      throw new Error(`未预期的应用 RPC：${method}`);
    }
  };
});

vi.mock('../renderer/host-api', () => ({
  AppHostClient: class {
    invoke<T>(method: string): Promise<T> { return Promise.resolve(hostHarness.invoke(method) as T); }
    onEvent(): () => void { return () => undefined; }
    resolveDroppedFiles(): Promise<string[]> { return Promise.resolve([]); }
  }
}));

import { AnalysisCenterApp } from '../renderer/view';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('分析中心独立规则更新 RPC', () => {
  afterEach(() => hostHarness.reset());

  it('加载状态并手动更新时不会调用宿主保留的 rules 命名空间', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    await act(async () => { root.render(createElement(AnalysisCenterApp)); });
    await act(async () => { await Promise.resolve(); });
    const updateButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '更新规则');
    expect(updateButton).toBeDefined();
    await act(async () => { updateButton?.click(); });

    expect(hostHarness.methods).toContain('analysis-rules.get-state');
    expect(hostHarness.methods).toContain('analysis-rules.update');
    expect(hostHarness.methods.every((method) => !method.startsWith('rules.'))).toBe(true);

    await act(async () => { root.unmount(); });
    container.remove();
  });
});
