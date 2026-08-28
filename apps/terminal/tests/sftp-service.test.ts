import { describe, expect, it } from 'vitest';
import { SftpService, type SftpChannel } from '../backend/sftp-service';

function createChannel(): SftpChannel {
  return {
    realpath(_path, callback) { callback(undefined, '/home/ops'); },
    readdir(path, callback) {
      if (path !== '/home/ops') { callback(new Error('unexpected path')); return; }
      callback(undefined, [
        { filename: 'system.log', attrs: { size: 3072, mtime: 100, isDirectory: () => false, isSymbolicLink: () => false } },
        { filename: 'archive', attrs: { size: 0, mtime: 200, isDirectory: () => true, isSymbolicLink: () => false } }
      ]);
    }
  };
}

describe('Session 级 SFTP 文件浏览', () => {
  it('首次浏览从远端主目录开始并把目录排在文件之前', async () => {
    const service = new SftpService(async () => createChannel());

    await expect(service.list('session-1')).resolves.toEqual({
      path: '/home/ops',
      entries: [
        { name: 'archive', path: '/home/ops/archive', kind: 'directory', size: 0, modifiedAt: 200_000 },
        { name: 'system.log', path: '/home/ops/system.log', kind: 'file', size: 3072, modifiedAt: 100_000 }
      ]
    });
  });

  it('不同 Session 保持各自文件目录且拒绝非规范绝对路径', async () => {
    const calls: string[] = [];
    const service = new SftpService(async (sessionId) => ({
      realpath(_path, callback) { callback(undefined, `/home/${sessionId}`); },
      readdir(path, callback) { calls.push(`${sessionId}:${path}`); callback(undefined, []); }
    }));

    await service.list('alpha', '/var/log');
    await service.list('beta', '/srv');
    await service.list('alpha');

    expect(calls).toEqual(['alpha:/var/log', 'beta:/srv', 'alpha:/var/log']);
    await expect(service.list('alpha', '/var/../etc')).rejects.toThrow('远端路径格式无效');
    await expect(service.list('alpha', 'relative/path')).rejects.toThrow('远端路径必须是绝对路径');
  });
});
