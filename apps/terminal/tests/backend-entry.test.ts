import { describe, expect, it } from 'vitest';
import { createTerminalBackend } from '../backend/entry';

describe('SSH backend RPC 编排', () => {
  it('把连接、会话、SFTP 与传输请求路由到对应服务', async () => {
    const calls: string[] = [];
    const backend = createTerminalBackend({ emit: () => undefined }, {
      connections: {
        list: async () => ({ saved: [], recent: [] }),
        save: async (value) => { calls.push(`connections.save:${value.host}`); return value; },
        delete: async (id) => { calls.push(`connections.delete:${id}`); return undefined; },
        clearRecent: async () => { calls.push('connections.clearRecent'); }
      },
      sessions: {
        list: () => [],
        connect: async (value) => { calls.push(`sessions.connect:${value.profile.host}`); return { id: 'session-1' }; },
        reconnect: async (id) => { calls.push(`sessions.reconnect:${id}`); return { id }; },
        input: (id, data) => calls.push(`sessions.input:${id}:${data}`),
        resize: (id, cols, rows) => calls.push(`sessions.resize:${id}:${cols}x${rows}`),
        disconnect: (id) => calls.push(`sessions.disconnect:${id}`),
        snapshot: (id) => `snapshot:${id}`,
        setIntegration: (id, enabled) => calls.push(`sessions.integration:${id}:${enabled}`),
        close: () => calls.push('sessions.close')
      },
      sftp: {
        list: async (id, path) => { calls.push(`sftp.list:${id}:${path}`); return { path: path ?? '/', entries: [] }; },
        follow: () => undefined,
        close: () => calls.push('sftp.close')
      },
      transfers: {
        list: () => [],
        upload: async (value) => { calls.push(`sftp.upload:${value.sessionId}`); return []; },
        download: async (value) => { calls.push(`sftp.download:${value.sessionId}`); return { id: 'transfer-1' }; },
        pause: (id) => calls.push(`transfers.pause:${id}`),
        resume: (id) => calls.push(`transfers.resume:${id}`),
        cancel: async (id) => { calls.push(`transfers.cancel:${id}`); },
        retry: async (id) => { calls.push(`transfers.retry:${id}`); return { id: 'retry' }; },
        pauseAll: () => { calls.push('transfers.pauseAll'); return 1; },
        clearCompleted: () => { calls.push('transfers.clearCompleted'); return 2; },
        close: async () => { calls.push('transfers.close'); }
      }
    });

    await backend.invoke('connections.save', { host: 'server' });
    await backend.invoke('sessions.connect', { profile: { host: 'server' } });
    await backend.invoke('sessions.resize', { id: 'session-1', cols: 120, rows: 36 });
    await backend.invoke('sessions.integration', { id: 'session-1', enabled: false });
    await backend.invoke('sftp.list', { id: 'session-1', path: '/var/log' });
    await backend.invoke('sftp.upload', { sessionId: 'session-1', localPaths: ['a'], remoteDirectory: '/tmp', overwrite: false });
    await backend.invoke('transfers.pauseAll', {});

    expect(calls).toEqual([
      'connections.save:server',
      'sessions.connect:server',
      'sessions.resize:session-1:120x36',
      'sessions.integration:session-1:false',
      'sftp.list:session-1:/var/log',
      'sftp.upload:session-1',
      'transfers.pauseAll'
    ]);
    await expect(backend.invoke('unknown.method', {})).rejects.toThrow('SSH 终端不支持该请求');
  });

  it('完整退出时等待传输临时文件清理，再关闭会话和 SFTP 状态', async () => {
    const order: string[] = [];
    const backend = createTerminalBackend({ emit: () => undefined }, {
      connections: {} as never,
      sessions: { close: () => order.push('sessions') } as never,
      sftp: { close: () => order.push('sftp') } as never,
      transfers: { close: async () => { order.push('transfers'); } } as never
    });

    await backend.close();

    expect(order).toEqual(['transfers', 'sessions', 'sftp']);
  });
});
