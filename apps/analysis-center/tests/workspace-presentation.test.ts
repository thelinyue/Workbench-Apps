import { describe, expect, it } from 'vitest';
import { formatFileSize, getAnalysisStageItems, getNotificationActivation, getPackageTone, getWorkspaceGroups } from '../renderer/workspace-presentation';

describe('分析中心工作区呈现', () => {
  it('把成功和失败统一放入最近分析，待分析与活动任务保持独立', () => {
    const packages = [
      { id: 'pending', status: 'pending', detectedAt: '2026-08-28T10:00:00Z' },
      { id: 'failed', status: 'failed', detectedAt: '2026-08-28T12:00:00Z' },
      { id: 'success', status: 'report-ready', detectedAt: '2026-08-28T11:00:00Z' },
      { id: 'running', status: 'running', detectedAt: '2026-08-28T09:00:00Z' }
    ] as const;

    expect(getWorkspaceGroups(packages)).toEqual({
      pending: [packages[0]],
      recent: [packages[1], packages[2]]
    });
  });

  it('格式化诊断包大小，旧数据缺少大小时显示横线', () => {
    expect(formatFileSize(undefined)).toBe('—');
    expect(formatFileSize(1_536)).toBe('1.5 KB');
    expect(formatFileSize(2 * 1024 * 1024)).toBe('2 MB');
  });

  it('已生成报告时仍按诊断严重度显示状态色，失败始终使用危险色', () => {
    expect(getPackageTone('report-ready', 'critical')).toBe('danger');
    expect(getPackageTone('report-ready', 'warning')).toBe('warning');
    expect(getPackageTone('report-ready', 'info')).toBe('success');
    expect(getPackageTone('failed')).toBe('danger');
    expect(getPackageTone('pending')).toBe('default');
  });

  it('按稳定阶段枚举呈现五阶段状态，不依赖中文进度消息', () => {
    expect(getAnalysisStageItems('analyze-storage')).toEqual([
      { id: 'identify-package', label: '识别诊断包', state: 'complete' },
      { id: 'parse-system-events', label: '解析系统事件', state: 'complete' },
      { id: 'analyze-storage', label: '分析存储状态', state: 'current' },
      { id: 'aggregate-anomalies', label: '聚合异常', state: 'pending' },
      { id: 'form-conclusion', label: '形成诊断结论', state: 'pending' }
    ]);
  });

  it('只接受宿主通知激活事件，并保留结果或失败定位参数', () => {
    expect(getNotificationActivation({ appId: 'analysis-center', event: 'host.notification.activated', payload: { kind: 'result', packageId: 'package-1' } })).toEqual({ kind: 'result', packageId: 'package-1' });
    expect(getNotificationActivation({ appId: 'analysis-center', event: 'host.notification.activated', payload: { kind: 'failure', packageId: 'package-2' } })).toEqual({ kind: 'failure', packageId: 'package-2' });
    expect(getNotificationActivation({ appId: 'analysis-center', event: 'packages.changed', payload: { kind: 'result', packageId: 'package-1' } })).toBeUndefined();
    expect(getNotificationActivation({ appId: 'analysis-center', event: 'host.notification.activated', payload: { kind: 'forged', packageId: 'package-1' } })).toBeUndefined();
  });
});
