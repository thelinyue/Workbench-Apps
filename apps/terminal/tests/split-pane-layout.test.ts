import { describe, expect, it } from 'vitest';
import {
  createDefaultSplitLayout,
  getKeyboardPaneWidth,
  loadSplitLayout,
  resizePane
} from '../renderer/split-pane-layout';

describe('SSH 工作区 Split Pane 布局', () => {
  it('按窗口比例生成宽屏布局，并在窄窗口默认收起文件抽屉', () => {
    expect(createDefaultSplitLayout(1440)).toEqual({
      leftWidth: 274,
      rightWidth: 475,
      leftHidden: false,
      rightHidden: false
    });
    expect(createDefaultSplitLayout(960)).toEqual({
      leftWidth: 200,
      rightWidth: 320,
      leftHidden: false,
      rightHidden: true
    });
  });

  it('拖拽侧栏时同时遵守侧栏范围和 Terminal 最小宽度', () => {
    const layout = { leftWidth: 274, rightWidth: 475, leftHidden: false, rightHidden: false };

    expect(resizePane(layout, 'left', 600, 1440, false).leftWidth).toBe(420);
    expect(resizePane(layout, 'left', 40, 1440, false).leftWidth).toBe(200);
    expect(resizePane(layout, 'right', 560, 1280, false).rightWidth).toBe(514);
    expect(resizePane(layout, 'left', 400, 960, true).leftWidth).toBe(400);
  });

  it('方向键按分隔线移动方向调整左右侧栏', () => {
    expect(getKeyboardPaneWidth('left', 274, 'ArrowRight', false)).toBe(290);
    expect(getKeyboardPaneWidth('left', 274, 'ArrowLeft', true)).toBe(234);
    expect(getKeyboardPaneWidth('right', 475, 'ArrowRight', false)).toBe(459);
    expect(getKeyboardPaneWidth('right', 475, 'ArrowLeft', true)).toBe(515);
    expect(getKeyboardPaneWidth('left', 274, 'Enter', false)).toBeUndefined();
  });

  it('恢复本地布局时拒绝损坏数据并规范越界宽度', () => {
    const malformedStorage = { getItem: () => '{broken', setItem: () => undefined };
    const savedStorage = {
      getItem: () => JSON.stringify({ leftWidth: 999, rightWidth: 12, leftHidden: true, rightHidden: false }),
      setItem: () => undefined
    };

    expect(loadSplitLayout(malformedStorage, 1440)).toEqual(createDefaultSplitLayout(1440));
    expect(loadSplitLayout(savedStorage, 1440)).toEqual({
      leftWidth: 420,
      rightWidth: 320,
      leftHidden: true,
      rightHidden: false
    });
  });
});
