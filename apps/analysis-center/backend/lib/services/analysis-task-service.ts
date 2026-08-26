import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import type { AnalyzerRuleCatalog } from '../analysis/log-analyzer';
import type { AnalysisTaskRecord, WorkspaceRepository } from '../data/workspace-repository';

/**
 * 主进程内的分析任务调度器。
 *
 * 任务状态是持久化业务数据，不依赖任何虚拟窗口是否打开。任务单并发执行，避免同时解压大型
 * 归档包导致磁盘抖动；每次实际分析都运行在分析中心私有 worker_threads Worker 中。
 */
export class AnalysisTaskService extends EventEmitter {
  private readonly cancelledTaskIds = new Set<string>();
  private processing = false;
  private activeWorker: Worker | undefined;
  private activeTaskId: string | undefined;
  private activeCancellation: (() => void) | undefined;

  public constructor(private readonly repository: WorkspaceRepository) { super(); }

  /**
   * 将规则快照绑定到任务，而不是在 Worker 中再次读取外部文件。
   * 这样规则编辑器保存后的结果可以按一次分析任务稳定复现，任务执行期间规则变化也不会影响当前任务。
   */
  public async enqueue(packageId: string, scope: 'comprehensive' | 'storage' = 'comprehensive', rules: AnalyzerRuleCatalog): Promise<void> {
    const diagnosticPackage = this.repository.getPackage(packageId);
    if (!diagnosticPackage) throw new Error('找不到要分析的诊断包');
    if (diagnosticPackage.status === 'running' || diagnosticPackage.status === 'queued') throw new Error('该诊断包已经在分析队列中');
    const task: AnalysisTaskRecord = { id: randomUUID(), packageId, scope, status: 'queued', createdAt: new Date().toISOString(), progress: 0, message: scope === 'storage' ? '等待存储健康分析' : '等待综合分析' };
    diagnosticPackage.status = 'queued';
    diagnosticPackage.taskIds = [...diagnosticPackage.taskIds, task.id];
    this.repository.upsertPackage(diagnosticPackage);
    this.repository.upsertTask(task);
    this.emit('changed');
    void this.processQueue(rules);
  }

  public async enqueueAllPending(rules: AnalyzerRuleCatalog): Promise<{ count: number; packageNames: string[] }> {
    const packages = this.repository.listPackages().filter((item) => item.status === 'pending');
    for (const item of packages) await this.enqueue(item.id, 'comprehensive', rules);
    return { count: packages.length, packageNames: packages.map((item) => item.displayName) };
  }

  public cancel(taskId: string): void {
    const task = this.repository.getTask(taskId);
    if (!task || task.status === 'succeeded' || task.status === 'failed' || task.status === 'cancelled') return;
    this.cancelledTaskIds.add(taskId);
    if (this.activeTaskId === taskId) {
      // terminate() 的 exit 事件不会自动结束 Promise；先明确拒绝，保证队列 finally 一定执行。
      this.activeCancellation?.();
      this.activeWorker?.terminate().catch(() => undefined);
    }
    this.repository.upsertTask({ ...task, status: 'cancelled', message: '已取消', progress: task.progress });
    this.repository.upsertAnalysisRecord({ id: task.id, packageId: task.packageId, taskId: task.id, status: 'cancelled', createdAt: task.createdAt, updatedAt: new Date().toISOString() });
    const diagnosticPackage = this.repository.getPackage(task.packageId);
    if (diagnosticPackage) { diagnosticPackage.status = 'cancelled'; this.repository.upsertPackage(diagnosticPackage); }
    this.emit('changed');
  }

  /** 清理单个历史任务；运行中和排队任务必须先取消。 */
  public clear(taskId: string): void {
    const task = this.repository.getTask(taskId);
    if (!task) return;
    if (task.status === 'running' || task.status === 'queued') throw new Error('运行中或排队中的任务不能清理，请先取消任务');
    if (this.repository.deleteCompletedTask(taskId)) this.emit('changed');
  }

  /** 一键清理全部已完成、失败和已取消的历史任务。 */
  public clearCompleted(): number {
    const count = this.repository.deleteAllCompletedTasks();
    if (count > 0) this.emit('changed');
    return count;
  }

