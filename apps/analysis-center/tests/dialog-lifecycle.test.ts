import { describe, expect, it, vi } from 'vitest';
import { startDialogLifecycle } from '../renderer/dialog-lifecycle';

class FakeDocument {
  public activeElement: unknown;
  public readonly listeners = new Set<(event: KeyboardEvent) => void>();
  public addEventListener(_type: 'keydown', listener: (event: KeyboardEvent) => void) { this.listeners.add(listener); }
  public removeEventListener(_type: 'keydown', listener: (event: KeyboardEvent) => void) { this.listeners.delete(listener); }
  public keydown(key: string, shiftKey = false) {
    const preventDefault = vi.fn();
    this.listeners.forEach((listener) => listener({ key, shiftKey, preventDefault } as unknown as KeyboardEvent));
    return preventDefault;
  }
}

function focusControl(document: FakeDocument) {
  const control = { focus: vi.fn(() => { document.activeElement = control; }) };
  return control;
}

describe('设置弹窗焦点生命周期', () => {
  it('打开时聚焦首控件，Escape 关闭，清理后恢复触发器焦点', () => {
    const document = new FakeDocument();
    const first = focusControl(document);
    const trigger = focusControl(document);
    const close = vi.fn();
    const cleanup = startDialogLifecycle({ document, scope: { querySelectorAll: () => [first] }, trigger, requestClose: close });

    expect(first.focus).toHaveBeenCalledOnce();
    document.keydown('Escape');
    expect(close).toHaveBeenCalledOnce();
    cleanup();
    expect(trigger.focus).toHaveBeenCalledOnce();
  });

  it('Tab 和 Shift+Tab 不会把焦点移到弹窗外', () => {
    const document = new FakeDocument();
    const first = focusControl(document);
    const last = focusControl(document);
    const cleanup = startDialogLifecycle({ document, scope: { querySelectorAll: () => [first, last] }, trigger: focusControl(document), requestClose: vi.fn() });

    document.activeElement = last;
    expect(document.keydown('Tab')).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(first);
    document.activeElement = first;
    expect(document.keydown('Tab', true)).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(last);
    cleanup();
  });
});
