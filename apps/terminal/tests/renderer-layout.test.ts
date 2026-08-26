import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const source = await readFile(new URL('../renderer/main.tsx', import.meta.url), 'utf8');

describe('SSH 终端页面布局', () => {
  it('不在内容区重复渲染应用名称，并保留连接操作', () => {
    expect(source).not.toContain('<strong>SSH 终端</strong>');
    expect(source).toContain('<span className="quick-connect-label">最近连接</span>');
    expect(source).toContain('管理连接');
  });
});
