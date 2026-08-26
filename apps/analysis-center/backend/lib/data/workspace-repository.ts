import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { DiagnosticPackage, DiagnosticPackageStatus } from '../domain/diagnostic-package';

export const MIN_MONITOR_SCAN_INTERVAL_MINUTES = 1;
export const DEFAULT_MONITOR_SCAN_INTERVAL_MINUTES = 5;
export interface AnalysisTaskRecord { id: string; packageId: string; scope: 'comprehensive' | 'storage'; status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'; createdAt: string; progress: number; message: string; errorMessage?: string; }
export interface AnalysisRecord { id: string; packageId: string; taskId: string; status: AnalysisTaskRecord['status']; createdAt: string; updatedAt: string; }

const COMPLETED_TASK_STATUSES = ['succeeded', 'failed', 'cancelled'] as const;

/**
 * 工作台唯一的本地数据访问层。
 *
 * 使用 Node 内置 `node:sqlite`，避免原生扩展在 Node 测试与 Electron 运行时之间产生 ABI 不一致。
 * 渲染进程不接触 SQLite；所有诊断包、任务和桌面状态均通过此仓储由主进程读写。
 */
export class WorkspaceRepository {
  private readonly database: DatabaseSync;
  private readonly workspaceDirectory: string;

  public constructor(databasePath: string) {
    this.workspaceDirectory = dirname(databasePath);
    mkdirSync(this.workspaceDirectory, { recursive: true });
    this.database = new DatabaseSync(databasePath);
    this.database.exec('PRAGMA foreign_keys = ON;');
    this.createSchema();
  }

  public close(): void { this.database.close(); }

  /** 解压内容始终位于工作台专属目录，不能使用原始诊断包同级的任意用户目录。 */
  public getExtractDirectory(packageId: string): string { return join(this.workspaceDirectory, 'extracted', packageId); }

  public getMonitorDirectories(): string[] {
    const value = this.database.prepare("SELECT value FROM settings WHERE key = 'monitorDirectories'").get() as { value: string } | undefined;
    return value ? JSON.parse(value.value) as string[] : [];
  }

