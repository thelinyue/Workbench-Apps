import { describe, expect, it, vi } from 'vitest';
import { createEvidenceDrawerController, getEvidencePresentation, startEvidenceDrawerLifecycle } from '../renderer/evidence-drawer';

class FakeDocument {
  public readonly body = { style: { overflow: 'auto' } };
  public readonly listeners = new Set<(event: KeyboardEvent) => void>();
  public activeElement: unknown;

  public addEventListener(type: string, listener: (event: KeyboardEvent) => void) {
    if (type === 'keydown') this.listeners.add(listener);
  }

  public removeEventListener(type: string, listener: (event: KeyboardEvent) => void) {
    if (type === 'keydown') this.listeners.delete(listener);
  }

  public keydown(key: string, shiftKey = false) {
    const preventDefault = vi.fn();
    this.listeners.forEach((listener) => listener({ key, shiftKey, preventDefault } as unknown as KeyboardEvent));
    return preventDefault;
  }
}

class FakeFocusControl {
  public readonly focus = vi.fn(() => { this.document.activeElement = this; });
  public constructor(private readonly document: FakeDocument) {}
}

class FakeFocusScope {
  public constructor(private readonly controls: FakeFocusControl[]) {}
  public querySelectorAll(): ArrayLike<FakeFocusControl> { return this.controls; }
}

describe('诊断证据响应式呈现', () => {
  it.each([
    [1200, 'panel'],
    [1100, 'panel'],
    [1099, 'drawer'],
    [800, 'drawer']
  ] as const)('%dpx 使用 %s', (width, expected) => {
    expect(getEvidencePresentation(width)).toBe(expected);
  });
});

describe('诊断证据 Drawer 生命周期', () => {
  it('打开时聚焦关闭按钮并锁定滚动，Escape 关闭后恢复精确触发器和原 overflow', () => {
    const document = new FakeDocument();
    const closeControl = { focus: vi.fn() };
    const exactTrigger = { focus: vi.fn() };
    const requestClose = vi.fn();

    const cleanup = startEvidenceDrawerLifecycle({
      document,
      closeControl,
      trigger: exactTrigger,
      requestClose
    });

    expect(closeControl.focus).toHaveBeenCalledOnce();
    expect(document.body.style.overflow).toBe('hidden');
    expect(document.listeners).toHaveLength(1);

    document.keydown('Enter');
    expect(requestClose).not.toHaveBeenCalled();
    document.keydown('Escape');
    expect(requestClose).toHaveBeenCalledOnce();

    cleanup();
    expect(document.body.style.overflow).toBe('auto');
    expect(exactTrigger.focus).toHaveBeenCalledOnce();
    expect(document.listeners).toHaveLength(0);
  });

  it('卸载清理可重复执行，且只恢复一次焦点和滚动状态', () => {
    const document = new FakeDocument();
    const trigger = { focus: vi.fn() };
    const cleanup = startEvidenceDrawerLifecycle({
      document,
      closeControl: { focus: vi.fn() },
      trigger,
      requestClose: vi.fn()
    });

    cleanup();
    cleanup();

    expect(trigger.focus).toHaveBeenCalledOnce();
    expect(document.body.style.overflow).toBe('auto');
    expect(document.listeners).toHaveLength(0);
  });

  it('Tab 从末项回到首项，Shift+Tab 从首项回到末项', () => {
    const document = new FakeDocument();
    const first = new FakeFocusControl(document);
    const last = new FakeFocusControl(document);
    const cleanup = startEvidenceDrawerLifecycle({
      document,
      closeControl: first,
      focusScope: new FakeFocusScope([first, last]),
      trigger: { focus: vi.fn() },
      requestClose: vi.fn()
    });

    document.activeElement = last;
    const forward = document.keydown('Tab');
    expect(forward).toHaveBeenCalledOnce();
    expect(first.focus).toHaveBeenCalledTimes(2);

    document.activeElement = first;
    const backward = document.keydown('Tab', true);
    expect(backward).toHaveBeenCalledOnce();
    expect(last.focus).toHaveBeenCalledOnce();
    cleanup();
  });

  it('焦点位于 Drawer 外时，正反向 Tab 都不会进入背景控件', () => {
    const document = new FakeDocument();
    const first = new FakeFocusControl(document);
    const last = new FakeFocusControl(document);
    const cleanup = startEvidenceDrawerLifecycle({
      document,
      closeControl: first,
      focusScope: new FakeFocusScope([first, last]),
      trigger: { focus: vi.fn() },
      requestClose: vi.fn()
    });

    document.activeElement = { background: true };
    expect(document.keydown('Tab')).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(first);

    document.activeElement = { background: true };
    expect(document.keydown('Tab', true)).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(last);
    cleanup();
  });

  it('toolbar 与 why 两个触发器都进入 Drawer，并分别保留精确触发器', () => {
    const changed = vi.fn();
    const toolbarTrigger = { focus: vi.fn() };
    const whyTrigger = { focus: vi.fn() };
    const controller = createEvidenceDrawerController('drawer', changed);

    expect(controller.open(toolbarTrigger)).toBe(true);
    expect(controller.getState()).toMatchObject({ open: true, trigger: toolbarTrigger });
    controller.close();

    expect(controller.open(whyTrigger)).toBe(true);
    expect(controller.getState()).toMatchObject({ open: true, trigger: whyTrigger });
    expect(changed).toHaveBeenCalledTimes(3);
  });

  it('backdrop 与关闭按钮共用 close 状态迁移', () => {
    const controller = createEvidenceDrawerController('drawer', vi.fn());
    const closeFromBackdrop = controller.close;
    const closeFromButton = controller.close;

    controller.open({ focus: vi.fn() });
    closeFromBackdrop();
    expect(controller.getState().open).toBe(false);

    controller.open({ focus: vi.fn() });
    closeFromButton();
    expect(controller.getState().open).toBe(false);
    expect(closeFromBackdrop).toBe(closeFromButton);
  });

  it('Drawer 打开后切换为 panel 会关闭并立即执行生命周期 cleanup', () => {
    const document = new FakeDocument();
    const trigger = { focus: vi.fn() };
    const controller = createEvidenceDrawerController('drawer', vi.fn());
    controller.open(trigger);
    controller.attachLifecycle(document, { focus: vi.fn() });

    expect(document.body.style.overflow).toBe('hidden');
    controller.setPresentation('panel');

    expect(controller.getState()).toMatchObject({ presentation: 'panel', open: false });
    expect(document.body.style.overflow).toBe('auto');
    expect(document.listeners).toHaveLength(0);
    expect(trigger.focus).toHaveBeenCalledOnce();
  });
});
