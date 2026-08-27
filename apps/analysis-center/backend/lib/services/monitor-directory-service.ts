import { watch, type FSWatcher } from 'node:fs';
import { EventEmitter } from 'node:events';
import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isDiagnosticPackagePath } from '../domain/diagnostic-package';
import type { WorkspaceRepository } from '../data/workspace-repository';
import type { AnalysisCenterService } from './analysis-center-service';

/**
 * 单目录监控器。
 *
 * 文件系统事件不能代表写入完成，因此它只唤醒检查；同一路径必须连续两次取得一致的大小和修改
 * 时间、能够被只读打开，才交给导入服务登记。登记本身仍由 AnalysisCenterService 去重。
 */
export class MonitorDirectoryService extends EventEmitter {
  private watcher: FSWatcher | undefined;
  private watchedDirectory: string | undefined;
  private scanTimer: NodeJS.Timeout | undefined;
  private readonly observations = new Map<string, { identity: string; stableCount: number }>();

  public constructor(
    private readonly repository: WorkspaceRepository,
    private readonly analysis: AnalysisCenterService,
    private readonly debounceMs = 750
  ) { super(); }

  public async start(): Promise<void> {
    const settings = this.repository.getMonitorSettings();
    if (!settings.enabled || !settings.directory) return;
    this.watchDirectory(settings.directory);
    await this.scanNow();
    this.scheduleScan();
  }

  public async reconfigure(): Promise<void> {
    this.close();
    await this.start();
  }

  public close(): void {
    this.watcher?.close();
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.scanTimer = undefined;
    this.watcher = undefined;
    this.watchedDirectory = undefined;
    this.observations.clear();
  }

  public async scanNow(): Promise<void> {
    const settings = this.repository.getMonitorSettings();
    if (!settings.enabled || !settings.directory) return;
    let names: string[];
    try { names = await readdir(settings.directory); }
    catch (error) { throw new Error(`无法扫描监控目录 ${settings.directory}：${error instanceof Error ? error.message : String(error)}`); }
    const current = new Set<string>();
    for (const name of names) {
      const sourcePath = join(settings.directory, name);
      current.add(sourcePath.toLowerCase());
      await this.observe(sourcePath);
    }
    for (const path of this.observations.keys()) if (!current.has(path.toLowerCase())) this.observations.delete(path);
  }

  private watchDirectory(directory: string): void {
    this.watchedDirectory = directory;
    try {
      this.watcher = watch(directory, () => {
        this.scheduleScan();
      });
    } catch (error) {
      console.error(`无法监听监控目录 ${directory}：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 合并同一轮文件系统事件，确保写入结束后的第二次采样不会被事件风暴放大。 */
  private scheduleScan(): void {
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.scanTimer = setTimeout(() => {
      this.scanTimer = undefined;
      void this.scanNow().catch((error) => console.error(`监控目录扫描失败：${error instanceof Error ? error.message : String(error)}`));
    }, this.debounceMs);
  }

  private async observe(sourcePath: string): Promise<void> {
    if (!isDiagnosticPackagePath(sourcePath) || /\.(?:crdownload|download|part|partial)$/i.test(sourcePath)) return;
    const info = await stat(sourcePath).catch(() => undefined);
    if (!info?.isFile()) return;
    try { const handle = await open(sourcePath, 'r'); await handle.close(); }
    catch { return; }
    const identity = `${info.size}:${info.mtimeMs}`;
    const previous = this.observations.get(sourcePath);
    const stableCount = previous?.identity === identity ? previous.stableCount + 1 : 1;
    this.observations.set(sourcePath, { identity, stableCount });
    if (stableCount >= 2) {
      const countBefore = this.analysis.listPackages().length;
      await this.analysis.importPackage(sourcePath);
      if (this.analysis.listPackages().length !== countBefore) this.emit('changed');
    }
  }
}
