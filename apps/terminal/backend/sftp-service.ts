import { posix } from 'node:path';
import type { RemoteFileEntry } from '../shared/types';

export interface SftpFileAttributes {
  size: number;
  mtime?: number;
  isDirectory?(): boolean;
  isSymbolicLink?(): boolean;
}

export interface SftpChannel {
  realpath(path: string, callback: (error: Error | undefined, resolvedPath?: string) => void): void;
  readdir(path: string, callback: (error: Error | undefined, entries?: Array<{ filename: string; attrs: SftpFileAttributes }>) => void): void;
}

/**
 * 维护每个 SSH Session 独立的 SFTP Channel 与当前浏览目录。
 * 文件面板可以跟随 Shell Integration 上报的 cwd，但本服务绝不会向 PTY 发送 cd 命令，
 * 因此 SFTP 导航不会反向改变用户正在操作的终端环境。
 */
export class SftpService {
  private readonly channels = new Map<string, Promise<SftpChannel>>();
  private readonly currentPaths = new Map<string, string>();

  public constructor(private readonly openChannel: (sessionId: string) => Promise<SftpChannel>) {}

  public async list(sessionId: string, requestedPath?: string): Promise<{ path: string; entries: RemoteFileEntry[] }> {
    const channel = await this.channel(sessionId);
    const path = requestedPath
      ? validateRemotePath(requestedPath)
      : this.currentPaths.get(sessionId) ?? validateRemotePath(await realpath(channel, '.'));
    const entries = await readdir(channel, path);
    this.currentPaths.set(sessionId, path);
    return {
      path,
      entries: entries.map((entry) => ({
        name: entry.filename,
        path: posix.join(path, entry.filename),
        kind: fileKind(entry.attrs),
        size: entry.attrs.size,
        ...(typeof entry.attrs.mtime === 'number' ? { modifiedAt: entry.attrs.mtime * 1000 } : {})
      })).sort((left, right) => {
        if (left.kind === 'directory' && right.kind !== 'directory') return -1;
        if (left.kind !== 'directory' && right.kind === 'directory') return 1;
        return left.name.localeCompare(right.name, 'zh-CN');
      })
    };
  }

  public follow(sessionId: string, cwd: string): void {
    this.currentPaths.set(sessionId, validateRemotePath(cwd));
  }

  public close(sessionId?: string): void {
    if (sessionId) { this.channels.delete(sessionId); this.currentPaths.delete(sessionId); return; }
    this.channels.clear();
    this.currentPaths.clear();
  }

  private channel(sessionId: string): Promise<SftpChannel> {
    let channel = this.channels.get(sessionId);
    if (!channel) {
      channel = this.openChannel(sessionId);
      this.channels.set(sessionId, channel);
      void channel.catch(() => this.channels.delete(sessionId));
    }
    return channel;
  }
}

function fileKind(attributes: SftpFileAttributes): RemoteFileEntry['kind'] {
  if (attributes.isDirectory?.()) return 'directory';
  if (attributes.isSymbolicLink?.()) return 'link';
  return 'file';
}

function validateRemotePath(path: string): string {
  if (!posix.isAbsolute(path)) throw new Error('远端路径必须是绝对路径。');
  if (path.includes('\u0000') || posix.normalize(path) !== path) throw new Error('远端路径格式无效。');
  return path;
}

function realpath(channel: SftpChannel, path: string): Promise<string> {
  return new Promise((resolve, reject) => channel.realpath(path, (error, result) => error || !result ? reject(new Error(`无法读取远端主目录：${error?.message ?? '服务器未返回路径'}`)) : resolve(result)));
}

function readdir(channel: SftpChannel, path: string): Promise<Array<{ filename: string; attrs: SftpFileAttributes }>> {
  return new Promise((resolve, reject) => channel.readdir(path, (error, entries) => error ? reject(new Error(`无法读取远端目录 ${path}：${error.message}`)) : resolve(entries ?? [])));
}
