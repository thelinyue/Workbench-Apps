import { isAbsolute, join, relative, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { AnalysisCenterService } from './lib/services/analysis-center-service';
import { AnalysisTaskService } from './lib/services/analysis-task-service';
import { MonitorDirectoryService } from './lib/services/monitor-directory-service';
import { LifecycleDeletionService } from './lib/services/lifecycle-deletion-service';
import { createAnalysisBackendShutdown } from './lib/services/analysis-backend-shutdown';
import { SysinfoReportService } from './lib/services/sysinfo-report-service';
import { WorkspaceRepository } from './lib/data/workspace-repository';
import type { AnalyzerRuleCatalog } from './lib/analysis/log-analyzer';
import type { AppBackendContext } from '../../../sdk/app-contract';

interface AppBackend {
  invoke(method: string, payload: unknown): Promise<unknown> | unknown;
  close(): Promise<void>;
}

interface PendingDeletion {
  packageIds: string[];
  expiresAt: number;
  kind: 'lifecycle' | 'records';
}

/**
 * 分析中心应用 backend 的唯一入口。
 *
 * 工作台只负责启动这个 Worker 和转发 Host API；诊断包、任务、规则执行结果和设置全部使用
 * dataDirectory 下的新数据库，不读取宿主原有数据库，从数据层面保证应用独立升级。
 * 分析引擎、规则和报告模板会在构建时随 backend 一起打包进 ZIP。
 */
export function createAppBackend(context: AppBackendContext): AppBackend {
  const repository = new WorkspaceRepository(join(context.dataDirectory, 'analysis-center.db'));
  const analysis = new AnalysisCenterService(repository);
  const tasks = new AnalysisTaskService(repository, { notify: (notification) => context.showNotification(notification) });
  const monitor = new MonitorDirectoryService(repository, analysis, tasks);
  const deletion = new LifecycleDeletionService(repository);
  const sysinfoReports = new SysinfoReportService();
  const pendingDeletions = new Map<string, PendingDeletion>();
  const emitChanged = () => context.emit('tasks.changed', { tasks: repository.listTasks() });
  const emitPackagesChanged = () => context.emit('packages.changed', {});
  const emitMonitorStatusChanged = (status: unknown) => context.emit('monitor.status.changed', status);
  tasks.on('changed', emitChanged);
  monitor.on('changed', emitPackagesChanged);
  monitor.on('status.changed', emitMonitorStatusChanged);
  void monitor.start().catch((error) => console.error(`监控目录启动失败：${error instanceof Error ? error.message : String(error)}`));
  const close = createAnalysisBackendShutdown({
    monitor,
    tasks,
    detachListeners: () => {
      tasks.off('changed', emitChanged);
      monitor.off('changed', emitPackagesChanged);
      monitor.off('status.changed', emitMonitorStatusChanged);
    },
    repository
  });

  const getPackage = (id: string) => {
    const item = analysis.getPackage(id);
    if (!item) throw new Error(`找不到指定的诊断包：${id}`);
    return item;
  };

  return {
    async invoke(method, payload) {
      switch (method) {
        case 'packages.list': return analysis.listPackages();
        case 'packages.import': {
          const sourcePath = readString(payload, 'sourcePath');
          const item = await analysis.importPackage(sourcePath);
          context.emit('packages.changed', { packageId: item.id });
          return item;
        }
        case 'packages.scan': { await monitor.scanExistingNow(); return analysis.listPackages(); }
        case 'analysis.start': {
          const value = readRecord(payload);
          await tasks.enqueue(getPackage(readString(value.packageId)).id, value.scope === 'storage' ? 'storage' : 'comprehensive');
          return undefined;
        }
        case 'analysis.start-all-pending': return tasks.enqueueAllPending();
        case 'tasks.list': return repository.listTasks();
        case 'tasks.cancel': tasks.cancel(readString(payload, 'taskId')); return undefined;
        case 'tasks.clear': tasks.clear(readString(payload, 'taskId')); return undefined;
        case 'tasks.clear-completed': return tasks.clearCompleted();
        case 'reports.path': return getPackage(readString(payload, 'packageId')).reportPath ?? null;
        case 'results.get': return repository.getAnalysisResult(readString(payload, 'packageId')) ?? null;
        case 'results.recent': return repository.listRecentAnalysisSummaries();
        case 'results.sysinfo-report-path': return sysinfoReports.getReportPath(getPackage(readString(payload, 'packageId')));
        case 'results.html': {
          const path = getPackage(readString(payload, 'packageId')).reportPath;
          if (!path) throw new Error('该诊断包尚未生成浏览器呈现文件。');
          return readFile(path, 'utf8');
        }
        case 'results.evidence-context': {
          const value = readRecord(payload);
          const diagnosticPackage = getPackage(readString(value.packageId));
          const result = repository.getAnalysisResult(diagnosticPackage.id);
          const evidence = result?.evidence.find((item) => item.id === readString(value, 'evidenceId'));
          if (!evidence) throw new Error('找不到指定的分析证据。');
          if (!evidence.lineNumber) return { available: false, lines: [], message: '该证据没有可定位的文本行，保留已持久化的原文摘要。' };
          const sourcePath = resolve(diagnosticPackage.extractPath, evidence.sourceFile);
          const extractionRoot = resolve(diagnosticPackage.extractPath);
          if (isAbsolute(relative(extractionRoot, sourcePath)) || relative(extractionRoot, sourcePath).startsWith('..')) throw new Error('证据源文件路径无效。');
          try {
            const sourceContent = await readFile(sourcePath);
            const lines = (sourcePath.toLowerCase().endsWith('.gz') ? gunzipSync(sourceContent) : sourceContent).toString('utf8').split(/\r?\n/);
            const start = Math.max(0, evidence.lineNumber - 4);
            return { available: true, startLineNumber: start + 1, lines: lines.slice(start, evidence.lineNumber + 3) };
          } catch {
            return { available: false, lines: [], message: '源日志已不存在，当前保留诊断结论与证据摘要。' };
          }
        }
        case 'packages.locate-source': return getPackage(readString(payload, 'packageId')).sourcePath;
        case 'packages.locate-extract': return getPackage(readString(payload, 'packageId')).extractPath;
        case 'packages.delete-preview': {
          const packageIds = readStringArray(payload, 'packageIds');
          const packages = packageIds.map(getPackage);
          const preview = await deletion.preview(packages);
          const confirmationToken = randomUUID();
          pendingDeletions.set(confirmationToken, { packageIds, expiresAt: Date.now() + 5 * 60_000, kind: 'lifecycle' });
          return { ...preview, confirmationToken };
        }
        case 'packages.delete-record-preview': {
          const packageIds = readStringArray(payload, 'packageIds');
          const packages = packageIds.map(getPackage);
          const preview = deletion.previewRecords(packages);
          const confirmationToken = randomUUID();
          pendingDeletions.set(confirmationToken, { packageIds, expiresAt: Date.now() + 5 * 60_000, kind: 'records' });
          return { ...preview, confirmationToken };
        }
        case 'packages.delete': {
          const packageIds = consumeDeletionConfirmation(pendingDeletions, payload, 'lifecycle');
          await deletion.delete(packageIds.map(getPackage));
          context.emit('packages.changed', { packageIds });
          return undefined;
        }
        case 'packages.delete-record': {
          const packageIds = consumeDeletionConfirmation(pendingDeletions, payload, 'records');
          deletion.deleteRecords(packageIds.map(getPackage));
          context.emit('packages.changed', { packageIds });
          return undefined;
        }
        case 'settings.get': return repository.getMonitorSettings();
        case 'monitor.status': return monitor.getStatus();
        case 'settings.save': {
          const value = readRecord(payload);
          const directory = value.directory === undefined || value.directory === null ? undefined : readString(value, 'directory');
          const enabled = readBoolean(value, 'enabled');
          const autoAnalyzeEnabled = readBoolean(value, 'autoAnalyzeEnabled');
          if (enabled && !directory) throw new Error('启用监控前请选择目录');
          repository.saveMonitorSettings({ directory, enabled, autoAnalyzeEnabled, scanIntervalSeconds: readInteger(value, 'scanIntervalSeconds') });
          await monitor.reconfigure();
          return undefined;
        }
        default: throw new Error(`分析中心不支持该请求：${method}`);
      }
    },
    close
  };
}

function readRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('应用请求参数必须是对象');
  return value as Record<string, unknown>;
}

