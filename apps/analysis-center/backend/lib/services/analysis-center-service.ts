import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDiagnosticPackageExtractPath, getDiagnosticPackageFormat, isDiagnosticPackagePath, type DiagnosticPackage } from '../domain/diagnostic-package';
import { WorkspaceRepository } from '../data/workspace-repository';

/**
 * 分析中心的文件接入服务。
 *
 * 手动导入和监控目录扫描共用同一条登记路径，保证同一诊断包不会因为入口不同而产生两条记录。
 * 本服务不直接向渲染进程暴露文件系统能力，所有调用均经由主进程 IPC 进入。
 */
export class AnalysisCenterService {
  public constructor(private readonly repository: WorkspaceRepository) {}

  public listPackages(): DiagnosticPackage[] { return this.repository.listPackages(); }
  public getPackage(id: string): DiagnosticPackage | undefined { return this.repository.getPackage(id); }

  public async scanMonitorDirectories(): Promise<DiagnosticPackage[]> {
    const discovered: DiagnosticPackage[] = [];
    for (const directory of this.repository.getMonitorDirectories()) {
      let entries: string[];
      try { entries = await readdir(directory); }
      catch (error) { throw new Error(`无法扫描监控目录 ${directory}：${error instanceof Error ? error.message : String(error)}`); }
      for (const entry of entries) {
        const path = join(directory, entry);
        const info = await stat(path);
        if (!info.isFile() || !isDiagnosticPackagePath(path)) continue;
        discovered.push(this.registerDiagnosticPackage(path, info.size));
      }
    }
    return discovered;
  }

  /**
   * 监控器传入的可继续判定会在异步文件检查后、写入数据库前再次确认代次仍有效。
   * 这样目录被关闭或重配时，旧扫描不会把已失效目录中的包登记到当前工作区。
   */
  public async importPackage(sourcePath: string, canContinue: () => boolean = () => true): Promise<DiagnosticPackage> {
    const info = await stat(sourcePath).catch(() => undefined);
    if (!canContinue()) throw new Error('监控目录配置已更新，已取消旧扫描');
    if (!info?.isFile()) throw new Error('选择的诊断包不存在或不是文件');
    if (!isDiagnosticPackagePath(sourcePath)) {
      if (getDiagnosticPackageFormat(sourcePath) === 'zip') throw new Error('ZIP 诊断包文件名必须以 nas_server_log 开头');
      throw new Error('仅支持 .tgz、.tgz.temp 或文件名以 nas_server_log 开头的 .zip 格式诊断包');
    }
    if (!canContinue()) throw new Error('监控目录配置已更新，已取消旧扫描');
    return this.registerDiagnosticPackage(sourcePath, info.size);
  }

  private registerDiagnosticPackage(sourcePath: string, sourceSizeBytes: number): DiagnosticPackage {
    const packages = this.repository.listPackages();
    const existing = packages.find((item) => item.sourcePath.toLowerCase() === sourcePath.toLowerCase());
    if (existing) {
      if (existing.sourceSizeBytes === undefined) this.repository.upsertPackage({ ...existing, sourceSizeBytes });
      return { ...existing, sourceSizeBytes: existing.sourceSizeBytes ?? sourceSizeBytes };
    }
    const displayName = basename(sourcePath);
    const extractPath = getDiagnosticPackageExtractPath(sourcePath);
    const sameSourcePackage = packages.find((item) => isSameTgzSource(item.sourcePath, sourcePath));
    if (sameSourcePackage) {
      const updated = { ...sameSourcePackage, sourcePath, displayName, sourceSizeBytes };
      this.repository.upsertPackage(updated);
      return updated;
    }
    // 非 TGZ 临时/最终名不能共享可递归删除的目录，否则任一记录删除都会破坏另一条记录。
    const sameExtractPackage = packages.find((item) => item.extractPath.toLowerCase() === extractPath.toLowerCase());
    if (sameExtractPackage) {
      throw new Error(`另一个诊断包已使用相同解压目录：${sameExtractPackage.displayName}。请重命名当前诊断包后重新导入`);
    }
    const id = randomUUID();
    const item: DiagnosticPackage = {
      id, sourcePath, extractPath, displayName, sourceSizeBytes,
      detectedAt: new Date().toISOString(), status: 'pending', taskIds: [], caseId: randomUUID()
    };
    this.repository.upsertPackage(item);
    this.repository.ensureCase(item.id, item.caseId);
    return item;
  }
}

/** `.tgz.temp` 是同一归档下载完成前的名称；改名后必须复用记录，同时保留历史解压路径。 */
function isSameTgzSource(leftPath: string, rightPath: string): boolean {
  if (getDiagnosticPackageFormat(leftPath) !== 'tgz' || getDiagnosticPackageFormat(rightPath) !== 'tgz') return false;
  try {
    return getDiagnosticPackageExtractPath(leftPath).toLowerCase() === getDiagnosticPackageExtractPath(rightPath).toLowerCase();
  } catch {
    return false;
  }
}
