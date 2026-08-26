import { basename } from 'node:path';

/**
 * 诊断包是分析中心管理的最小业务单元。
 *
 * 该模型将原始包、解压目录、报告与任务历史关联在一起，确保永久删除时不会遗留
 * 无法访问的报告、案例或任务记录。
 */
export type DiagnosticPackageStatus = 'pending' | 'queued' | 'running' | 'report-ready' | 'failed' | 'cancelled';

export interface DiagnosticPackage {
  id: string;
  sourcePath: string;
  extractPath: string;
  reportPath?: string;
  displayName: string;
  detectedAt: string;
  status: DiagnosticPackageStatus;
  taskIds: string[];
  caseId: string;
}

export interface LifecycleDeletionPlan {
  sourcePaths: string[];
  extractPaths: string[];
  reportPaths: string[];
  packageIds: string[];
  caseIds: string[];
  taskIds: string[];
}

export type DiagnosticPackageFormat = 'tgz' | 'zip';

/** 根据扩展名确定归档格式，格式也是规则目录的唯一选择依据。 */
export function getDiagnosticPackageFormat(filePath: string): DiagnosticPackageFormat | undefined {
  const normalizedPath = filePath.trim().toLowerCase();
  if (normalizedPath.endsWith('.tgz') || normalizedPath.endsWith('.tgz.temp')) return 'tgz';
  if (normalizedPath.endsWith('.zip')) return 'zip';
  return undefined;
}

/**
 * 仅允许工作台已经定义并可被内置引擎处理的诊断包。
 * ZIP 包来自分析中心专用采集流程，因此还必须通过文件名 basename 的前缀校验。
 */
export function isDiagnosticPackagePath(filePath: string): boolean {
  const format = getDiagnosticPackageFormat(filePath);
  if (format !== 'zip') return format !== undefined;
  return basename(filePath).toLowerCase().startsWith('nas_server_log');
}

/**
 * “选择成功 / 失败项”是一个安全的批量选择快捷方式。
 * 只有报告已生成或明确失败的包才会进入选择范围，运行、等待和取消项必须由用户单独判断。
 */
export function selectCompletedOrFailedPackages(packages: DiagnosticPackage[]): DiagnosticPackage[] {
  return packages.filter((item) => item.status === 'report-ready' || item.status === 'failed');
}

/**
 * 生成永久删除的完整生命周期清单。
 *
 * 删除诊断包的产品语义不是“从列表移除”，而是删除原始包、解压目录、报告、案例和关联任务。
 * 先生成清单再执行，可让确认窗口准确展示受影响路径与记录数量。
 */
export function buildLifecycleDeletionPlan(packages: DiagnosticPackage[]): LifecycleDeletionPlan {
  const runningPackage = packages.find((item) => item.status === 'running' || item.status === 'queued');
  if (runningPackage) {
    throw new Error(`正在分析的诊断包不能删除：${runningPackage.displayName}`);
  }

  return {
    sourcePaths: packages.map((item) => item.sourcePath),
    extractPaths: packages.map((item) => item.extractPath),
    reportPaths: packages.flatMap((item) => item.reportPath ? [item.reportPath] : []),
    packageIds: packages.map((item) => item.id),
    caseIds: packages.map((item) => item.caseId),
    taskIds: packages.flatMap((item) => item.taskIds)
  };
}