function readString(value: unknown, key?: string): string {
  const actual = key ? readRecord(value)[key] : value;
  if (typeof actual !== 'string' || !actual.trim()) throw new Error(`应用请求缺少有效字段：${key ?? '字符串'}`);
  return actual;
}

function readStringArray(value: unknown, key: string): string[] {
  const actual = readRecord(value)[key];
  if (!Array.isArray(actual) || actual.some((item) => typeof item !== 'string' || !item.trim())) throw new Error(`应用请求缺少有效数组：${key}`);
  return actual;
}

function consumeDeletionConfirmation(pendingDeletions: Map<string, PendingDeletion>, payload: unknown, kind: PendingDeletion['kind']): string[] {
  const value = readRecord(payload);
  const token = readString(value.confirmationToken);
  const confirmation = pendingDeletions.get(token);
  pendingDeletions.delete(token);
  const packageIds = readStringArray(value, 'packageIds');
  if (!confirmation || confirmation.kind !== kind || confirmation.expiresAt < Date.now() || confirmation.packageIds.join('\u0000') !== packageIds.join('\u0000')) throw new Error('删除确认已失效或操作类型不匹配，请重新查看删除清单后确认');
  return packageIds;
}

/** 设置数值必须在进入数据层前完成整数校验，避免非开发者面对 SQLite 的底层类型错误。 */
function readInteger(value: Record<string, unknown>, key: string): number {
  const actual = value[key];
  if (typeof actual !== 'number' || !Number.isInteger(actual)) throw new Error(`应用请求缺少有效整数：${key}`);
  return actual;
}

function readBoolean(value: Record<string, unknown>, key: string): boolean {
  const actual = value[key];
  if (typeof actual !== 'boolean') throw new Error(`应用请求缺少有效布尔值：${key}`);
  return actual;
}

function readRules(value: unknown): AnalyzerRuleCatalog {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('分析请求缺少有效的规则快照。');
  const record = value as Record<string, unknown>;
  if (!isRuleConfig(record.tgz) || !isRuleConfig(record.zip)) throw new Error('分析请求中的规则快照格式无效。');
  return value as AnalyzerRuleCatalog;
}

function isRuleConfig(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Array.isArray((value as { files?: unknown }).files));
}
