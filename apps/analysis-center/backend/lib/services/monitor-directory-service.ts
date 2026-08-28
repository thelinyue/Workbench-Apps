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
  private status: { state: 'disabled' | 'watching' | 'paused'; warning?: string } = { state: 'disabled' };
  private generation = 0;

  public constructor(
    private readonly repository: WorkspaceRepository,
    private readonly analysis: AnalysisCenterService
  ) { super(); }

  public async start(): Promise<void> {
    const generation = this.generation;
    const settings = this.repository.getMonitorSettings();
    if (!settings.enabled || !settings.directory) { this.setStatus({ state: 'disabled' }); return; }
    if (!this.watchDirectory(settings.directory, generation)) return;
    try { await this.scanNow(generation); } catch (error) { if (this.isCurrent(generation)) this.pause(settings.directory, error); return; }
    if (!this.isCurrent(generation)) return;
    this.setStatus({ state: 'watching' });
    this.scheduleNextScan(settings.scanIntervalMinutes, generation);
  }

  public async reconfigure(): Promise<void> {
    this.close();
    await this.start();
  }

  public close(): void {
    this.generation += 1;
    this.watcher?.close();
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.scanTimer = undefined;
    this.watcher = undefined;
    this.watchedDirectory = undefined;
    this.observations.clear();
  }
  public getStatus(): { state: 'disabled' | 'watching' | 'paused'; warning?: string } { return this.status; }

  public async scanNow(generation: number = this.generation): Promise<void> { await this.scanNowForGeneration(generation); }

  /** 关闭或重配后使旧扫描失效，避免其完成后导入旧目录文件或重新创建旧周期定时器。 */
  private async scanNowForGeneration(generation: number): Promise<void> {
    const settings = this.repository.getMonitorSettings();
    if (!settings.enabled || !settings.directory) return;
    let names: string[];
    try { names = await readdir(settings.directory); }
    catch (error) { throw new Error(`无法扫描监控目录 ${settings.directory}：${error instanceof Error ? error.message : String(error)}`); }
    if (!this.isCurrent(generation)) return;
    const current = new Set<string>();
    for (const name of names) {
      if (!this.isCurrent(generation)) return;
      const sourcePath = join(settings.directory, name);
      current.add(sourcePath.toLowerCase());
      await this.observe(sourcePath, generation);
    }
    if (!this.isCurrent(generation)) return;
    for (const path of this.observations.keys()) if (!current.has(path.toLowerCase())) this.observations.delete(path);
  }

  private watchDirectory(directory: string, generation: number): boolean {
    this.watchedDirectory = directory;
    try {
      this.watcher = watch(directory, () => undefined);
      this.watcher.on('error', (error) => { if (this.isCurrent(generation)) this.pause(directory, error); });
      return true;
    } catch (error) {
      if (this.isCurrent(generation)) this.pause(directory, error);
      return false;
    }
  }

  /**
   * 目录变更只用于保留底层监听和访问错误感知；扫描严格遵循用户保存的固定周期。
   * 首次扫描会建立稳定性样本，后续周期扫描完成第二次采样后才导入，避免读取仍在写入的归档包。
   */
  private scheduleNextScan(intervalMinutes: number, generation: number): void {
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.scanTimer = setTimeout(async () => {
      this.scanTimer = undefined;
      try {
        await this.scanNow(generation);
        if (this.isCurrent(generation)) this.scheduleNextScan(intervalMinutes, generation);
      } catch (error) {
        if (this.isCurrent(generation)) this.pause(this.watchedDirectory ?? '监控目录', error);
      }
    }, intervalMinutes * 60_000);
  }

  private async observe(sourcePath: string, generation: number): Promise<void> {
    if (!isDiagnosticPackagePath(sourcePath) || /\.(?:crdownload|download|part|partial)$/i.test(sourcePath)) return;
    const info = await stat(sourcePath).catch(() => undefined);
    if (!this.isCurrent(generation)) return;
    if (!info?.isFile()) return;
    try { const handle = await open(sourcePath, 'r'); await handle.close(); }
    catch { return; }
    if (!this.isCurrent(generation)) return;
    const identity = `${info.size}:${info.mtimeMs}`;
    const previous = this.observations.get(sourcePath);
    const stableCount = previous?.identity === identity ? previous.stableCount + 1 : 1;
    this.observations.set(sourcePath, { identity, stableCount });
    if (stableCount >= 2) {
      const countBefore = this.analysis.listPackages().length;
      try {
        await this.analysis.importPackage(sourcePath, () => this.isCurrent(generation));
      } catch (error) {
        // 关闭或重配会主动取消旧扫描；该取消不应在已失效的异步链中形成未处理错误。
        if (!this.isCurrent(generation)) return;
        throw error;
      }
      if (!this.isCurrent(generation)) return;
      if (this.analysis.listPackages().length !== countBefore) this.emit('changed');
    }
  }
  private isCurrent(generation: number): boolean { return generation === this.generation; }
  private pause(directory: string, error: unknown): void { this.close(); this.setStatus({ state: 'paused', warning: `${directory} 当前无法访问，监控已暂停。` }); console.error(`监控目录已暂停：${error instanceof Error ? error.message : String(error)}`); }
  private setStatus(next: { state: 'disabled' | 'watching' | 'paused'; warning?: string }): void { if (this.status.state === next.state && this.status.warning === next.warning) return; this.status = next; this.emit('status.changed', next); }
}
