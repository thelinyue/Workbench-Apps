import { describe, expect, it } from 'vitest';
import {
  buildLifecycleDeletionPlan,
  isDiagnosticPackagePath,
  selectCompletedOrFailedPackages,
  type DiagnosticPackage
} from '../backend/lib/domain/diagnostic-package';

const basePackage: DiagnosticPackage = {
  id: 'package-1',
  sourcePath: 'D:/Diagnostics/core-048.tgz',
  extractPath: 'D:/Diagnostics/core-048',
  reportPath: 'D:/Diagnostics/core-048/Report/index.html',
  displayName: 'core-048.tgz',
  detectedAt: '2026-08-25T10:25:00.000Z',
  status: 'report-ready',
  taskIds: ['task-1'],
  caseId: 'case-1'
};

describe('诊断包领域规则', () => {
  it('只接受指定格式和 nas_server_log 开头的 ZIP 诊断包', () => {
    expect(isDiagnosticPackagePath('D:/Inbox/device.tgz')).toBe(true);
    expect(isDiagnosticPackagePath('D:/Inbox/device.tgz.temp')).toBe(true);
    expect(isDiagnosticPackagePath('D:/Inbox/nas_server_log_20260825.zip')).toBe(true);
    expect(isDiagnosticPackagePath('D:/Inbox/NAS_SERVER_LOG_20260825.ZIP')).toBe(true);
    expect(isDiagnosticPackagePath('D:/Inbox/device.zip')).toBe(false);
  });

  it('批量清理只选择报告已生成和分析失败的诊断包', () => {
    const selected = selectCompletedOrFailedPackages([
      basePackage,
      { ...basePackage, id: 'failed', status: 'failed' },
      { ...basePackage, id: 'running', status: 'running' },
      { ...basePackage, id: 'cancelled', status: 'cancelled' }
    ]);

    expect(selected.map((item) => item.id)).toEqual(['package-1', 'failed']);
  });

  it('删除诊断包会规划完整生命周期文件与关联记录删除', () => {
    expect(buildLifecycleDeletionPlan([basePackage])).toEqual({
      sourcePaths: ['D:/Diagnostics/core-048.tgz'],
      extractPaths: ['D:/Diagnostics/core-048'],
      reportPaths: ['D:/Diagnostics/core-048/Report/index.html'],
      packageIds: ['package-1'],
      caseIds: ['case-1'],
      taskIds: ['task-1']
    });
  });

  it('拒绝删除正在运行或排队的诊断包', () => {
    expect(() => buildLifecycleDeletionPlan([{ ...basePackage, status: 'running' }])).toThrow('正在分析的诊断包不能删除');
    expect(() => buildLifecycleDeletionPlan([{ ...basePackage, status: 'queued' }])).toThrow('正在分析的诊断包不能删除');
  });
});
