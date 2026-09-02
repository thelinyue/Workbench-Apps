import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import type { AnalysisRuntimeTimings } from '../analysis/archive-analysis';
import type { AnalyzerRuleCatalog } from '../analysis/log-analyzer';
import type { AnalysisTaskRecord, AnalysisTaskStage, WorkspaceRepository } from '../data/workspace-repository';
import type { AnalysisResult } from '../analysis-v1/pipeline';
import type { PipelineProfile } from '../analysis-v1/pipeline-profiler';
import type { AnalysisRulePackage } from './analysis-rules-service';

interface AnalysisWorkerMessage {
  type?: 'progress' | 'completed';
  progress?: number;
  stage?: AnalysisTaskStage;
  message?: string;
  succeeded?: boolean;
  browserPath?: string;
  analysisResult?: AnalysisResult;
  runtimeTimings?: AnalysisRuntimeTimings;
  performanceProfile?: PipelineProfile;
  errorMessage?: string;
}

export interface AnalysisWorker {
  terminate(): Promise<number>;
  on(event: 'message', listener: (result: AnalysisWorkerMessage) => void): this;
  once(event: 'error', listener: (error: Error) => void): this;
  once(event: 'exit', listener: (code: number) => void): this;
}

export interface AnalysisTaskServiceOptions {
  createWorker?: (url: URL, options: { workerData: { sourcePath: string; extractDirectory: string; rulePackage?: AnalysisRulePackage; performanceProfiling?: boolean } }) => AnalysisWorker;
  /** 每次 Worker 启动前读取一次，确保运行中的任务不受在线更新影响。 */
  getRulePackage?: () => Promise<AnalysisRulePackage>;
  notify?: (notification: { title: string; body: string; windowKey: 'main'; activationPayload: { kind: 'result' | 'failure'; packageId: string } }) => void;
  logger?: Pick<Console, 'warn'>;
  performanceProfiling?: { onCompleted: (profile: PipelineProfile) => void };
}

const SLOW_ANALYSIS_THRESHOLD_MS = 10_000;

/** 任务按创建先后执行，保证界面显示的“前方任务数”与实际调度顺序一致。 */
export function selectNextQueuedTask(tasks: AnalysisTaskRecord[]): AnalysisTaskRecord | undefined {
  return tasks.filter((task) => task.status === 'queued').sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id.localeCompare(right.id))[0];
}

/**
 * 主进程内的分析任务调度器。
 *
 * 任务状态是持久化业务数据，不依赖任何窗口是否打开。任务单并发执行，避免同时解压大型
 * 归档包导致磁盘抖动；每次实际分析都运行在分析中心私有 worker_threads Worker 中。
 *
 * close() 在同步设置 closing 后复用 cancelTask 持久化所有活动状态，再等待分析 Worker 的
 * terminate Promise 和 queueProcessing。只有两者都结算后 backend 才能解绑监听并关闭 SQLite，
 * 从而保证 run 的 finally、进度回调和下一轮队列选择不会访问已经关闭的仓储。
 */
export class AnalysisTaskService extends EventEmitter {
  private readonly cancelledTaskIds = new Set<string>();
  private queueProcessing: Promise<void> | undefined;
  private activeWorker: AnalysisWorker | undefined;
  private activeTaskId: string | undefined;
  private activeCancellation: (() => void) | undefined;
  private activeTermination: Promise<number> | undefined;
  private closing = false;
  private closeOperation: Promise<void> | undefined;

  public constructor(
    private readonly repository: WorkspaceRepository,
    private readonly options: AnalysisTaskServiceOptions = {}
  ) { super(); }

