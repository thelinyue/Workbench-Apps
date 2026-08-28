interface FocusControl { focus(): void; }
interface FocusScope { querySelectorAll(selectors: string): ArrayLike<unknown>; }
interface DialogDocument {
  readonly activeElement?: unknown;
  addEventListener(type: 'keydown', listener: (event: KeyboardEvent) => void): void;
  removeEventListener(type: 'keydown', listener: (event: KeyboardEvent) => void): void;
}

const FOCUSABLE_SELECTOR = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** 设置弹窗集中管理 Escape、焦点约束与触发器恢复，避免关闭路径之间出现键盘行为差异。 */
export function startDialogLifecycle({ document, scope, trigger, requestClose }: { document: DialogDocument; scope: FocusScope; trigger: FocusControl; requestClose: () => void }): () => void {
  const controls = () => Array.from(scope.querySelectorAll(FOCUSABLE_SELECTOR)).filter(isFocusControl);
  const handleKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { requestClose(); return; }
    if (event.key !== 'Tab') return;
    const focusable = controls();
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    const activeIndex = focusable.indexOf(document.activeElement as FocusControl);
    if (event.shiftKey && activeIndex <= 0) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (activeIndex === -1 || activeIndex === focusable.length - 1)) { event.preventDefault(); first.focus(); }
  };
  document.addEventListener('keydown', handleKeydown);
  controls()[0]?.focus();
  let cleaned = false;
  return () => {
    if (cleaned) return;
    cleaned = true;
    document.removeEventListener('keydown', handleKeydown);
    trigger.focus();
  };
}

function isFocusControl(value: unknown): value is FocusControl {
  return Boolean(value) && typeof (value as FocusControl).focus === 'function';
}
