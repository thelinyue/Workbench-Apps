import { useRef } from 'react';
import { getKeyboardPaneWidth, type SplitPaneSide } from './split-pane-layout';

interface SplitPaneHandleProps {
  side: SplitPaneSide;
  value: number;
  minimum: number;
  maximum: number;
  onResize(value: number): void;
}

interface DragStart {
  pointerId: number;
  clientX: number;
  width: number;
}

/**
 * 左右侧栏共用的可访问分隔线。
 * Pointer Capture 保证指针离开细分隔线后仍能连续拖拽；键盘方向键与视觉上的分隔线移动方向一致。
 */
export function SplitPaneHandle({ side, value, minimum, maximum, onResize }: SplitPaneHandleProps) {
  const dragStart = useRef<DragStart | undefined>(undefined);
  const label = side === 'left' ? '调整设备栏宽度' : '调整文件栏宽度';

  return <div
    className={`split-pane-handle ${side}`}
    role="separator"
    aria-label={label}
    aria-orientation="vertical"
    aria-valuemin={minimum}
    aria-valuemax={maximum}
    aria-valuenow={Math.round(value)}
    tabIndex={0}
    title={`${label}，可拖拽或使用方向键`}
    onPointerDown={(event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      dragStart.current = { pointerId: event.pointerId, clientX: event.clientX, width: value };
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={(event) => {
      const start = dragStart.current;
      if (!start || start.pointerId !== event.pointerId) return;
      const separatorDelta = event.clientX - start.clientX;
      onResize(start.width + separatorDelta * (side === 'left' ? 1 : -1));
    }}
    onPointerUp={(event) => {
      if (dragStart.current?.pointerId !== event.pointerId) return;
      dragStart.current = undefined;
      event.currentTarget.releasePointerCapture(event.pointerId);
    }}
    onPointerCancel={() => { dragStart.current = undefined; }}
    onKeyDown={(event) => {
      const nextWidth = getKeyboardPaneWidth(side, value, event.key, event.shiftKey);
      if (nextWidth === undefined) return;
      event.preventDefault();
      onResize(nextWidth);
    }}
  ><span aria-hidden="true" /></div>;
}