  public saveMonitorDirectories(directories: string[]): void {
    this.database.prepare(`INSERT INTO settings (key, value) VALUES ('monitorDirectories', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(directories));
  }

  public getMonitorScanIntervalMinutes(): number {
    const value = this.database.prepare("SELECT value FROM settings WHERE key = 'monitorScanIntervalMinutes'").get() as { value: string } | undefined;
    const minutes = value ? Number(value.value) : DEFAULT_MONITOR_SCAN_INTERVAL_MINUTES;
    return Number.isInteger(minutes) && minutes >= MIN_MONITOR_SCAN_INTERVAL_MINUTES ? minutes : DEFAULT_MONITOR_SCAN_INTERVAL_MINUTES;
  }

  public saveMonitorScanIntervalMinutes(minutes: number): void {
    if (!Number.isInteger(minutes) || minutes < MIN_MONITOR_SCAN_INTERVAL_MINUTES) throw new Error('自动扫描间隔至少为 1 分钟');
    this.database.prepare(`INSERT INTO settings (key, value) VALUES ('monitorScanIntervalMinutes', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(minutes));
  }

  public upsertPackage(item: DiagnosticPackage): void {
    this.database.prepare(`
      INSERT INTO diagnostic_packages (id, source_path, extract_path, report_path, display_name, detected_at, status, task_ids, case_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        source_path = excluded.source_path, extract_path = excluded.extract_path, report_path = excluded.report_path,
        display_name = excluded.display_name, detected_at = excluded.detected_at, status = excluded.status,
        task_ids = excluded.task_ids, case_id = excluded.case_id
    `).run(item.id, item.sourcePath, item.extractPath, item.reportPath ?? null, item.displayName, item.detectedAt, item.status, JSON.stringify(item.taskIds), item.caseId);
  }

  /** 案例、报告索引与分析记录单独建表，使删除预览能够准确说明关联数据。 */
  public ensureCase(packageId: string, caseId: string): void {
    this.database.prepare('INSERT OR IGNORE INTO analysis_cases (id, package_id, created_at) VALUES (?, ?, ?)').run(caseId, packageId, new Date().toISOString());
  }

  public upsertAnalysisRecord(record: AnalysisRecord): void {
    this.database.prepare(`INSERT INTO analysis_records (id, package_id, task_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`).run(record.id, record.packageId, record.taskId, record.status, record.createdAt, record.updatedAt);
  }

  public upsertReport(packageId: string, path: string): void {
    this.database.prepare(`INSERT INTO report_index (package_id, path, created_at) VALUES (?, ?, ?)
      ON CONFLICT(package_id) DO UPDATE SET path = excluded.path, created_at = excluded.created_at`).run(packageId, path, new Date().toISOString());
  }

  public countLifecycleRecords(packageIds: string[]): { caseCount: number; analysisRecordCount: number; reportRecordCount: number } {
    if (!packageIds.length) return { caseCount: 0, analysisRecordCount: 0, reportRecordCount: 0 };
    const placeholders = packageIds.map(() => '?').join(', ');
    const count = (table: 'analysis_cases' | 'analysis_records' | 'report_index') => (this.database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE package_id IN (${placeholders})`).get(...packageIds) as { count: number }).count;
    return { caseCount: count('analysis_cases'), analysisRecordCount: count('analysis_records'), reportRecordCount: count('report_index') };
  }

  public getPackage(id: string): DiagnosticPackage | undefined { return this.listPackages().find((item) => item.id === id); }

  public listPackages(): DiagnosticPackage[] {
    const rows = this.database.prepare(`SELECT id, source_path AS sourcePath, extract_path AS extractPath, report_path AS reportPath, display_name AS displayName, detected_at AS detectedAt, status, task_ids AS taskIds, case_id AS caseId FROM diagnostic_packages ORDER BY detected_at DESC`).all() as unknown as Array<Omit<DiagnosticPackage, 'status' | 'taskIds'> & { status: DiagnosticPackageStatus; taskIds: string }>;
    return rows.map((item) => ({ ...item, reportPath: item.reportPath ?? undefined, taskIds: JSON.parse(item.taskIds) as string[] }));
  }

  public upsertTask(task: AnalysisTaskRecord): void {
    this.database.prepare(`
      INSERT INTO analysis_tasks (id, package_id, scope, status, created_at, progress, message, error_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET scope = excluded.scope, status = excluded.status, progress = excluded.progress, message = excluded.message, error_message = excluded.error_message
    `).run(task.id, task.packageId, task.scope, task.status, task.createdAt, task.progress, task.message, task.errorMessage ?? null);
  }

  public getTask(id: string): AnalysisTaskRecord | undefined { return this.listTasks().find((item) => item.id === id); }

  public listTasks(): AnalysisTaskRecord[] {
    return this.database.prepare(`SELECT id, package_id AS packageId, scope, status, created_at AS createdAt, progress, message, error_message AS errorMessage FROM analysis_tasks ORDER BY created_at DESC`).all() as unknown as AnalysisTaskRecord[];
  }

  /**
   * 删除单个终态任务及其关联状态，并同步修剪诊断包上的任务引用。
   * SQL 条件再次限制终态，避免渲染层或并发状态变化误删运行中的任务；所有数据库变更
   * 都在同一事务内完成，确保任务列表和生命周期清单不会出现半更新状态。
   */
  public deleteCompletedTask(taskId: string): boolean {
    return this.deleteCompletedTasks([taskId]) === 1;
  }

  /** 一次性删除全部终态任务，返回实际删除数量。 */
  public deleteAllCompletedTasks(): number {
    return this.deleteCompletedTasks();
  }

  /** 在确认永久删除后，事务性删除诊断包、报告索引与关联任务。 */
  public deleteLifecycle(packageIds: string[]): void {
    if (packageIds.length === 0) return;
    const placeholders = packageIds.map(() => '?').join(', ');
    this.database.exec('BEGIN;');
    try {
      this.database.prepare(`DELETE FROM analysis_tasks WHERE package_id IN (${placeholders})`).run(...packageIds);
      this.database.prepare(`DELETE FROM diagnostic_packages WHERE id IN (${placeholders})`).run(...packageIds);
      this.database.exec('COMMIT;');
    } catch (error) { this.database.exec('ROLLBACK;'); throw error; }
  }

  private deleteCompletedTasks(taskIds?: string[]): number {
    const statusPlaceholders = COMPLETED_TASK_STATUSES.map(() => '?').join(', ');
    const taskFilter = taskIds ? `id IN (${taskIds.map(() => '?').join(', ')}) AND ` : '';
    const parameters = taskIds ? [...taskIds, ...COMPLETED_TASK_STATUSES] : [...COMPLETED_TASK_STATUSES];
    const completedTasks = this.database.prepare(`SELECT id, package_id AS packageId FROM analysis_tasks WHERE ${taskFilter}status IN (${statusPlaceholders})`).all(...parameters) as unknown as Array<{ id: string; packageId: string }>;
    if (completedTasks.length === 0) return 0;

    this.database.exec('BEGIN;');
    try {
      const result = this.database.prepare(`DELETE FROM analysis_tasks WHERE ${taskFilter}status IN (${statusPlaceholders})`).run(...parameters);
      const deletedIds = new Set(completedTasks.map((task) => task.id));
      const packageIds = [...new Set(completedTasks.map((task) => task.packageId))];
      const updatePackage = this.database.prepare('UPDATE diagnostic_packages SET task_ids = ? WHERE id = ?');
      for (const packageId of packageIds) {
        const packageRow = this.database.prepare('SELECT task_ids AS taskIds FROM diagnostic_packages WHERE id = ?').get(packageId) as { taskIds: string } | undefined;
        if (!packageRow) continue;
        const taskReferences = JSON.parse(packageRow.taskIds) as string[];
        updatePackage.run(JSON.stringify(taskReferences.filter((id) => !deletedIds.has(id))), packageId);
      }
      this.database.exec('COMMIT;');
      return Number(result.changes);
    } catch (error) {
      this.database.exec('ROLLBACK;');
      throw error;
    }
  }

  private createSchema(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS diagnostic_packages (id TEXT PRIMARY KEY, source_path TEXT NOT NULL, extract_path TEXT NOT NULL, report_path TEXT, display_name TEXT NOT NULL, detected_at TEXT NOT NULL, status TEXT NOT NULL, task_ids TEXT NOT NULL, case_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS analysis_tasks (id TEXT PRIMARY KEY, package_id TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, progress INTEGER NOT NULL, message TEXT NOT NULL, error_message TEXT, FOREIGN KEY(package_id) REFERENCES diagnostic_packages(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS analysis_cases (id TEXT PRIMARY KEY, package_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, FOREIGN KEY(package_id) REFERENCES diagnostic_packages(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS analysis_records (id TEXT PRIMARY KEY, package_id TEXT NOT NULL, task_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, FOREIGN KEY(package_id) REFERENCES diagnostic_packages(id) ON DELETE CASCADE, FOREIGN KEY(task_id) REFERENCES analysis_tasks(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS report_index (package_id TEXT PRIMARY KEY, path TEXT NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY(package_id) REFERENCES diagnostic_packages(id) ON DELETE CASCADE);
    `);
    try { this.database.exec("ALTER TABLE analysis_tasks ADD COLUMN scope TEXT NOT NULL DEFAULT 'comprehensive';"); } catch { /* 已升级数据库会报告重复列，保持兼容。 */ }
  }
}
