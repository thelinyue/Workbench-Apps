/** 分析任务的时间、排队和菜单判定集中在这里，避免组件重渲染时重复实现相同规则。 */
export function formatElapsed(startedAt: string | undefined, now: number): string {
  if (!startedAt) return '等待开始';
  const elapsedSeconds = Math.max(0, Math.floor((now - Date.parse(startedAt)) / 1000));
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = elapsedSeconds % 60;
  return minutes ? `已用时 ${minutes} 分 ${seconds} 秒` : `已用时 ${seconds} 秒`;
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
