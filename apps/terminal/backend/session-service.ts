import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Client } from 'ssh2';
import type { ConnectionTarget, SessionSummary } from '../shared/types';
import { AutoRootController } from './auto-root-controller';
import { ShellIntegrationService } from './shell-integration-service';

const MAX_OUTPUT_BYTES = 1024 * 1024;

export interface SessionStream {
  on(event: 'data' | 'close', listener: (...args: any[]) => void): this;
  write(data: string): unknown;
  setWindow(rows: number, cols: number, height?: number, width?: number): unknown;
  end(): unknown;
}

export interface SessionClient {
  on(event: 'ready' | 'error', listener: (...args: any[]) => void): this;
  connect(options: Record<string, unknown>): this;
  shell(callback: (error: Error | undefined, stream: SessionStream) => void): this;
  sftp?(callback: (error: Error | undefined, channel?: unknown) => void): this;
  end(): unknown;
}

export interface SessionServiceOptions {
  createClient?: () => SessionClient;
  readPrivateKey?: (path: string) => Promise<Buffer>;
  createMarker?: () => string;
  onSessionUnavailable?: (sessionId: string) => void;
  emit(event: string, payload: unknown): void;
}

export interface ConnectSessionInput {
  profile: ConnectionTarget;
  secret?: string;
  sudoSecret?: string;
}

interface SessionRecord {
  summary: SessionSummary;
  client: SessionClient;
  stream?: SessionStream;
  output: Buffer;
  secret?: string;
  sudoSecret?: string;
  autoRoot?: AutoRootController;
}

/**
 * 管理同一 terminal backend Worker 中的全部 SSH 会话。
 *
 * 每个 sessionId 独占 Client、PTY、输出快照和状态，renderer 关闭只会停止展示，不会销毁
 * 会话。Workbench 完整退出或用户关闭标签时才显式断开，避免文件传输和长命令因窗口重绘丢失。
 */
export class SessionService {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly createClient: () => SessionClient;
  private readonly readPrivateKey: (path: string) => Promise<Buffer>;
  private readonly createMarker: () => string;
  private readonly shellIntegration: ShellIntegrationService;

  public constructor(private readonly options: SessionServiceOptions) {
    this.createClient = options.createClient ?? (() => new Client() as unknown as SessionClient);
    this.readPrivateKey = options.readPrivateKey ?? ((path) => readFile(path));
    this.createMarker = options.createMarker ?? randomUUID;
    this.shellIntegration = new ShellIntegrationService({
      createMarker: this.createMarker,
      emit: (event, payload) => this.handleIntegrationEvent(event, payload)
    });
  }

  public async connect(input: ConnectSessionInput): Promise<{ id: string }> {
    const id = randomUUID();
    const client = this.createClient();
    const summary: SessionSummary = {
      id,
      title: input.profile.name || `${input.profile.username}@${input.profile.host}`,
      profile: { ...input.profile },
      state: 'connecting',
      integration: input.profile.shellIntegration === false ? 'independent' : 'pending'
    };
    const record: SessionRecord = { summary, client, output: Buffer.alloc(0), secret: input.secret, sudoSecret: input.sudoSecret };
    this.sessions.set(id, record);
    this.emitState(record);

    await this.beginConnection(record);
    return { id };
  }

  public async reconnect(id: string): Promise<{ id: string }> {
    const record = this.require(id);
    const previousClient = record.client;
    const previousStream = record.stream;
    record.stream = undefined;
    record.autoRoot = undefined;
    this.shellIntegration.close(id);
    this.options.onSessionUnavailable?.(id);
    record.client = this.createClient();
    record.summary = { ...record.summary, state: 'connecting', message: undefined, cwd: undefined, integration: record.summary.profile.shellIntegration === false ? 'independent' : 'pending' };
    this.emitState(record);
    previousStream?.end();
    previousClient.end();
    await this.beginConnection(record);
    return { id };
  }

