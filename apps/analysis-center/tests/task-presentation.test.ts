import { describe, expect, it } from 'vitest';
import { formatElapsed, getQueuePosition, isOutsideOverflowMenu } from '../renderer/task-presentation';

describe('分析任务呈现', () => {
  it('排队任务只统计创建时间更早的未完成任务', () => {
    expect(getQueuePosition('task-b', [
      { id: 'task-c', status: 'queued', createdAt: '2026-08-27T10:03:00.000Z' },
      { id: 'task-b', status: 'queued', createdAt: '2026-08-27T10:02:00.000Z' },
      { id: 'task-a', status: 'running', createdAt: '2026-08-27T10:01:00.000Z' },
      { id: 'task-done', status: 'succeeded', createdAt: '2026-08-27T10:00:00.000Z' }
    ])).toBe(1);
  });

  it('将运行时长格式化为用户可读的中文时间', () => {
    expect(formatElapsed('2026-08-27T10:00:00.000Z', Date.parse('2026-08-27T10:01:05.000Z'))).toBe('已用时 1 分 5 秒');
  });

  it('只有点击菜单和触发按钮以外的空白区域才关闭更多操作菜单', () => {
    const menuTarget = {};
    const triggerTarget = {};
    const outsideTarget = {};
    const menu = { contains: (target: unknown) => target === menuTarget };
    const trigger = { contains: (target: unknown) => target === triggerTarget };

    expect(isOutsideOverflowMenu(menuTarget, menu, trigger)).toBe(false);
    expect(isOutsideOverflowMenu(triggerTarget, menu, trigger)).toBe(false);
    expect(isOutsideOverflowMenu(outsideTarget, menu, trigger)).toBe(true);
  });
});
