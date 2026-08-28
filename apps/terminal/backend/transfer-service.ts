import { access, createReadStream, createWriteStream, rename, rm, stat as localStat } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { Readable, Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { basename, posix } from 'node:path';
import type { TransferTask } from '../shared/types';

export interface TransferChannel {
  stat(path: string, callback: (error: Error | undefined, attributes?: { size: number }) => void): void;
  createReadStream(path: string): Readable;
  createWriteStream(path: string): Writable;
  rename(from: string, to: string, callback: (error?: Error) => void): void;
  unlink(path: string, callback: (error?: Error) => void): void;
}

export interface TransferServiceOptions {
  openChannel(sessionId: string): Promise<TransferChannel>;
  emit(event: string, payload: unknown): void;
}

interface TransferRecord {
  task: TransferTask;
  source?: Readable;
  destination?: Writable;
  temporaryPath: string;
  channel?: TransferChannel;
  overwrite: boolean;
  startedAt: number;
}

/**
 * 在 terminal backend 生命周期内管理文件传输流。
 *
 * renderer 只订阅任务快照，不拥有文件流；关闭独立窗口不会中断传输。下载始终先写目标目录
 * 中的临时文件，完整成功后再重命名，避免失败或取消后留下看似完整的损坏文件。
 */
export class TransferService {
  private readonly records = new Map<string, TransferRecord>();

  public constructor(private readonly options: TransferServiceOptions) {}

  public async download(input: { sessionId: string; remotePath: string; localPath: string; overwrite: boolean }): Promise<TransferTask> {
    if (!input.overwrite && await exists(input.localPath)) throw new Error('本地目标文件已存在，请确认覆盖后重试。');
    const id = randomUUID();
    const temporaryPath = `${input.localPath}.workbench-part-${id}`;
    const task: TransferTask = {
      id,
      sessionId: input.sessionId,
      direction: 'download',
      name: input.remotePath.split('/').pop() || input.remotePath,
      localPath: input.localPath,
      remotePath: input.remotePath,
      transferredBytes: 0,
      totalBytes: 0,
      state: 'queued',
      speedBytesPerSecond: 0
    };
    const record: TransferRecord = { task, temporaryPath, overwrite: input.overwrite, startedAt: Date.now() };
    this.records.set(id, record);
    this.emit(record);

    const channel = await this.options.openChannel(input.sessionId);
    task.totalBytes = (await remoteStat(channel, input.remotePath)).size;
    task.state = 'running';
    record.source = channel.createReadStream(input.remotePath);
    record.destination = createWriteStream(temporaryPath);
    record.source.on('data', (chunk: Buffer | string) => {
      task.transferredBytes += Buffer.byteLength(chunk);
      const elapsedSeconds = Math.max((Date.now() - record.startedAt) / 1000, 0.001);
      task.speedBytesPerSecond = Math.round(task.transferredBytes / elapsedSeconds);
      this.emit(record);
    });
    this.emit(record);
    void pipeline(record.source, record.destination)
      .then(() => renameFile(temporaryPath, input.localPath))
      .then(() => {
        task.state = 'completed';
        task.transferredBytes = task.totalBytes;
        task.speedBytesPerSecond = 0;
        record.source = undefined;
        record.destination = undefined;
        this.emit(record);
      })
      .catch((error) => this.fail(record, error));
    return { ...task };
  }

  public async upload(input: { sessionId: string; localPaths: string[]; remoteDirectory: string; overwrite: boolean }): Promise<TransferTask[]> {
    const channel = await this.options.openChannel(input.sessionId);
    const tasks: TransferTask[] = [];
    for (const localPath of input.localPaths) {
      const fileName = basename(localPath);
      const remotePath = posix.join(input.remoteDirectory, fileName);
      if (!input.overwrite && await remoteExists(channel, remotePath)) throw new Error(`远端文件已存在：${remotePath}。请确认覆盖后重试。`);
      const id = randomUUID();
      const temporaryPath = `${remotePath}.workbench-part-${id}`;
      const totalBytes = (await localFileStat(localPath)).size;
      const task: TransferTask = {
        id,
        sessionId: input.sessionId,
        direction: 'upload',
        name: fileName,
        localPath,
        remotePath,
        transferredBytes: 0,
        totalBytes,
        state: 'running',
        speedBytesPerSecond: 0
      };
      const record: TransferRecord = { task, temporaryPath, channel, overwrite: input.overwrite, startedAt: Date.now() };
      this.records.set(id, record);
      record.source = createReadStream(localPath);
      record.destination = channel.createWriteStream(temporaryPath);
      record.source.on('data', (chunk: Buffer | string) => this.progress(record, chunk));
      this.emit(record);
      void pipeline(record.source, record.destination)
        .then(async () => {
          if (input.overwrite && await remoteExists(channel, remotePath)) await remoteUnlink(channel, remotePath);
          await remoteRename(channel, temporaryPath, remotePath);
        })
        .then(() => this.complete(record))
        .catch((error) => this.fail(record, error));
      tasks.push({ ...task });
    }
    return tasks;
  }

  public list(): TransferTask[] {
    return [...this.records.values()].map((record) => ({ ...record.task }));
  }

  public pause(id: string): void {
    const record = this.require(id);
    if (record.task.state !== 'running' || !record.source) return;
    record.source.pause();
    record.task.state = 'paused';
    record.task.speedBytesPerSecond = 0;
    this.emit(record);
  }

  public resume(id: string): void {
    const record = this.require(id);
    if (record.task.state !== 'paused' || !record.source) return;
    record.startedAt = Date.now() - Math.round(record.task.transferredBytes / Math.max(record.task.speedBytesPerSecond, 1) * 1000);
    record.task.state = 'running';
    record.source.resume();
    this.emit(record);
  }

  public pauseAll(): number {
    let count = 0;
    for (const record of this.records.values()) {
      if (record.task.state !== 'running') continue;
      this.pause(record.task.id);
      count += 1;
    }
    return count;
  }

  public async retry(id: string): Promise<TransferTask> {
    const record = this.require(id);
    if (record.task.state !== 'failed' && record.task.state !== 'cancelled') throw new Error('只有失败或已取消的传输任务可以重试。');
    if (record.task.direction === 'download') {
      return this.download({
        sessionId: record.task.sessionId,
        remotePath: record.task.remotePath,
        localPath: record.task.localPath,
        overwrite: record.overwrite
      });
    }
    const [task] = await this.upload({
      sessionId: record.task.sessionId,
      localPaths: [record.task.localPath],
      remoteDirectory: posix.dirname(record.task.remotePath),
      overwrite: record.overwrite
    });
    return task;
  }

  public async cancel(id: string): Promise<void> {
    const record = this.require(id);
    if (!['queued', 'running', 'paused'].includes(record.task.state)) return;
    record.task.state = 'cancelled';
    record.task.speedBytesPerSecond = 0;
    record.source?.destroy();
    record.destination?.destroy();
    record.source = undefined;
    record.destination = undefined;
    await this.cleanupTemporary(record);
    this.emit(record);
  }

  public clearCompleted(): number {
    const completed = [...this.records.values()].filter((record) => record.task.state === 'completed');
    completed.forEach((record) => this.records.delete(record.task.id));
    return completed.length;
  }

  /** Workbench 完整退出时统一取消活动流，并等待临时文件清理结束。 */
  public async close(): Promise<void> {
    const active = [...this.records.values()]
      .filter((record) => ['queued', 'running', 'paused'].includes(record.task.state));
    await Promise.all(active.map((record) => this.cancel(record.task.id)));
  }

  private async fail(record: TransferRecord, error: unknown): Promise<void> {
    if (record.task.state === 'cancelled') return;
    record.task.state = 'failed';
    record.task.speedBytesPerSecond = 0;
    record.task.message = `文件传输失败：${error instanceof Error ? error.message : String(error)}`;
    record.source = undefined;
    record.destination = undefined;
    await this.cleanupTemporary(record);
    this.emit(record);
  }

  private progress(record: TransferRecord, chunk: Buffer | string): void {
    record.task.transferredBytes += Buffer.byteLength(chunk);
    const elapsedSeconds = Math.max((Date.now() - record.startedAt) / 1000, 0.001);
    record.task.speedBytesPerSecond = Math.round(record.task.transferredBytes / elapsedSeconds);
    this.emit(record);
  }

  private complete(record: TransferRecord): void {
    record.task.state = 'completed';
    record.task.transferredBytes = record.task.totalBytes;
    record.task.speedBytesPerSecond = 0;
    record.source = undefined;
    record.destination = undefined;
    this.emit(record);
  }

  private cleanupTemporary(record: TransferRecord): Promise<void> {
    return record.task.direction === 'upload' && record.channel
      ? remoteUnlink(record.channel, record.temporaryPath, true)
      : removeFile(record.temporaryPath);
  }

  private emit(record: TransferRecord): void {
    this.options.emit('transfer.changed', { ...record.task });
  }

  private require(id: string): TransferRecord {
    const record = this.records.get(id);
    if (!record) throw new Error('找不到指定的文件传输任务。');
    return record;
  }
}

function remoteStat(channel: TransferChannel, path: string): Promise<{ size: number }> {
  return new Promise((resolve, reject) => channel.stat(path, (error, attributes) => error || !attributes ? reject(new Error(`无法读取远端文件信息：${error?.message ?? '服务器未返回文件信息'}`)) : resolve(attributes)));
}

function remoteExists(channel: TransferChannel, path: string): Promise<boolean> {
  return new Promise((resolve) => channel.stat(path, (error, attributes) => resolve(!error && Boolean(attributes))));
}

function remoteRename(channel: TransferChannel, from: string, to: string): Promise<void> {
  return new Promise((resolve, reject) => channel.rename(from, to, (error) => error ? reject(error) : resolve()));
}

function remoteUnlink(channel: TransferChannel, path: string, ignoreError = false): Promise<void> {
  return new Promise((resolve, reject) => channel.unlink(path, (error) => error && !ignoreError ? reject(error) : resolve()));
}

function localFileStat(path: string): Promise<{ size: number }> {
  return new Promise((resolve, reject) => localStat(path, (error, result) => error ? reject(new Error(`无法读取本地文件信息：${error.message}`)) : resolve({ size: result.size })));
}

function exists(path: string): Promise<boolean> {
  return new Promise((resolve) => access(path, (error) => resolve(!error)));
}

function renameFile(from: string, to: string): Promise<void> {
  return new Promise((resolve, reject) => rename(from, to, (error) => error ? reject(error) : resolve()));
}

function removeFile(path: string): Promise<void> {
  return new Promise((resolve) => rm(path, { force: true }, () => resolve()));
}
