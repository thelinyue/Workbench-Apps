import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const source = await readFile(new URL('../renderer/view.tsx', import.meta.url), 'utf8');

describe('分析任务失败提示', () => {
  it('读取任务记录并按诊断包关联最近失败原因', () => {
    expect(source).toContain("host.invoke<TaskItem[]>('tasks.list')");
    expect(source).toContain('failureByPackageId');
    expect(source).toContain("task.status === 'failed'");
  });

  it('在诊断包列表中展示持久化的中文错误信息', () => {
    expect(source).toContain('failureByPackageId?.get(item.id)');
    expect(source).toContain('errorMessage');
  });
});
