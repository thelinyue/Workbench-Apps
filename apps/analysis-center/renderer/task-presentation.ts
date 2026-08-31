/** 分析任务的时间、排队和菜单判定集中在这里，避免组件重渲染时重复实现相同规则。 */
export interface AnalysisRuntimeTimingsView {
  archiveValidationMs: number;
  archiveExtractionMs: number;
  sourceInventoryMs: number;
  sourceReadMs: number;
  pipelineAnalysisMs: number;
  reportRenderMs: number;
  totalMs: number;
}

export function formatElapsed(startedAt: string | undefined, now: number): string {
  if (!startedAt) return '等待开始';
  const elapsedSeconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return minutes ? `已用时 ${minutes} 分 ${seconds} 秒` : `已用时 ${seconds} 秒`;
}

/** 总耗时直接用于列表扫读，六阶段明细保留定位慢点所需的信息。 */
export function getAnalysisRuntimePresentation(timings: AnalysisRuntimeTimingsView | undefined): { total: string; detail: string } | undefined {
  if (!timings) return undefined;
  return {
    total: `分析用时 ${formatRuntimeDuration(timings.totalMs)}`,
    detail: [
      `总用时 ${formatRuntimeDuration(timings.totalMs)}`,
      `完整性校验 ${formatRuntimeDuration(timings.archiveValidationMs)}`,
      `完整解压 ${formatRuntimeDuration(timings.archiveExtractionMs)}`,
      `文件遍历 ${formatRuntimeDuration(timings.sourceInventoryMs)}`,
      `日志读取 ${formatRuntimeDuration(timings.sourceReadMs)}`,
      `解析与规则分析 ${formatRuntimeDuration(timings.pipelineAnalysisMs)}`,
      `报告生成 ${formatRuntimeDuration(timings.reportRenderMs)}`
    ].join(' · ')
  };
}

/** 同一诊断包可能反复分析，工作区只关联时间最新且已经结束的任务记录。 */
export function getLatestRuntimeTimingsByPackageId<T extends { packageId: string; status: string; createdAt: string; runtimeTimings?: AnalysisRuntimeTimingsView }>(tasks: readonly T[]): Map<string, AnalysisRuntimeTimingsView> {
  const selected = new Map<string, { createdAt: number; timings?: AnalysisRuntimeTimingsView }>();
  for (const task of tasks) {
    if (!['succeeded', 'failed', 'cancelled'].includes(task.status)) continue;
    const createdAt = Date.parse(task.createdAt);
    const current = selected.get(task.packageId);
    if (!current || createdAt > current.createdAt) selected.set(task.packageId, { createdAt, timings: task.runtimeTimings });
  }
  return new Map([...selected].flatMap(([packageId, value]) => value.timings ? [[packageId, value.timings]] : []));
}

function formatRuntimeDuration(durationMs: number): string {
  const milliseconds = Math.max(0, durationMs);
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} 毫秒`;
  const seconds = Number((milliseconds / 1_000).toFixed(1));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Number((seconds - minutes * 60).toFixed(1));
  return remainingSeconds ? `${minutes} 分 ${remainingSeconds} 秒` : `${minutes} 分`;
}

export function getQueuePosition(taskId: string, tasks: Array<{ id: string; status: string; createdAt: string }>): number {
  const task = tasks.find((item) => item.id === taskId);
  if (!task) return 0;
  const createdAt = Date.parse(task.createdAt);
  return tasks.filter((item) => (item.status === 'queued' || item.status === 'running') && (Date.parse(item.createdAt) < createdAt || (Date.parse(item.createdAt) === createdAt && item.id < task.id))).length;
}

/** 仅当点击目标不属于当前菜单或其触发按钮时，才允许关闭菜单。 */
export function isOutsideOverflowMenu(target: unknown, menu: { contains(target: unknown): boolean } | null, trigger: { contains(target: unknown): boolean } | null): boolean {
  return Boolean(target && !menu?.contains(target) && !trigger?.contains(target));
}
