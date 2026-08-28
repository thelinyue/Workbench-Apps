export type SplitPaneSide = 'left' | 'right';

export interface SplitPaneLayout {
  leftWidth: number;
  rightWidth: number;
  leftHidden: boolean;
  rightHidden: boolean;
}

interface LayoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const SPLIT_LAYOUT_STORAGE_KEY = 'terminal.workspace.split-layout.v1';
export const LEFT_PANE_MIN = 200;
export const LEFT_PANE_MAX = 420;
export const RIGHT_PANE_MIN = 320;
export const RIGHT_PANE_MAX = 560;
export const TERMINAL_PANE_MIN = 480;
export const SPLITTER_SIZE = 6;
export const COMPACT_LAYOUT_WIDTH = 1280;

/**
 * 根据当前窗口生成侧栏初始比例。这里只定义首次打开的起点，用户拖拽后的值由本地布局记录恢复，
 * 因此侧栏不是固定轨道；窄窗口默认收起文件抽屉，避免启动时遮挡 Terminal。
 */
export function createDefaultSplitLayout(viewportWidth: number): SplitPaneLayout {
  return {
    leftWidth: clamp(Math.round(viewportWidth * 0.19), LEFT_PANE_MIN, LEFT_PANE_MAX),
    rightWidth: clamp(Math.round(viewportWidth * 0.33), RIGHT_PANE_MIN, RIGHT_PANE_MAX),
    leftHidden: false,
    rightHidden: viewportWidth < COMPACT_LAYOUT_WIDTH
  };
}

/**
 * 调整单侧宽度时，除侧栏自身上下限外，还必须为 Terminal 和分隔线预留空间。
 * 紧凑布局中的文件区是覆盖式抽屉，不参与左侧栏的宽度计算。
 */
export function resizePane(
  layout: SplitPaneLayout,
  side: SplitPaneSide,
  requestedWidth: number,
  availableWidth: number,
  compact: boolean
): SplitPaneLayout {
  const otherWidth = compact
    ? 0
    : side === 'left'
      ? (layout.rightHidden ? 0 : layout.rightWidth)
      : (layout.leftHidden ? 0 : layout.leftWidth);
  const splitterCount = compact ? 1 : 2;
  const availableForPane = availableWidth - otherWidth - TERMINAL_PANE_MIN - splitterCount * SPLITTER_SIZE;
  const minimum = side === 'left' ? LEFT_PANE_MIN : RIGHT_PANE_MIN;
  const maximum = Math.min(side === 'left' ? LEFT_PANE_MAX : RIGHT_PANE_MAX, Math.max(minimum, availableForPane));
  const width = clamp(requestedWidth, minimum, maximum);
  return side === 'left' ? { ...layout, leftWidth: width } : { ...layout, rightWidth: width };
}

/** 方向键移动的是分隔线本身，因此右侧分隔线向右移动时右侧栏会变窄。 */
export function getKeyboardPaneWidth(side: SplitPaneSide, currentWidth: number, key: string, shiftKey: boolean): number | undefined {
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return undefined;
  const step = shiftKey ? 40 : 16;
  const separatorDirection = key === 'ArrowRight' ? 1 : -1;
  return currentWidth + separatorDirection * step * (side === 'left' ? 1 : -1);
}

/** 读取失败或字段不完整时使用当前窗口默认值，避免损坏的 localStorage 破坏工作区布局。 */
export function loadSplitLayout(storage: LayoutStorage, viewportWidth: number): SplitPaneLayout {
  const fallback = createDefaultSplitLayout(viewportWidth);
  try {
    const raw = storage.getItem(SPLIT_LAYOUT_STORAGE_KEY);
    if (!raw) return fallback;
    const value = JSON.parse(raw) as Partial<SplitPaneLayout>;
    if (!Number.isFinite(value.leftWidth) || !Number.isFinite(value.rightWidth)
      || typeof value.leftHidden !== 'boolean' || typeof value.rightHidden !== 'boolean') return fallback;
    return {
      leftWidth: clamp(Number(value.leftWidth), LEFT_PANE_MIN, LEFT_PANE_MAX),
      rightWidth: clamp(Number(value.rightWidth), RIGHT_PANE_MIN, RIGHT_PANE_MAX),
      leftHidden: value.leftHidden,
      rightHidden: value.rightHidden
    };
  } catch {
    return fallback;
  }
}

export function saveSplitLayout(storage: LayoutStorage, layout: SplitPaneLayout): void {
  storage.setItem(SPLIT_LAYOUT_STORAGE_KEY, JSON.stringify(layout));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