  /**
   * 任务只传递诊断包路径与解压目录，Worker 根据源文件后缀选择对应的内置格式规则。
   * 旧规则参数保留在方法签名中以兼容已有调用方，但不会参与活动分析。
   */
  public async enqueue(packageId: string, scope: 'comprehensive' | 'storage' = 'comprehensive', _legacyRules?: AnalyzerRuleCatalog): Promise<void> {
    if (this.closing) throw new Error('分析任务服务正在关闭，不能添加新任务');
    const diagnosticPackage = this.repository.getPackage(packageId);
    if (!diagnosticPackage) throw new Error('找不到要分析的诊断包');
    if (diagnosticPackage.status === 'running' || diagnosticPackage.status === 'queued') throw new Error('该诊断包已经在分析队列中');
    // 完整性校验由分析 Worker 在解压前唯一执行，避免 backend 主线程和 Worker 重复读取整个 TGZ。
    const task: AnalysisTaskRecord = { id: randomUUID(), packageId, scope, status: 'queued', createdAt: new Date().toISOString(), progress: 0, stage: 'identify-package', message: scope === 'storage' ? '等待存储健康分析' : '等待综合分析' };
    diagnosticPackage.status = 'queued';
    diagnosticPackage.taskIds = [...diagnosticPackage.taskIds, task.id];
    this.repository.upsertPackage(diagnosticPackage);
    this.repository.upsertTask(task);
    this.emit('changed');
    void this.ensureQueueProcessing();
  }

  public async enqueueAllPending(_legacyRules?: AnalyzerRuleCatalog): Promise<{ count: number; packageNames: string[] }> {
    if (this.closing) throw new Error('分析任务服务正在关闭，不能添加新任务');
    const packages = this.repository.listPackages().filter((item) => item.status === 'pending');
    for (const item of packages) await this.enqueue(item.id, 'comprehensive');
    return { count: packages.length, packageNames: packages.map((item) => item.displayName) };
  }

  public cancel(taskId: string): void {
    this.cancelTask(taskId, true);
  }

  /**
   * 关闭只改变 queued/running 状态，不删除任何任务、报告或私有数据。
   * 持久化阶段会继续尝试每个任务；即使个别写入失败，也会等待 Worker 与队列结算后统一报错。
   */
  public close(): Promise<void> {
    if (this.closeOperation) return this.closeOperation;
    this.closing = true;
    this.closeOperation = this.closeInternal();
    return this.closeOperation;
  }

