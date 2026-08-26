import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const viewSource = await readFile(new URL('../renderer/view.tsx', import.meta.url), 'utf8');
const styleSource = await readFile(new URL('../renderer/style.css', import.meta.url), 'utf8');

describe('分析中心单列表布局', () => {
  it('将操作置于诊断包标题右侧，且不再渲染统计和任务区', () => {
    expect(viewSource).toContain('className="analysis-list-heading"');
    expect(viewSource).toContain('className="analysis-list-actions"');
    expect(viewSource).not.toContain('className="summary"');
    expect(viewSource).not.toContain('className="tasks"');
    expect(styleSource).toContain('.analysis-app { min-height: 100vh;');
    expect(styleSource).not.toContain('.content { margin-top: 18px; align-items: flex-start; }');
  });

  it('将设置渲染为按需浮层，目录改由宿主选择并可移除', () => {
    expect(viewSource).toContain("host.invoke<string[]>('host.chooseDirectory')");
    expect(viewSource).toContain('选择监控目录');
    expect(viewSource).toContain('移除监控目录');
    expect(viewSource).toContain('className="analysis-settings-popover"');
    expect(viewSource).toContain("command === 'settings.open'");
  });

  it('在窄屏中用左右边距约束设置浮层，避免固定宽度溢出视口', () => {
    expect(styleSource).toContain('.analysis-settings-popover { top: 12px; right: 12px; left: 12px; width: auto;');
  });
});
