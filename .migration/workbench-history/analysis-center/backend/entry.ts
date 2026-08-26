import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AnalysisCenterService } from '../../../src/main/services/analysis-center-service';
import { AnalysisTaskService } from '../../../src/main/services/analysis-task-service';
import { LifecycleDeletionService } from '../../../src/main/services/lifecycle-deletion-service';
import { WorkspaceRepository } from '../../../src/main/data/workspace-repository';

interface AppBackendContext {
  appId: string;
  dataDirectory: string;
  manifest: unknown;
  emit(event: string, payload: unknown): void;
}

interface AppBackend {
  invoke(method: string, payload: unknown): Promise<unknown> | unknown;
  close(): void;
}

interface PendingDeletion {
  packageIds: string[];
  expiresAt: number;
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
  const tasks = new AnalysisTaskService(repository);
  const deletion = new LifecycleDeletionService(repository);
  const pendingDeletions = new Map<string, PendingDeletion>();
  const emitChanged = () => context.emit('tasks.changed', { tasks: repository.listTasks() });
  tasks.on('changed', emitChanged);

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
        case 'packages.scan': {
          const result = await analysis.scanMonitorDirectories();
          context.emit('packages.changed', { count: result.length });
          return result;
        }
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
        case 'packages.locate-source': return getPackage(readString(payload, 'packageId')).sourcePath;
        case 'packages.locate-extract': return getPackage(readString(payload, 'packageId')).extractPath;
        case 'packages.delete-preview': {
          const packageIds = readStringArray(payload, 'packageIds');
          const packages = packageIds.map(getPackage);
          const preview = await deletion.preview(packages);
          const confirmationToken = randomUUID();
          pendingDeletions.set(confirmationToken, { packageIds, expiresAt: Date.now() + 5 * 60_000 });
          return { ...preview, confirmationToken };
        }
        case 'packages.delete': {
          const value = readRecord(payload);
          const token = readString(value.confirmationToken);
          const confirmation = pendingDeletions.get(token);
          pendingDeletions.delete(token);
          const packageIds = readStringArray(value, 'packageIds');
          if (!confirmation || confirmation.expiresAt < Date.now() || confirmation.packageIds.join('\u0000') !== packageIds.join('\u0000')) throw new Error('删除确认已失效，请重新查看删除清单后确认');
          await deletion.delete(packageIds.map(getPackage));
          context.emit('packages.changed', { packageIds });
          return undefined;
        }
        case 'settings.get': return { directories: repository.getMonitorDirectories(), scanIntervalMinutes: repository.getMonitorScanIntervalMinutes() };
        case 'settings.save': {
          const value = readRecord(payload);
          const directories = readStringArray(value, 'directories');
          const scanIntervalMinutes = Number(value.scanIntervalMinutes);
          if (!Number.isInteger(scanIntervalMinutes) || scanIntervalMinutes < 1) throw new Error('自动扫描间隔至少为 1 分钟');
          repository.saveMonitorDirectories(directories);
          repository.saveMonitorScanIntervalMinutes(scanIntervalMinutes);
          return undefined;
        }
        default: throw new Error(`分析中心不支持该请求：${method}`);
      }
    },
    close() {
      tasks.off('changed', emitChanged);
      repository.close();
    }
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
