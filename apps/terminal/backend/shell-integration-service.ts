import { posix } from 'node:path';
import { OscStreamBuffer } from './osc-stream-buffer';

interface IntegrationStream {
  write(data: string): unknown;
}

interface IntegrationRecord {
  following: boolean;
  outputBuffer: OscStreamBuffer;
}

export interface ShellIntegrationServiceOptions {
  emit(event: string, payload: unknown): void;
}

const OSC7_PATTERN = /\u001b\]7;file:\/\/([^/\u0007\u001b]*)(\/[^\u0007\u001b]*)(?:\u0007|\u001b\\)/g;

/** 从远端终端主动输出的 OSC 7 中提取规范绝对路径，不执行任何远端命令。 */
export function parseOsc7Cwd(data: string): string | undefined {
  let cwd: string | undefined;
  for (const match of data.matchAll(OSC7_PATTERN)) {
    try {
      const decoded = decodeURIComponent(match[2]);
      if (!posix.isAbsolute(decoded) || decoded.includes('\u0000') || posix.normalize(decoded) !== decoded) continue;
      cwd = decoded;
    } catch { /* 非法转义序列直接忽略，不能影响终端数据主链路。 */ }
  }
  return cwd;
}

/**
 * 被动监听远端 shell 原生 OSC 7 的目录上报。
 *
 * 本服务不会向 PTY 写入探测、钩子或恢复命令，也不读写远端文件。SFTP 与终端 shell
 * 没有共享 cwd；未收到 OSC 7 时文件面板保持独立导航，终端输入输出继续正常透传。
 */
export class ShellIntegrationService {
  private readonly records = new Map<string, IntegrationRecord>();

  public constructor(private readonly options: ShellIntegrationServiceOptions) {}

  public detect(sessionId: string, _stream: IntegrationStream): void {
    this.records.set(sessionId, { following: false, outputBuffer: new OscStreamBuffer() });
    this.options.emit('session.integration', {
      id: sessionId,
      status: 'independent',
      reason: '远端尚未主动上报当前目录，文件面板使用独立导航。'
    });
  }

  public consume(sessionId: string, data: string): string {
    const record = this.records.get(sessionId);
    if (!record) return data;
    return record.outputBuffer.consume(data, (completeData) => completeData.replace(OSC7_PATTERN, (sequence) => {
      const cwd = parseOsc7Cwd(sequence);
      if (!cwd) return '';
      this.options.emit('session.cwd', { id: sessionId, cwd });
      if (!record.following) {
        record.following = true;
        this.options.emit('session.integration', { id: sessionId, status: 'following' });
      }
      return '';
    }));
  }

  public disable(sessionId: string): void {
    if (!this.records.delete(sessionId)) return;
    this.options.emit('session.integration', {
      id: sessionId,
      status: 'independent',
      reason: '已关闭跟随终端目录，文件面板使用独立导航。'
    });
  }

  public close(sessionId?: string): void {
    if (sessionId) this.records.delete(sessionId);
    else this.records.clear();
  }
}
