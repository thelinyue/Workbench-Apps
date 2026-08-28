import type { AppHostEvent } from '../../../sdk/app-contract';

export type AnalysisTaskStage = 'identify-package' | 'parse-system-events' | 'analyze-storage' | 'aggregate-anomalies' | 'form-conclusion';

const ANALYSIS_STAGES: Array<{ id: AnalysisTaskStage; label: string }> = [
  { id: 'identify-package', label: '识别诊断包' },
  { id: 'parse-system-events', label: '解析系统事件' },
  { id: 'analyze-storage', label: '分析存储状态' },
  { id: 'aggregate-anomalies', label: '聚合异常' },
  { id: 'form-conclusion', label: '形成诊断结论' }
];

export function getWorkspaceGroups<T extends { status: string; detectedAt: string }>(packages: readonly T[]): { pending: T[]; recent: T[] } {
  const byDetectedAt = (left: T, right: T) => Date.parse(right.detectedAt) - Date.parse(left.detectedAt);
  return {
    pending: packages.filter((item) => item.status === 'pending').sort(byDetectedAt),
    recent: packages.filter((item) => item.status === 'report-ready' || item.status === 'failed').sort(byDetectedAt).slice(0, 20)
  };
}

export function formatFileSize(bytes: number | undefined): string {
  if (bytes === undefined) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) { value /= 1024; unitIndex += 1; }
  return `${Number(value.toFixed(value >= 10 ? 0 : 1))} ${units[unitIndex]}`;
}

export function getPackageTone(status: string, severity?: string): 'default' | 'success' | 'warning' | 'danger' {
  if (status === 'failed' || severity === 'critical') return 'danger';
  if (severity === 'warning') return 'warning';
  if (status === 'report-ready') return 'success';
  return 'default';
}

export function getAnalysisStageItems(stage: AnalysisTaskStage): Array<{ id: AnalysisTaskStage; label: string; state: 'complete' | 'current' | 'pending' }> {
  const currentIndex = ANALYSIS_STAGES.findIndex((item) => item.id === stage);
  return ANALYSIS_STAGES.map((item, index) => ({ ...item, state: index < currentIndex ? 'complete' : index === currentIndex ? 'current' : 'pending' }));
}

export function getNotificationActivation(event: AppHostEvent): { kind: 'result' | 'failure'; packageId: string } | undefined {
  if (event.event !== 'host.notification.activated' || !event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) return undefined;
  const payload = event.payload as Record<string, unknown>;
  if ((payload.kind !== 'result' && payload.kind !== 'failure') || typeof payload.packageId !== 'string' || !payload.packageId) return undefined;
  return { kind: payload.kind, packageId: payload.packageId };
}
