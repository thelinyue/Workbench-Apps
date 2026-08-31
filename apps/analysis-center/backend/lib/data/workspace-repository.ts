import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { DiagnosticPackage, DiagnosticPackageStatus } from '../domain/diagnostic-package';
import type { AnalysisResult } from '../analysis-v1/pipeline';
import type { AnalysisRuntimeTimings } from '../analysis/archive-analysis';

export const MIN_MONITOR_SCAN_INTERVAL_SECONDS = 10;
export const MAX_MONITOR_SCAN_INTERVAL_SECONDS = 60;
export const MONITOR_SCAN_INTERVAL_STEP_SECONDS = 10;
export const DEFAULT_MONITOR_SCAN_INTERVAL_SECONDS = 10;
export type AnalysisTaskStage = 'identify-package' | 'parse-system-events' | 'analyze-storage' | 'aggregate-anomalies' | 'form-conclusion';
export interface AnalysisTaskRecord { id: string; packageId: string; scope: 'comprehensive' | 'storage'; status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'; createdAt: string; startedAt?: string; progress: number; stage: AnalysisTaskStage; message: string; errorMessage?: string; runtimeTimings?: AnalysisRuntimeTimings; }
export interface AnalysisRecord { id: string; packageId: string; taskId: string; status: AnalysisTaskRecord['status']; createdAt: string; updatedAt: string; }
export interface MonitorSettings { directory?: string; enabled: boolean; autoAnalyzeEnabled: boolean; scanIntervalSeconds: number; }
export interface AnalysisFailureRecord { taskId: string; packageId: string; stage: string; errorMessage: string; inputMetadata: Record<string, string>; createdAt: string; }

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

  public getMonitorDirectories(): string[] {
    const value = this.database.prepare("SELECT value FROM settings WHERE key = 'monitorDirectories'").get() as { value: string } | undefined;
    return value ? JSON.parse(value.value) as string[] : [];
  }