  private async beginConnection(record: SessionRecord): Promise<void> {
    const client = record.client;

    client.on('ready', () => {
      if (record.client !== client) return;
      client.shell((error, stream) => {
        if (record.client !== client) return;
        if (error) { this.fail(record, `无法创建交互终端：${error.message}`); return; }
        record.stream = stream;
        record.summary = { ...record.summary, state: 'connected', message: undefined };
        stream.on('data', (chunk: Buffer | string) => this.handleData(record, chunk));
        stream.on('close', () => {
          if (this.sessions.get(record.summary.id) !== record || record.stream !== stream) return;
          record.stream = undefined;
          this.shellIntegration.close(record.summary.id);
          this.options.onSessionUnavailable?.(record.summary.id);
          record.summary = { ...record.summary, state: 'disconnected', message: 'SSH 会话已关闭。' };
          this.emitState(record);
        });
        this.emitState(record);
        this.options.emit('session.ready', { ...record.summary });
        this.startInteractiveFeatures(record);
      });
    });
    client.on('error', (error: Error) => {
      if (record.client === client) this.fail(record, `SSH 连接失败：${error.message}`);
    });

    try {
      const profile = record.summary.profile;
      const privateKey = profile.auth === 'privateKey' && profile.privateKeyPath
        ? await this.readPrivateKey(profile.privateKeyPath)
        : undefined;
      client.connect({
        host: profile.host,
        port: profile.port || 22,
        username: profile.username,
        password: profile.auth === 'password' ? record.secret : undefined,
        privateKey,
        passphrase: profile.auth === 'privateKey' ? record.secret : undefined,
        hostHash: 'sha256',
        hostVerifier: (fingerprint: string) => {
          if (profile.hostKey === fingerprint) return true;
          this.options.emit('session.host-key', {
            id: record.summary.id,
            profile: { ...profile },
            fingerprint,
            changed: Boolean(profile.hostKey)
          });
          return false;
        }
      });
    } catch (error) {
      this.fail(record, `SSH 连接准备失败：${errorMessage(error)}`);
      throw error;
    }
  }

  public list(): SessionSummary[] {
    return [...this.sessions.values()].map((item) => ({ ...item.summary, profile: { ...item.summary.profile } }));
  }

  public snapshot(id: string): string {
    return this.require(id).output.toString('utf8');
  }

  public input(id: string, data: string): void {
    const record = this.require(id);
    if (!record.stream || record.summary.state !== 'connected') throw new Error('终端尚未连接，无法发送输入。');
    record.stream.write(data);
  }

  public resize(id: string, cols: number, rows: number): void {
    const record = this.require(id);
    if (!record.stream || record.summary.state !== 'connected') return;
    record.stream.setWindow(rows, cols, 0, 0);
  }

  public setIntegration(id: string, enabled: boolean): void {
    const record = this.require(id);
    if (!record.stream || record.summary.state !== 'connected') throw new Error('终端尚未连接，无法切换目录跟随。');
    record.summary = {
      ...record.summary,
      profile: { ...record.summary.profile, shellIntegration: enabled },
      integration: enabled ? 'pending' : record.summary.integration
    };
    if (enabled) {
      this.emitState(record);
      this.shellIntegration.detect(id, record.stream);
    } else {
      this.shellIntegration.disable(id);
    }
  }

  public disconnect(id: string): void {
    const record = this.require(id);
    const stream = record.stream;
    record.stream = undefined;
    this.shellIntegration.close(id);
    this.options.onSessionUnavailable?.(id);
    record.summary = { ...record.summary, state: 'disconnected', message: '已主动断开 SSH 会话。' };
    this.emitState(record);
    this.sessions.delete(id);
    this.options.emit('session.closed', { id });
    stream?.end();
    record.client.end();
  }

  public close(): void {
    for (const record of this.sessions.values()) {
      record.stream?.end();
      record.client.end();
    }
    this.shellIntegration.close();
    this.sessions.clear();
  }

