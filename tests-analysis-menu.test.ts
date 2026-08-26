import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('分析中心列表快捷菜单', () => {
  const source = readFileSync(resolve(process.cwd(), 'apps/analysis-center/renderer/view.tsx'), 'utf8');
  const style = readFileSync(resolve(process.cwd(), 'apps/analysis-center/renderer/style.css'), 'utf8');

  it('用显式的更多操作入口承载低频文件操作', () => {
    expect(source).toContain('MoreHorizontal');
    expect(source).toContain('role="menu"');
    expect(source).toContain('role="menuitem"');
    expect(source).toContain("packages.locate-source");
    expect(source).toContain("packages.locate-extract");
    expect(source).toContain("host.showItemInFolder");
    expect(source).toContain('aria-label={`打开${item.displayName}的更多操作`}');
  });

  it('右键只是兼容触发方式，不屏蔽系统右键且不再提示右键查看更多', () => {
    expect(source).toContain('onContextMenu');
    expect(source).not.toContain('onContextMenu={(event) => event.preventDefault()}');
    expect(source).not.toContain('右键查看更多');
    expect(style).toContain('.overflow-menu');
  });
});