  private async processQueue(rules: AnalyzerRuleCatalog): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (true) {
        const task = this.repository.listTasks().find((item) => item.status === 'queued');
        if (!task) return;
        if (this.cancelledTaskIds.has(task.id)) continue;
        await this.run(task, rules);
      }
    } finally { this.processing = false; }
  }

  private async run(task: AnalysisTaskRecord, rules: AnalyzerRuleCatalog): Promise<void> {
    const diagnosticPackage = this.repository.getPackage(task.packageId);
    if (!diagnosticPackage) return;
    this.activeTaskId = task.id;
    const runningTask = { ...task, status: 'running' as const, progress: 0, message: '正在准备诊断包' };
    diagnosticPackage.status = 'running';
    this.repository.upsertTask(runningTask);
    this.repository.upsertAnalysisRecord({ id: task.id, packageId: task.packageId, taskId: task.id, status: 'running', createdAt: task.createdAt, updatedAt: new Date().toISOString() });
    this.repository.upsertPackage(diagnosticPackage);
    this.emit('changed');

    try {
      const reportPath = await this.runWorker(diagnosticPackage.sourcePath, diagnosticPackage.extractPath, task.scope, rules, (progress, message) => {
        const current = this.repository.getTask(task.id);
        if (!current || current.status !== 'running') return;
        this.repository.upsertTask({ ...current, progress: Math.max(current.progress, progress), message });
        this.emit('changed');
      });
      if (this.cancelledTaskIds.has(task.id)) return;
      diagnosticPackage.status = 'report-ready';
      diagnosticPackage.reportPath = reportPath;
      this.repository.upsertPackage(diagnosticPackage);
      this.repository.upsertTask({ ...runningTask, status: 'succeeded', progress: 100, message: '报告已生成' });
      this.repository.upsertAnalysisRecord({ id: task.id, packageId: task.packageId, taskId: task.id, status: 'succeeded', createdAt: task.createdAt, updatedAt: new Date().toISOString() });
      this.repository.upsertReport(task.packageId, reportPath);
    } catch (error) {
      if (this.cancelledTaskIds.has(task.id)) return;
      const errorMessage = error instanceof Error ? error.message : String(error);
      diagnosticPackage.status = 'failed';
      this.repository.upsertPackage(diagnosticPackage);
      this.repository.upsertTask({ ...runningTask, status: 'failed', progress: 100, message: '分析失败', errorMessage });
      this.repository.upsertAnalysisRecord({ id: task.id, packageId: task.packageId, taskId: task.id, status: 'failed', createdAt: task.createdAt, updatedAt: new Date().toISOString() });
    } finally { this.activeWorker = undefined; this.activeTaskId = undefined; this.activeCancellation = undefined; this.emit('changed'); }
  }

  private runWorker(sourcePath: string, extractDirectory: string, scope: 'comprehensive' | 'storage', rules: AnalyzerRuleCatalog, onProgress: (progress: number, message: string) => void): Promise<string> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(join(__dirname, 'analysis-worker.js'), { workerData: { sourcePath, extractDirectory, rules, scope } });
      this.activeWorker = worker;
      let settled = false;
      const fail = (error: Error) => { if (!settled) { settled = true; reject(error); } };
      const succeed = (reportPath: string) => { if (!settled) { settled = true; resolve(reportPath); } };
      this.activeCancellation = () => fail(new Error('任务已取消'));
      worker.on('message', (result: { type?: 'progress' | 'completed'; progress?: number; message?: string; succeeded?: boolean; reportPath?: string; errorMessage?: string }) => {
        if (result.type === 'progress' && typeof result.progress === 'number' && result.message) { onProgress(result.progress, result.message); return; }
        if (result.type === 'completed' || result.succeeded !== undefined) result.succeeded && result.reportPath ? succeed(result.reportPath) : fail(new Error(result.errorMessage ?? '分析引擎没有返回报告路径'));
      });
      worker.once('error', (error) => fail(new Error(`分析引擎工作线程异常：${error.message}`)));
      worker.once('exit', (code) => { if (code !== 0) fail(new Error(`分析引擎工作线程异常退出，退出码：${code}`)); });
    });
  }
}