  public saveMonitorDirectories(directories: string[]): void {
    this.database.prepare(`INSERT INTO settings (key, value) VALUES ('monitorDirectories', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(directories));
  }

  /** 秒级配置使用独立键；旧版分钟键不参与读取，避免升级后把分钟数误当成秒数。 */
  public getMonitorScanIntervalSeconds(): number {
    const value = this.database.prepare("SELECT value FROM settings WHERE key = 'monitorScanIntervalSeconds'").get() as { value: string } | undefined;
    const seconds = value ? Number(value.value) : DEFAULT_MONITOR_SCAN_INTERVAL_SECONDS;
    return Number.isInteger(seconds) && seconds >= MIN_MONITOR_SCAN_INTERVAL_SECONDS
      && seconds <= MAX_MONITOR_SCAN_INTERVAL_SECONDS && seconds % MONITOR_SCAN_INTERVAL_STEP_SECONDS === 0
      ? seconds
      : DEFAULT_MONITOR_SCAN_INTERVAL_SECONDS;
  }

  public saveMonitorScanIntervalSeconds(seconds: number): void {
    if (!Number.isInteger(seconds) || seconds < MIN_MONITOR_SCAN_INTERVAL_SECONDS) throw new Error('自动扫描间隔至少为 10 秒');
    if (seconds > MAX_MONITOR_SCAN_INTERVAL_SECONDS) throw new Error('自动扫描间隔最多为 60 秒');
    if (seconds % MONITOR_SCAN_INTERVAL_STEP_SECONDS !== 0) throw new Error('自动扫描间隔必须为 10 秒的整数倍');
    this.database.prepare(`INSERT INTO settings (key, value) VALUES ('monitorScanIntervalSeconds', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(seconds));
  }

  public upsertPackage(item: DiagnosticPackage): void {
    this.database.prepare(`
      INSERT INTO diagnostic_packages (id, source_path, extract_path, report_path, display_name, source_size_bytes, detected_at, status, task_ids, case_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        source_path = excluded.source_path, extract_path = excluded.extract_path, report_path = excluded.report_path,
        display_name = excluded.display_name, source_size_bytes = excluded.source_size_bytes, detected_at = excluded.detected_at, status = excluded.status,
        task_ids = excluded.task_ids, case_id = excluded.case_id
    `).run(item.id, item.sourcePath, item.extractPath, item.reportPath ?? null, item.displayName, item.sourceSizeBytes ?? null, item.detectedAt, item.status, JSON.stringify(item.taskIds), item.caseId);
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

  /**
   * V1 监控只维护一个目录。旧版多目录设置仍保留读写兼容，避免升级时丢失用户已有配置。
   */
  public getMonitorSettings(): MonitorSettings {
    const directoryRow = this.database.prepare("SELECT value FROM settings WHERE key = 'monitorDirectory'").get() as { value: string } | undefined;
    const enabledRow = this.database.prepare("SELECT value FROM settings WHERE key = 'monitorEnabled'").get() as { value: string } | undefined;
    const autoAnalyzeRow = this.database.prepare("SELECT value FROM settings WHERE key = 'monitorAutoAnalyzeEnabled'").get() as { value: string } | undefined;
    const legacyDirectory = this.getMonitorDirectories()[0];
    const directory = directoryRow?.value || legacyDirectory;
    return {
      directory: directory || undefined,
      enabled: enabledRow ? enabledRow.value === 'true' : Boolean(directory),
      autoAnalyzeEnabled: autoAnalyzeRow ? autoAnalyzeRow.value === 'true' : true,
      scanIntervalSeconds: this.getMonitorScanIntervalSeconds()
    };
  }

  public saveMonitorSettings(settings: MonitorSettings): void {
    const directory = settings.directory?.trim();
    this.saveMonitorScanIntervalSeconds(settings.scanIntervalSeconds);
    this.database.prepare(`INSERT INTO settings (key, value) VALUES ('monitorDirectory', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(directory ?? '');
    this.database.prepare(`INSERT INTO settings (key, value) VALUES ('monitorEnabled', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(Boolean(directory && settings.enabled)));
    this.database.prepare(`INSERT INTO settings (key, value) VALUES ('monitorAutoAnalyzeEnabled', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(settings.autoAnalyzeEnabled));
    this.saveMonitorDirectories(directory ? [directory] : []);
  }

  /** V1 结果保存的是工程结论，不保存无限增长的原始日志上下文。 */
  public saveAnalysisResult(packageId: string, taskId: string, result: AnalysisResult): void {
    this.database.exec('BEGIN;');
    try {
      this.database.prepare(`INSERT INTO analysis_results (package_id, task_id, result_json, created_at)
        VALUES (?, ?, ?, ?) ON CONFLICT(package_id) DO UPDATE SET task_id = excluded.task_id, result_json = excluded.result_json, created_at = excluded.created_at`)
        .run(packageId, taskId, JSON.stringify(result), new Date().toISOString());
      this.database.exec(`DELETE FROM analysis_results WHERE package_id IN (
        SELECT package_id FROM analysis_results ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET 20
      );`);
      this.database.exec('COMMIT;');
    } catch (error) {
      this.database.exec('ROLLBACK;');
      throw error;
    }
  }

  public getAnalysisResult(packageId: string): AnalysisResult | undefined {
    const row = this.database.prepare('SELECT result_json AS resultJson FROM analysis_results WHERE package_id = ?').get(packageId) as { resultJson: string } | undefined;
    return row ? JSON.parse(row.resultJson) as AnalysisResult : undefined;
  }

  public listRecentAnalysisResults(limit = 20): Array<{ packageId: string; result: AnalysisResult }> {
    return (this.database.prepare('SELECT package_id AS packageId, result_json AS resultJson FROM analysis_results ORDER BY created_at DESC LIMIT ?').all(Math.min(Math.max(1, limit), 20)) as Array<{ packageId: string; resultJson: string }>)
      .map((row) => ({ packageId: row.packageId, result: JSON.parse(row.resultJson) as AnalysisResult }));
  }

  /** Failed 任务只保存可读诊断信息和输入标识，绝不把失败时的原始日志写入数据库。 */
  public saveAnalysisFailure(packageId: string, taskId: string, stage: string, errorMessage: string, inputMetadata: Record<string, string>): void {
    this.database.prepare(`INSERT INTO analysis_failures (task_id, package_id, stage, error_message, input_metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET stage = excluded.stage, error_message = excluded.error_message, input_metadata = excluded.input_metadata, created_at = excluded.created_at`)
      .run(taskId, packageId, stage, errorMessage, JSON.stringify(inputMetadata), new Date().toISOString());
  }

  public getAnalysisFailure(taskId: string): AnalysisFailureRecord | undefined {
    const row = this.database.prepare(`SELECT task_id AS taskId, package_id AS packageId, stage, error_message AS errorMessage, input_metadata AS inputMetadata, created_at AS createdAt FROM analysis_failures WHERE task_id = ?`).get(taskId) as Omit<AnalysisFailureRecord, 'inputMetadata'> & { inputMetadata: string } | undefined;
    return row ? { ...row, inputMetadata: JSON.parse(row.inputMetadata) as Record<string, string> } : undefined;
  }

  public countLifecycleRecords(packageIds: string[]): { caseCount: number; analysisRecordCount: number; reportRecordCount: number } {
    if (!packageIds.length) return { caseCount: 0, analysisRecordCount: 0, reportRecordCount: 0 };
    const placeholders = packageIds.map(() => '?').join(', ');
    const count = (table: 'analysis_cases' | 'analysis_records' | 'report_index') => (this.database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE package_id IN (${placeholders})`).get(...packageIds) as { count: number }).count;
    return { caseCount: count('analysis_cases'), analysisRecordCount: count('analysis_records'), reportRecordCount: count('report_index') };
  }

  public getPackage(id: string): DiagnosticPackage | undefined { return this.listPackages().find((item) => item.id === id); }

  public listPackages(): DiagnosticPackage[] {
    const rows = this.database.prepare(`SELECT id, source_path AS sourcePath, extract_path AS extractPath, report_path AS reportPath, display_name AS displayName, source_size_bytes AS sourceSizeBytes, detected_at AS detectedAt, status, task_ids AS taskIds, case_id AS caseId FROM diagnostic_packages ORDER BY detected_at DESC`).all() as unknown as Array<Omit<DiagnosticPackage, 'status' | 'taskIds'> & { status: DiagnosticPackageStatus; taskIds: string }>;
    return rows.map((item) => ({ ...item, reportPath: item.reportPath ?? undefined, sourceSizeBytes: item.sourceSizeBytes ?? undefined, taskIds: JSON.parse(item.taskIds) as string[] }));
  }

  public upsertTask(task: AnalysisTaskRecord): void {
    this.database.prepare(`
      INSERT INTO analysis_tasks (id, package_id, scope, status, created_at, started_at, progress, stage, message, error_message, runtime_timings)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET scope = excluded.scope, status = excluded.status, started_at = excluded.started_at, progress = excluded.progress, stage = excluded.stage, message = excluded.message, error_message = excluded.error_message, runtime_timings = excluded.runtime_timings
    `).run(task.id, task.packageId, task.scope, task.status, task.createdAt, task.startedAt ?? null, task.progress, task.stage, task.message, task.errorMessage ?? null, task.runtimeTimings ? JSON.stringify(task.runtimeTimings) : null);
  }

  public getTask(id: string): AnalysisTaskRecord | undefined { return this.listTasks().find((item) => item.id === id); }

  public listTasks(): AnalysisTaskRecord[] {
    const rows = this.database.prepare(`SELECT id, package_id AS packageId, scope, status, created_at AS createdAt, started_at AS startedAt, progress, stage, message, error_message AS errorMessage, runtime_timings AS runtimeTimings FROM analysis_tasks ORDER BY created_at DESC`).all() as unknown as Array<Omit<AnalysisTaskRecord, 'runtimeTimings'> & { runtimeTimings: string | null }>;
    return rows.map((row) => ({ ...row, runtimeTimings: row.runtimeTimings ? JSON.parse(row.runtimeTimings) as AnalysisRuntimeTimings : undefined }));
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

  /** 仅删除诊断包及其数据库记录，原始包、解压目录和报告文件全部保留。 */
  public deletePackageRecords(packageIds: string[]): void {
    if (packageIds.length === 0) return;
    const placeholders = packageIds.map(() => '?').join(', ');
    this.database.exec('BEGIN;');
    try {
      for (const table of ['analysis_failures', 'analysis_results', 'analysis_records', 'report_index', 'analysis_tasks', 'analysis_cases']) {
        this.database.prepare(`DELETE FROM ${table} WHERE package_id IN (${placeholders})`).run(...packageIds);
      }
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
      CREATE TABLE IF NOT EXISTS diagnostic_packages (id TEXT PRIMARY KEY, source_path TEXT NOT NULL, extract_path TEXT NOT NULL, report_path TEXT, display_name TEXT NOT NULL, source_size_bytes INTEGER, detected_at TEXT NOT NULL, status TEXT NOT NULL, task_ids TEXT NOT NULL, case_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS analysis_tasks (id TEXT PRIMARY KEY, package_id TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, started_at TEXT, progress INTEGER NOT NULL, stage TEXT NOT NULL DEFAULT 'identify-package', message TEXT NOT NULL, error_message TEXT, runtime_timings TEXT, FOREIGN KEY(package_id) REFERENCES diagnostic_packages(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS analysis_cases (id TEXT PRIMARY KEY, package_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, FOREIGN KEY(package_id) REFERENCES diagnostic_packages(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS analysis_records (id TEXT PRIMARY KEY, package_id TEXT NOT NULL, task_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, FOREIGN KEY(package_id) REFERENCES diagnostic_packages(id) ON DELETE CASCADE, FOREIGN KEY(task_id) REFERENCES analysis_tasks(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS report_index (package_id TEXT PRIMARY KEY, path TEXT NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY(package_id) REFERENCES diagnostic_packages(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS analysis_results (package_id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE, result_json TEXT NOT NULL, created_at TEXT NOT NULL, FOREIGN KEY(package_id) REFERENCES diagnostic_packages(id) ON DELETE CASCADE, FOREIGN KEY(task_id) REFERENCES analysis_tasks(id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS analysis_failures (task_id TEXT PRIMARY KEY, package_id TEXT NOT NULL, stage TEXT NOT NULL, error_message TEXT NOT NULL, input_metadata TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, FOREIGN KEY(package_id) REFERENCES diagnostic_packages(id) ON DELETE CASCADE, FOREIGN KEY(task_id) REFERENCES analysis_tasks(id) ON DELETE CASCADE);
    `);
    try { this.database.exec("ALTER TABLE analysis_tasks ADD COLUMN scope TEXT NOT NULL DEFAULT 'comprehensive';"); } catch { /* 已升级数据库会报告重复列，保持兼容。 */ }
    try { this.database.exec('ALTER TABLE analysis_tasks ADD COLUMN started_at TEXT;'); } catch { /* 已升级数据库会报告重复列，保持兼容。 */ }
    try { this.database.exec('ALTER TABLE diagnostic_packages ADD COLUMN source_size_bytes INTEGER;'); } catch { /* 新建或已升级数据库均无需处理。 */ }
    try { this.database.exec("ALTER TABLE analysis_tasks ADD COLUMN stage TEXT NOT NULL DEFAULT 'identify-package';"); } catch { /* 新建或已升级数据库均无需处理。 */ }
    try { this.database.exec('ALTER TABLE analysis_tasks ADD COLUMN runtime_timings TEXT;'); } catch { /* 新建或已升级数据库均无需处理。 */ }
    try { this.database.exec("ALTER TABLE analysis_failures ADD COLUMN input_metadata TEXT NOT NULL DEFAULT '{}';"); } catch { /* 新建或已升级数据库均无需处理。 */ }
  }
}
