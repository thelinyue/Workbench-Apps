import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getDiagnosticPackageFormat, isDiagnosticPackagePath, type DiagnosticPackage } from '../domain/diagnostic-package';
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
        discovered.push(this.registerDiagnosticPackage(path));
      }
    }
    return discovered;
  }

  public async importPackage(sourcePath: string): Promise<DiagnosticPackage> {
    const info = await stat(sourcePath).catch(() => undefined);
    if (!info?.isFile()) throw new Error('选择的诊断包不存在或不是文件');
    if (!isDiagnosticPackagePath(sourcePath)) {
      if (getDiagnosticPackageFormat(sourcePath) === 'zip') throw new Error('ZIP 诊断包文件名必须以 nas_server_log 开头');
      throw new Error('仅支持 .tgz、.tgz.temp 或文件名以 nas_server_log 开头的 .zip 格式诊断包');
    }
    return this.registerDiagnosticPackage(sourcePath);
  }

  private registerDiagnosticPackage(sourcePath: string): DiagnosticPackage {
    const existing = this.repository.listPackages().find((item) => item.sourcePath.toLowerCase() === sourcePath.toLowerCase());
    if (existing) return existing;
    const displayName = basename(sourcePath);
    const id = randomUUID();
    const item: DiagnosticPackage = {
      id, sourcePath, extractPath: this.repository.getExtractDirectory(id), displayName,
      detectedAt: new Date().toISOString(), status: 'pending', taskIds: [], caseId: randomUUID()
    };
    this.repository.upsertPackage(item);
    this.repository.ensureCase(item.id, item.caseId);
    return item;
  }
}