  public openSftp<T = unknown>(id: string): Promise<T> {
    const record = this.require(id);
    if (record.summary.state !== 'connected' || !record.client.sftp) {
      return Promise.reject(new Error('SSH 会话尚未连接，无法打开 SFTP 通道。'));
    }
    return new Promise((resolve, reject) => record.client.sftp!((error, channel) => {
      if (error || !channel) {
        reject(new Error(`无法打开 SFTP 通道：${error?.message ?? '服务器未返回通道'}`));
        return;
      }
      resolve(channel as T);
    }));
  }

  private handleData(record: SessionRecord, chunk: Buffer | string): void {
    let data = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
    if (record.autoRoot) data = record.autoRoot.consume(data);
    data = this.shellIntegration.consume(record.summary.id, data);
    if (!data) return;
    const bytes = Buffer.from(data);
    record.output = Buffer.concat([record.output, bytes]);
    if (record.output.byteLength > MAX_OUTPUT_BYTES) record.output = record.output.subarray(record.output.byteLength - MAX_OUTPUT_BYTES);
    this.options.emit('session.data', { id: record.summary.id, data: bytes.toString('utf8') });
  }

  private startInteractiveFeatures(record: SessionRecord): void {
    if (!record.stream) return;
    if (!record.summary.profile.autoRoot) {
      this.startShellIntegration(record);
      return;
    }
    const sudoSecret = record.sudoSecret ?? (record.summary.profile.auth === 'password' ? record.secret : undefined);
    if (!sudoSecret) {
      this.autoRootFailed(record, '自动切换 root 已跳过：缺少 sudo 密码。已保留普通用户会话。');
      return;
    }
    record.autoRoot = new AutoRootController({
      marker: this.createMarker(),
      secret: sudoSecret,
      write: (data) => record.stream?.write(data),
      onReady: (shell) => {
        record.autoRoot = undefined;
        if (record.summary.profile.shellIntegration === false || !record.stream) return;
        this.shellIntegration.install(record.summary.id, shell, record.stream);
      },
      onFailure: (message) => this.autoRootFailed(record, message)
    });
    record.autoRoot.start();
  }

  private autoRootFailed(record: SessionRecord, message: string): void {
    record.autoRoot = undefined;
    record.summary = { ...record.summary, message };
    this.emitState(record);
    this.options.emit('session.auto-root', { id: record.summary.id, status: 'failed', message });
    this.startShellIntegration(record);
  }

  private startShellIntegration(record: SessionRecord): void {
    if (!record.stream) return;
    if (record.summary.profile.shellIntegration === false) {
      record.summary = { ...record.summary, integration: 'independent' };
      this.emitState(record);
      return;
    }
    this.shellIntegration.detect(record.summary.id, record.stream);
  }

  private handleIntegrationEvent(event: string, payload: unknown): void {
    const value = payload as { id: string; cwd?: string; status?: 'following' | 'independent'; reason?: string };
    const record = this.sessions.get(value.id);
    if (record && event === 'session.cwd' && value.cwd) record.summary = { ...record.summary, cwd: value.cwd };
    if (record && event === 'session.integration' && value.status) {
      record.summary = { ...record.summary, integration: value.status, message: value.reason ?? record.summary.message };
      this.emitState(record);
    }
    this.options.emit(event, payload);
  }

  private fail(record: SessionRecord, message: string): void {
    this.options.onSessionUnavailable?.(record.summary.id);
    record.summary = { ...record.summary, state: 'error', message };
    this.emitState(record);
    this.options.emit('session.error', { id: record.summary.id, message });
  }

  private emitState(record: SessionRecord): void {
    this.options.emit('session.state', { ...record.summary, profile: { ...record.summary.profile } });
  }

  private require(id: string): SessionRecord {
    const record = this.sessions.get(id);
    if (!record) throw new Error('终端会话不存在或已关闭。');
    return record;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
