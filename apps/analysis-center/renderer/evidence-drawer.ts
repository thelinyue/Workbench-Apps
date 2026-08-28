export type EvidencePresentation = 'panel' | 'drawer';

export interface FocusControl {
  focus(): void;
}

export interface FocusScope {
  querySelectorAll(selectors: string): ArrayLike<unknown>;
}

interface DrawerLifecycleDocument {
  body: { style: { overflow: string } };
  readonly activeElement?: unknown;
  addEventListener(type: 'keydown', listener: (event: KeyboardEvent) => void): void;
  removeEventListener(type: 'keydown', listener: (event: KeyboardEvent) => void): void;
}

export interface EvidenceDrawerState {
  presentation: EvidencePresentation;
  open: boolean;
  trigger?: FocusControl;
}

export interface EvidenceDrawerController {
  getState(): EvidenceDrawerState;
  open(trigger: FocusControl): boolean;
  close(): void;
  setPresentation(presentation: EvidencePresentation): void;
  attachLifecycle(document: DrawerLifecycleDocument, closeControl: FocusControl, focusScope?: FocusScope): () => void;
}

const FOCUSABLE_CONTROL_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

/** 原生窗口最小宽度为 800px，因此 1100px 是结果页唯一需要维护的产品断点。 */
export function getEvidencePresentation(viewportWidth: number): EvidencePresentation {
  return viewportWidth >= 1100 ? 'panel' : 'drawer';
}

/**
 * 管理证据 Drawer 与全局文档之间的生命周期边界。
 * cleanup 同时服务于主动关闭、断点切换和组件卸载，并保持幂等，避免重复恢复焦点。
 */
export function startEvidenceDrawerLifecycle({
  document,
  closeControl,
  focusScope,
  trigger,
  requestClose
}: {
  document: DrawerLifecycleDocument;
  closeControl: FocusControl;
  focusScope?: FocusScope;
  trigger: FocusControl;
  requestClose: () => void;
}): () => void {
  const previousOverflow = document.body.style.overflow;
  let cleaned = false;
  const handleKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      requestClose();
      return;
    }
    if (event.key !== 'Tab') return;

    const focusableControls = Array.from(focusScope?.querySelectorAll(FOCUSABLE_CONTROL_SELECTOR) ?? [])
      .filter(isFocusControl);
    if (focusableControls.length === 0) focusableControls.push(closeControl);
    const first = focusableControls[0]!;
    const last = focusableControls[focusableControls.length - 1]!;
    const activeIndex = focusableControls.indexOf(document.activeElement as FocusControl);
    const movingBeforeFirst = event.shiftKey && activeIndex <= 0;
    const movingAfterLast = !event.shiftKey && (activeIndex === -1 || activeIndex === focusableControls.length - 1);
    if (!movingBeforeFirst && !movingAfterLast) return;

    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  };

  document.body.style.overflow = 'hidden';
  document.addEventListener('keydown', handleKeydown);
  closeControl.focus();

  return () => {
    if (cleaned) return;
    cleaned = true;
    document.removeEventListener('keydown', handleKeydown);
    document.body.style.overflow = previousOverflow;
    trigger.focus();
  };
}

/**
 * 统一管理 toolbar、why、backdrop、关闭按钮与断点切换的 Drawer 状态。
 * 控制器持有本次精确触发器，并主动执行已挂载的生命周期 cleanup，避免关闭原因之间行为分叉。
 */
export function createEvidenceDrawerController(
  initialPresentation: EvidencePresentation,
  onChange: (state: EvidenceDrawerState) => void
): EvidenceDrawerController {
  let state: EvidenceDrawerState = { presentation: initialPresentation, open: false };
  let lifecycleCleanup: (() => void) | undefined;

  const publish = (nextState: EvidenceDrawerState) => {
    state = nextState;
    onChange(state);
  };

  const close = () => {
    if (!state.open) return;
    lifecycleCleanup?.();
    lifecycleCleanup = undefined;
    publish({ ...state, open: false });
  };

  return {
    getState: () => state,
    open(trigger) {
      if (state.presentation !== 'drawer') return false;
      publish({ ...state, open: true, trigger });
      return true;
    },
    close,
    setPresentation(presentation) {
      if (presentation === state.presentation) return;
      if (presentation === 'panel' && state.open) {
        lifecycleCleanup?.();
        lifecycleCleanup = undefined;
      }
      publish({ ...state, presentation, open: presentation === 'drawer' && state.open });
    },
    attachLifecycle(document, closeControl, focusScope) {
      if (!state.open || !state.trigger) return () => undefined;
      const cleanup = startEvidenceDrawerLifecycle({ document, closeControl, focusScope, trigger: state.trigger, requestClose: close });
      lifecycleCleanup = cleanup;
      return () => {
        if (lifecycleCleanup === cleanup) lifecycleCleanup = undefined;
        cleanup();
      };
    }
  };
}

function isFocusControl(value: unknown): value is FocusControl {
  return Boolean(value) && typeof (value as FocusControl).focus === 'function';
}
