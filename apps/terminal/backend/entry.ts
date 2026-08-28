import type { ConnectionProfile } from '../shared/types';
import { ConnectionRepository } from './connection-repository';
import { SessionService, type ConnectSessionInput } from './session-service';
import { SftpService, type SftpChannel } from './sftp-service';
import { TransferService, type TransferChannel } from './transfer-service';

interface AppBackendContext {
  dataDirectory: string;
  emit(event: string, payload: unknown): void;
}

interface TerminalBackendContext {
  emit(event: string, payload: unknown): void;
}

interface AppBackend {
  invoke(method: string, payload: unknown): Promise<unknown>;
  close(): Promise<void>;
}

export interface TerminalBackendServices {
  connections: Pick<ConnectionRepository, 'list' | 'save' | 'delete' | 'clearRecent'>;
  sessions: Pick<SessionService, 'list' | 'connect' | 'reconnect' | 'input' | 'resize' | 'disconnect' | 'snapshot' | 'setIntegration' | 'close'>;
  sftp: Pick<SftpService, 'list' | 'follow' | 'close'>;
  transfers: Pick<TransferService, 'list' | 'upload' | 'download' | 'pause' | 'resume' | 'cancel' | 'retry' | 'pauseAll' | 'clearCompleted' | 'close'>;
}

/**
 * SSH 应用 backend 的组合入口。
 *
 * 入口只负责 RPC 路由和关闭顺序；SSH Client、PTY、SFTP Channel 与传输流分别由服务持有。
 * Presentation Host 关闭不会调用这里的 close，只有 Workbench 完整退出才会取消传输并断开会话。
 */
export function createAppBackend(context: AppBackendContext): AppBackend {
  const connections = new ConnectionRepository(context.dataDirectory);
  let sftp: SftpService;
  const sessions = new SessionService({
    onSessionUnavailable: (sessionId) => sftp.close(sessionId),
    emit: (event, payload) => {
      if (event === 'session.cwd') {
        const value = payload as { id: string; cwd: string };
        sftp.follow(value.id, value.cwd);
      }
      if (event === 'session.ready') {
        const value = payload as { profile: ConnectSessionInput['profile'] };
        void connections.recordRecent(value.profile).catch((error) => {
          console.error(`记录最近 SSH 连接失败：${error instanceof Error ? error.message : String(error)}`);
        });
      }
      context.emit(event, payload);
    }
  });
  const openChannel = <T>() => (sessionId: string) => sessions.openSftp<T>(sessionId);
  sftp = new SftpService(openChannel<SftpChannel>());
  const transfers = new TransferService({ openChannel: openChannel<TransferChannel>(), emit: context.emit });
  return createTerminalBackend(context, { connections, sessions, sftp, transfers });
}

/** 可注入服务的路由层，用于验证公开 RPC 契约而不建立真实网络连接。 */
export function createTerminalBackend(context: TerminalBackendContext, services: TerminalBackendServices): AppBackend {
  return {
    async invoke(method, payload) {
      switch (method) {
        case 'connections.list': return services.connections.list();
        case 'connections.save': return services.connections.save(payload as ConnectionProfile);
        case 'connections.delete': return services.connections.delete(readId(payload));
        case 'connections.clearRecent': return services.connections.clearRecent();
        case 'sessions.list': return services.sessions.list();
        case 'sessions.connect': return services.sessions.connect(payload as ConnectSessionInput);
        case 'sessions.reconnect': return services.sessions.reconnect(readId(payload));
        case 'sessions.input': {
          const value = readRecord(payload);
          services.sessions.input(readString(value, 'id'), readString(value, 'data', true));
          return undefined;
        }
        case 'sessions.resize': {
          const value = readRecord(payload);
          services.sessions.resize(readString(value, 'id'), readPositiveInteger(value, 'cols'), readPositiveInteger(value, 'rows'));
          return undefined;
        }
        case 'sessions.disconnect': services.sessions.disconnect(readId(payload)); return undefined;
        case 'sessions.snapshot': return services.sessions.snapshot(readId(payload));
        case 'sessions.integration': {
          const value = readRecord(payload);
          services.sessions.setIntegration(readString(value, 'id'), readBoolean(value, 'enabled'));
          return undefined;
        }
        case 'sftp.list': {
          const value = readRecord(payload);
          return services.sftp.list(readString(value, 'id'), readOptionalString(value, 'path'));
        }
        case 'sftp.upload': return services.transfers.upload(payload as Parameters<TransferService['upload']>[0]);
        case 'sftp.download': return services.transfers.download(payload as Parameters<TransferService['download']>[0]);
        case 'transfers.list': return services.transfers.list();
        case 'transfers.pause': services.transfers.pause(readId(payload)); return undefined;
        case 'transfers.resume': services.transfers.resume(readId(payload)); return undefined;
        case 'transfers.cancel': return services.transfers.cancel(readId(payload));
        case 'transfers.retry': return services.transfers.retry(readId(payload));
        case 'transfers.pauseAll': return services.transfers.pauseAll();
        case 'transfers.clearCompleted': return services.transfers.clearCompleted();
        default: throw new Error(`SSH 终端不支持该请求：${method}`);
      }
    },
    async close() {
      await services.transfers.close();
      services.sessions.close();
      services.sftp.close();
    }
  };
}

function readRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('SSH 终端请求参数必须是对象。');
  return value as Record<string, unknown>;
}

function readId(value: unknown): string {
  return readString(readRecord(value), 'id');
}

function readString(value: Record<string, unknown>, key: string, allowEmpty = false): string {
  const actual = value[key];
  if (typeof actual !== 'string' || (!allowEmpty && !actual.trim())) throw new Error(`SSH 终端请求缺少有效字段：${key}。`);
  return actual;
}

function readOptionalString(value: Record<string, unknown>, key: string): string | undefined {
  const actual = value[key];
  if (actual === undefined) return undefined;
  if (typeof actual !== 'string' || !actual.trim()) throw new Error(`SSH 终端请求字段格式无效：${key}。`);
  return actual;
}

function readPositiveInteger(value: Record<string, unknown>, key: string): number {
  const actual = value[key];
  if (typeof actual !== 'number' || !Number.isInteger(actual) || actual <= 0) throw new Error(`SSH 终端请求缺少有效正整数：${key}。`);
  return actual;
}

function readBoolean(value: Record<string, unknown>, key: string): boolean {
  const actual = value[key];
  if (typeof actual !== 'boolean') throw new Error(`SSH 终端请求缺少布尔字段：${key}。`);
  return actual;
}
