import { describe, expect, it } from 'vitest';
import { formatElapsed, getAnalysisRuntimePresentation, getLatestRuntimeTimingsByPackageId, getQueuePosition, isOutsideOverflowMenu, type AnalysisRuntimeTimingsView } from '../renderer/task-presentation';

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

  it('展示总用时和六个阶段的中文耗时明细', () => {
    expect(getAnalysisRuntimePresentation({
      archiveValidationMs: 24_740,
      archiveExtractionMs: 36_016,
      sourceInventoryMs: 11,
      sourceReadMs: 348,
      pipelineAnalysisMs: 493,
      reportRenderMs: 1,
      totalMs: 61_610
    })).toEqual({
      total: '分析用时 1 分 1.6 秒',
      detail: '总用时 1 分 1.6 秒 · 完整性校验 24.7 秒 · 完整解压 36 秒 · 文件遍历 11 毫秒 · 日志读取 348 毫秒 · 解析与规则分析 493 毫秒 · 报告生成 1 毫秒'
    });
    expect(getAnalysisRuntimePresentation(undefined)).toBeUndefined();
  });

  it('每个诊断包只采用最新终态任务的用时记录', () => {
    const older = runtimeTimings(2_000);
    const latest = runtimeTimings(3_000);
    const byPackageId = getLatestRuntimeTimingsByPackageId([
      { packageId: 'package-1', status: 'succeeded', createdAt: '2026-08-31T10:00:00Z', runtimeTimings: older },
      { packageId: 'package-2', status: 'running', createdAt: '2026-08-31T10:02:00Z', runtimeTimings: runtimeTimings(4_000) },
      { packageId: 'package-1', status: 'failed', createdAt: '2026-08-31T10:01:00Z', runtimeTimings: latest },
      { packageId: 'package-3', status: 'succeeded', createdAt: '2026-08-31T10:00:00Z', runtimeTimings: runtimeTimings(5_000) },
      { packageId: 'package-3', status: 'failed', createdAt: '2026-08-31T10:03:00Z' }
    ]);

    expect(byPackageId.get('package-1')).toBe(latest);
    expect(byPackageId.has('package-2')).toBe(false);
    expect(byPackageId.has('package-3')).toBe(false);
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

function runtimeTimings(totalMs: number): AnalysisRuntimeTimingsView {
  return {
    archiveValidationMs: 100,
    archiveExtractionMs: 200,
    sourceInventoryMs: 300,
    sourceReadMs: 400,
    pipelineAnalysisMs: 500,
    reportRenderMs: 600,
    totalMs
  };
}
