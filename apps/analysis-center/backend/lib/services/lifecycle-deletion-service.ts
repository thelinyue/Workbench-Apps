import { lstat, rm, stat } from 'node:fs/promises';
import type { DiagnosticPackage } from '../domain/diagnostic-package';
import { buildLifecycleDeletionPlan } from '../domain/diagnostic-package';
import type { WorkspaceRepository } from '../data/workspace-repository';

export interface LifecycleDeletionPreview {
  packageCount: number;
  taskCount: number;
  sourcePaths: string[];
  extractPaths: string[];
  reportPaths: string[];
  estimatedBytes: number;
  caseCount: number;
  analysisRecordCount: number;
  reportRecordCount: number;
}

/**
 * 诊断包生命周期删除服务。
 *
 * 删除诊断包代表永久删除原始归档包、解压目录（包含报告）、案例记录与关联任务历史。此服务
 * 必须先生成预览供 UI 明确确认，再执行物理删除和数据库事务，避免“只从列表移除”的歧义。
 */
export class LifecycleDeletionService {
  public constructor(private readonly repository: WorkspaceRepository) {}

  public async preview(packages: DiagnosticPackage[]): Promise<LifecycleDeletionPreview> {
    const plan = buildLifecycleDeletionPlan(packages);
    const estimatedBytes = await sumExistingBytes([...plan.sourcePaths, ...plan.extractPaths]);
    return { packageCount: plan.packageIds.length, taskCount: plan.taskIds.length, ...plan, estimatedBytes, ...this.repository.countLifecycleRecords(plan.packageIds) };
  }

  public async delete(packages: DiagnosticPackage[]): Promise<void> {
    const plan = buildLifecycleDeletionPlan(packages);
    for (const sourcePath of plan.sourcePaths) await rm(sourcePath, { force: true });
    for (const extractPath of plan.extractPaths) await rm(extractPath, { force: true, recursive: true, maxRetries: 2 });
    // reportPath 位于 extractPath 内；单独删除只覆盖未来报告路径不在解压目录时的兼容情况。
    for (const reportPath of plan.reportPaths) await rm(reportPath, { force: true });
    this.repository.deleteLifecycle(plan.packageIds);
  }
}

async function sumExistingBytes(paths: string[]): Promise<number> {
  let total = 0;
  for (const path of paths) total += await pathBytes(path);
  return total;
}

async function pathBytes(path: string): Promise<number> {
  const info = await lstat(path).catch(() => undefined);
  if (!info) return 0;
  if (!info.isDirectory()) return info.size;
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(path);
  const sizes = await Promise.all(entries.map((entry) => pathBytes(`${path}\\${entry}`)));
  return sizes.reduce((sum, size) => sum + size, 0);
}