  private cancelTask(taskId: string, terminateActive: boolean): void {
    const task = this.repository.getTask(taskId);
    if (!task || task.status === 'succeeded' || task.status === 'failed' || task.status === 'cancelled') return;
    this.cancelledTaskIds.add(taskId);
    this.repository.upsertTask({ ...task, status: 'cancelled', message: '已取消', progress: task.progress });
    this.repository.upsertAnalysisRecord({ id: task.id, packageId: task.packageId, taskId: task.id, status: 'cancelled', createdAt: task.createdAt, updatedAt: new Date().toISOString() });
    const diagnosticPackage = this.repository.getPackage(task.packageId);
    if (diagnosticPackage) { diagnosticPackage.status = 'cancelled'; this.repository.upsertPackage(diagnosticPackage); }
    this.emit('changed');
    if (terminateActive && this.activeTaskId === taskId) this.requestActiveWorkerTermination();
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

  private ensureQueueProcessing(): Promise<void> {
    if (this.queueProcessing) return this.queueProcessing;
    const processing = this.processQueue();
    this.queueProcessing = processing;
    const clear = () => { if (this.queueProcessing === processing) this.queueProcessing = undefined; };
    void processing.then(clear, clear);
    return processing;
  }

  private async processQueue(): Promise<void> {
    try {
      while (true) {
        if (this.closing) return;
        const task = selectNextQueuedTask(this.repository.listTasks());
        if (!task) return;
        if (this.cancelledTaskIds.has(task.id)) continue;
        await this.run(task);
      }
    } finally { /* queueProcessing 的共享 Promise 由 ensureQueueProcessing 统一清理。 */ }
  }

  private async run(task: AnalysisTaskRecord): Promise<void> {
    const diagnosticPackage = this.repository.getPackage(task.packageId);
    if (!diagnosticPackage) return;
    let runtimeTimings: AnalysisRuntimeTimings | undefined;
    this.activeTaskId = task.id;
    const runningTask = { ...task, status: 'running' as const, startedAt: new Date().toISOString(), progress: 0, message: '正在准备诊断包' };
    diagnosticPackage.status = 'running';
    this.repository.upsertTask(runningTask);
    this.repository.upsertAnalysisRecord({ id: task.id, packageId: task.packageId, taskId: task.id, status: 'running', createdAt: task.createdAt, updatedAt: new Date().toISOString() });
    this.repository.upsertPackage(diagnosticPackage);
    this.emit('changed');

    try {
      const rulePackage = await this.options.getRulePackage?.();
      const output = await this.runWorker(diagnosticPackage.sourcePath, diagnosticPackage.extractPath, rulePackage, (progress, stage, message) => {
        const current = this.repository.getTask(task.id);
        if (!current || current.status !== 'running') return;
        this.repository.upsertTask({ ...current, progress: Math.max(current.progress, progress), stage, message });
        this.emit('changed');
      });
      runtimeTimings = output.runtimeTimings;
      if (this.cancelledTaskIds.has(task.id)) return;
      if (this.options.performanceProfiling && !output.performanceProfile) throw new Error('分析 Worker 未返回已启用的性能采集结果');
      const persistSuccess = () => {
        diagnosticPackage.status = 'report-ready';
        diagnosticPackage.reportPath = output.browserPath;
        this.repository.upsertPackage(diagnosticPackage);
        this.repository.upsertTask({ ...runningTask, status: 'succeeded', progress: 100, stage: 'form-conclusion', message: '诊断结果已完成', runtimeTimings });
        this.repository.upsertAnalysisRecord({ id: task.id, packageId: task.packageId, taskId: task.id, status: 'succeeded', createdAt: task.createdAt, updatedAt: new Date().toISOString() });
        this.repository.saveAnalysisResult(task.packageId, task.id, output.result);
        this.repository.upsertReport(task.packageId, output.browserPath);
      };
      if (output.performanceProfile) {
        const startedAt = performance.now();
        try { persistSuccess(); }
        finally {
          const metric = output.performanceProfile.stages.persistence;
          metric.durationMs += Math.max(0, performance.now() - startedAt);
          metric.invocations += 1;
        }
        this.reportPerformanceProfile(output.performanceProfile);
      } else persistSuccess();
      this.notify({
        title: '分析完成',
        body: `${diagnosticPackage.displayName}：${output.result.diagnoses[0]?.title ?? (output.result.status === 'partial' ? '分析部分完成' : '未发现明确异常')}`,
        windowKey: 'main',
        activationPayload: { kind: 'result', packageId: diagnosticPackage.id }
      });
      this.reportSlowAnalysis(diagnosticPackage.displayName, diagnosticPackage.sourceSizeBytes, '成功', runtimeTimings);
    } catch (error) {
      if (this.cancelledTaskIds.has(task.id)) return;
      if (error instanceof AnalysisWorkerFailure) runtimeTimings = error.runtimeTimings;
      const errorMessage = error instanceof Error ? error.message : String(error);
      const failureMessage = `分析引擎执行失败：${errorMessage}`;
      diagnosticPackage.status = 'failed';
      this.repository.upsertPackage(diagnosticPackage);
      const currentStage = this.repository.getTask(task.id)?.stage ?? runningTask.stage;
      this.repository.upsertTask({ ...runningTask, status: 'failed', progress: 100, stage: currentStage, message: '分析失败', errorMessage: failureMessage, runtimeTimings });
      this.repository.upsertAnalysisRecord({ id: task.id, packageId: task.packageId, taskId: task.id, status: 'failed', createdAt: task.createdAt, updatedAt: new Date().toISOString() });
      this.repository.saveAnalysisFailure(task.packageId, task.id, inferFailureStage(errorMessage), failureMessage, { sourcePath: diagnosticPackage.sourcePath, displayName: diagnosticPackage.displayName });
      this.notify({
        title: '分析失败',
        body: `${diagnosticPackage.displayName}：${failureMessage}`,
        windowKey: 'main',
        activationPayload: { kind: 'failure', packageId: diagnosticPackage.id }
      });
      this.reportSlowAnalysis(diagnosticPackage.displayName, diagnosticPackage.sourceSizeBytes, '失败', runtimeTimings);
    } finally {
      const termination = this.activeTermination;
      if (termination) await termination.catch(() => undefined);
      this.activeWorker = undefined;
      this.activeTaskId = undefined;
      this.activeCancellation = undefined;
      this.activeTermination = undefined;
      this.emit('changed');
    }
  }

  private runWorker(sourcePath: string, extractDirectory: string, rulePackage: AnalysisRulePackage | undefined, onProgress: (progress: number, stage: AnalysisTaskStage, message: string) => void): Promise<{ browserPath: string; result: AnalysisResult; runtimeTimings?: AnalysisRuntimeTimings; performanceProfile?: PipelineProfile }> {
    return new Promise((resolve, reject) => {
      // 分析中心 backend 以 ESM 发布，必须从实际 entry URL 定位同级 Worker，不能依赖 CommonJS 的 __dirname。
      const workerData = { sourcePath, extractDirectory, ...(rulePackage ? { rulePackage } : {}), ...(this.options.performanceProfiling ? { performanceProfiling: true } : {}) };
      const worker = (this.options.createWorker ?? createDefaultAnalysisWorker)(new URL('./analysis-worker.js', import.meta.url), { workerData });
      this.activeWorker = worker;
      let settled = false;
      const fail = (error: Error, runtimeTimings?: AnalysisRuntimeTimings) => { if (!settled) { settled = true; reject(runtimeTimings ? new AnalysisWorkerFailure(error.message, runtimeTimings) : error); } };
      const succeed = (browserPath: string, result: AnalysisResult, runtimeTimings?: AnalysisRuntimeTimings, performanceProfile?: PipelineProfile) => { if (!settled) { settled = true; resolve({ browserPath, result, runtimeTimings, performanceProfile }); } };
      this.activeCancellation = () => fail(new Error('任务已取消'));
      worker.on('message', (result: AnalysisWorkerMessage) => {
        if (result.type === 'progress' && typeof result.progress === 'number' && result.stage && result.message) { onProgress(result.progress, result.stage, result.message); return; }
        if (result.type === 'completed' || result.succeeded !== undefined) result.succeeded && result.browserPath && result.analysisResult
          ? succeed(result.browserPath, result.analysisResult, result.runtimeTimings, result.performanceProfile)
          : fail(new Error(result.errorMessage ?? '分析引擎没有返回诊断结果'), result.runtimeTimings);
      });
      worker.once('error', (error) => fail(new Error(`分析引擎工作线程异常：${error.message}`)));
      worker.once('exit', (code) => { if (code !== 0) fail(new Error(`分析引擎工作线程异常退出，退出码：${code}`)); });
    });
  }

  /** 只记录异常慢任务；日志设施失败也不能改写已持久化的业务状态或阻断后续队列。 */
  private reportSlowAnalysis(displayName: string, sourceSizeBytes: number | undefined, status: '成功' | '失败', timings: AnalysisRuntimeTimings | undefined): void {
    if (!timings || timings.totalMs < SLOW_ANALYSIS_THRESHOLD_MS) return;
    const size = sourceSizeBytes === undefined ? '未知' : `${sourceSizeBytes} 字节`;
    try {
      (this.options.logger ?? console).warn([
        `分析任务耗时异常：诊断包=${displayName}`,
        `状态=${status}`,
        `大小=${size}`,
        `总耗时=${formatDuration(timings.totalMs)}`,
        `完整性校验=${formatDuration(timings.archiveValidationMs)}`,
        `解压=${formatDuration(timings.archiveExtractionMs)}`,
        `文件清单=${formatDuration(timings.sourceInventoryMs)}`,
        `日志读取=${formatDuration(timings.sourceReadMs)}`,
        `解析与规则=${formatDuration(timings.pipelineAnalysisMs)}`,
        `报告生成=${formatDuration(timings.reportRenderMs)}`
      ].join('；'));
    } catch (error) {
      console.error(`记录分析任务耗时失败：${errorMessage(error)}`);
    }
  }

  private notify(notification: Parameters<NonNullable<AnalysisTaskServiceOptions['notify']>>[0]): void {
    try { this.options.notify?.(notification); }
    catch (error) { console.error(`发送分析任务系统通知失败：${errorMessage(error)}`); }
  }

  /** 开发性能回调不属于业务持久化；回调失败不能把已经成功的诊断任务改成失败。 */
  private reportPerformanceProfile(profile: PipelineProfile): void {
    try { this.options.performanceProfiling?.onCompleted(profile); }
    catch (error) { console.error(`交付分析 Pipeline 性能数据失败：${errorMessage(error)}`); }
  }

  private requestActiveWorkerTermination(): Promise<number> | undefined {
    // terminate() 的 exit 事件不会自动结束 runWorker Promise；先明确拒绝，保证队列 finally 会执行。
    this.activeCancellation?.();
    if (!this.activeWorker) return undefined;
    if (!this.activeTermination) {
      this.activeTermination = this.activeWorker.terminate();
      void this.activeTermination.catch((error) => console.error(`终止分析 Worker 失败：${errorMessage(error)}`));
    }
    return this.activeTermination;
  }

  private async closeInternal(): Promise<void> {
    const failures: string[] = [];
    let activeTaskIds: string[] = [];
    try {
      activeTaskIds = this.repository.listTasks()
        .filter((task) => task.status === 'queued' || task.status === 'running')
        .map((task) => task.id);
    } catch (error) {
      const message = `读取活动分析任务失败：${errorMessage(error)}`;
      console.error(message);
      failures.push(message);
      if (this.activeTaskId) activeTaskIds.push(this.activeTaskId);
    }
    for (const taskId of activeTaskIds) {
      try {
        this.cancelTask(taskId, false);
      } catch (error) {
        const message = `关闭时持久化任务 ${taskId} 的取消状态失败：${errorMessage(error)}`;
        console.error(message);
        failures.push(message);
      }
    }

    let termination: Promise<number> | undefined;
    try { termination = this.requestActiveWorkerTermination(); }
    catch (error) { failures.push(`请求终止分析 Worker 失败：${errorMessage(error)}`); }
    if (termination) {
      try { await termination; } catch (error) { failures.push(`等待分析 Worker 终止失败：${errorMessage(error)}`); }
    }
    const queueDrain = this.queueProcessing;
    if (queueDrain) {
      try { await queueDrain; } catch (error) { failures.push(`等待分析队列清空失败：${errorMessage(error)}`); }
    }
    if (failures.length > 0) throw new Error(`分析任务服务关闭失败：${failures.join('；')}`);
  }
}

function createDefaultAnalysisWorker(url: URL, options: { workerData: { sourcePath: string; extractDirectory: string; rulePackage?: AnalysisRulePackage; performanceProfiling?: boolean } }): AnalysisWorker {
  return new Worker(url, options);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatDuration(durationMs: number): string {
  return `${durationMs.toFixed(3)} ms`;
}

class AnalysisWorkerFailure extends Error {
  public constructor(message: string, public readonly runtimeTimings: AnalysisRuntimeTimings) {
    super(message);
  }
}

/** Worker 只返回用户可读的错误，主线程据此归类失败阶段，避免泄露不稳定的底层堆栈。 */
function inferFailureStage(message: string): string {
  if (message.includes('诊断包文件')) return '校验诊断包';
  if (message.includes('解压')) return '解压';
  if (message.includes('识别日志包')) return '识别来源';
  if (message.includes('读取') || message.includes('解析')) return '解析事件';
  return '生成结果';
}
