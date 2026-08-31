import { describe, expect, it } from 'vitest';
import { formatFileSize, getAnalysisStageItems, getNextRecentPackageSelection, getNotificationActivation, getPackageDeletionConfirmation, getPackageRecordDeletionConfirmation, getPackageTone, getRecentAnalysisPackageIds, getRecentAnalysisPresentation, getWorkspaceGroups, shouldShowSysinfoReport } from '../renderer/workspace-presentation';

describe('分析中心工作区呈现', () => {
  it('最近分析批量选择只覆盖已完成或失败的诊断包，并支持再次点击全选清空', () => {
    const packages = [
      { id: 'failed', status: 'failed' },
      { id: 'success', status: 'report-ready' },
      { id: 'pending', status: 'pending' },
      { id: 'running', status: 'running' }
    ] as const;

    expect(getRecentAnalysisPackageIds(packages)).toEqual(['failed', 'success']);
    expect(getNextRecentPackageSelection(packages, [])).toEqual(['failed', 'success']);
    expect(getNextRecentPackageSelection(packages, ['failed', 'success'])).toEqual([]);
  });

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

  it('最近分析按最近一次终态完成时间排序，没有分析时间时回退到导入时间', () => {
    const packages = [
      { id: 'imported-late', status: 'report-ready', detectedAt: '2026-08-28T12:00:00Z', lastAnalysisAt: '2026-08-28T12:30:00Z' },
      { id: 'reanalyzed', status: 'report-ready', detectedAt: '2026-08-28T09:00:00Z', lastAnalysisAt: '2026-08-28T13:00:00Z' },
      { id: 'failed', status: 'failed', detectedAt: '2026-08-28T11:00:00Z', lastAnalysisAt: '2026-08-28T14:00:00Z' },
      { id: 'legacy', status: 'report-ready', detectedAt: '2026-08-28T10:00:00Z' }
    ] as const;

    expect(getWorkspaceGroups(packages)).toEqual({
      pending: [],
      recent: [packages[2], packages[1], packages[0], packages[3]]
    });
  });

  it('ZIP 诊断包不显示完整 sysinfo，TGZ 诊断包保留入口', () => {
    expect(shouldShowSysinfoReport('D:/Inbox/NAS_SERVER_LOG_DEVICE.ZIP')).toBe(false);
    expect(shouldShowSysinfoReport('D:/Inbox/device.tgz')).toBe(true);
    expect(shouldShowSysinfoReport('D:/Inbox/device.tgz.temp')).toBe(true);
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

  it('正常完成且没有主要诊断时明确显示未发现异常', () => {
    expect(getRecentAnalysisPresentation({
      status: 'report-ready',
      displayName: 'healthy.tgz',
      result: { diagnoses: [] }
    })).toEqual({ title: '未发现明确异常', detail: 'healthy.tgz', severity: 'info' });
  });

  it('有主要诊断时显示诊断标题和严重程度', () => {
    expect(getRecentAnalysisPresentation({
      status: 'report-ready',
      displayName: 'fault.tgz',
      result: { diagnoses: [{ title: '硬盘 2 掉盘且 RAID 已降级', severity: 'critical' }] }
    })).toEqual({ title: '硬盘 2 掉盘且 RAID 已降级', detail: 'fault.tgz', severity: 'critical' });
  });

  it('分析失败时显示失败原因并使用严重样式', () => {
    expect(getRecentAnalysisPresentation({
      status: 'failed',
      displayName: 'failed.tgz',
      failureMessage: '诊断包无法解压。'
    })).toEqual({ title: '分析失败', detail: '诊断包无法解压。', severity: 'critical' });
  });

  it('报告已就绪但结果数据缺失时不误报未发现异常', () => {
    expect(getRecentAnalysisPresentation({
      status: 'report-ready',
      displayName: 'missing-result.tgz'
    })).toEqual({ title: 'missing-result.tgz', detail: 'missing-result.tgz', severity: 'info' });
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

  it('删除确认明确列出将递归删除的解压目录', () => {
    const message = getPackageDeletionConfirmation({ packageCount: 1, extractPaths: ['D:/Inbox/device'] });

    expect(message).toContain('原诊断包、关联解压目录及目录内全部内容');
    expect(message).toContain('D:/Inbox/device');
  });

  it('仅删除记录的确认明确保证原始包、解压目录和报告文件保留', () => {
    const message = getPackageRecordDeletionConfirmation({ packageCount: 1, taskCount: 2, caseCount: 1, analysisRecordCount: 2, reportRecordCount: 1 });

    expect(message).toContain('不删除原始诊断包、解压目录或报告文件');
    expect(message).toContain('任务 2 条');
  });
});
