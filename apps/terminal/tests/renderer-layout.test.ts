import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const source = await readFile(new URL('../renderer/main.tsx', import.meta.url), 'utf8');
const styles = await readFile(new URL('../renderer/style.css', import.meta.url), 'utf8');

describe('SSH 终端页面布局', () => {
  it('使用独立窗口工作区组件且不在内容区重复渲染应用名称', () => {
    expect(source).not.toContain('<strong>SSH 终端</strong>');
    expect(source).not.toContain('创建新的 SSH 连接');
    expect(source).toContain('<DeviceSidebar');
    expect(source).toContain('<TerminalWorkspace');
    expect(source).toContain('<SplitPaneHandle');
    expect(source).toContain('<FilePanel');
    expect(source).toContain('<TransferTaskPopover');
    expect(source).toContain('<ConnectionDialog');
    expect(source).toContain('<HostKeyDialog');
  });

  it('在窄窗口把文件区切换为右侧抽屉并保留终端弹性轨道', () => {
    expect(styles).toContain('.file-drawer-scrim { display: none; }');
    expect(styles).toContain('@media (max-width: 1279px)');
    expect(styles).toContain('.file-drawer-scrim { display: block; position: absolute;');
    expect(styles).toContain('grid-template-columns: var(--left-pane-width) 6px minmax(0, 1fr)');
    expect(styles).toContain('.workspace-body.left-pane-hidden');
    expect(styles).toContain('.file-panel.is-open');
    expect(styles).toContain('transform: translateX(0)');
  });

  it('文件列表占满文件侧栏的剩余高度', () => {
    expect(styles).toMatch(/\.file-list \{[^}]*grid-row: 6;[^}]*height: 100%;[^}]*overflow: auto;/);
    expect(styles).toMatch(/\.file-list > \.panel-empty \{[^}]*position: absolute;[^}]*inset: 0;/);
  });

  it('新建连接弹窗紧凑重排并完整展示默认表单', () => {
    expect(styles).toMatch(/\.connection-dialog \{[^}]*width: min\(620px, calc\(100vw - 32px\)\);[^}]*max-height: calc\(100vh - 32px\);/);
    expect(styles).toMatch(/\.dialog-scroll \{[^}]*overflow: visible;/);
    expect(styles).toMatch(/\.form-options-grid \{[^}]*grid-template-columns: 1fr 1fr;/);
  });
});
