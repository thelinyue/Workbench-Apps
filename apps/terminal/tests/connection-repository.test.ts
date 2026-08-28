import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConnectionRepository } from '../backend/connection-repository';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createRepository() {
  const directory = await mkdtemp(join(tmpdir(), 'terminal-connections-'));
  directories.push(directory);
  return { directory, repository: new ConnectionRepository(directory) };
}

describe('SSH 连接仓储', () => {
  it('兼容读取旧版 profiles.json 数组且不会凭空生成最近连接', async () => {
    const { directory, repository } = await createRepository();
    await writeFile(join(directory, 'profiles.json'), JSON.stringify([{
      id: 'saved-1', name: '生产机', host: '10.0.0.8', port: 22, username: 'root', auth: 'password', credentialId: 'credential-1'
    }]), 'utf8');

    await expect(repository.list()).resolves.toEqual({
      saved: [{ id: 'saved-1', name: '生产机', host: '10.0.0.8', port: 22, username: 'root', auth: 'password', credentialId: 'credential-1' }],
      recent: []
    });
  });

  it('临时连接只写入不含任何秘密和凭据引用的最近记录', async () => {
    const { directory, repository } = await createRepository();
    await repository.recordRecent({
      name: '临时机', host: '10.0.0.9', port: 2222, username: 'ops', auth: 'privateKey', privateKeyPath: 'C:/keys/ops', hostKey: 'SHA256:key'
    }, '2026-08-28T10:00:00.000Z');

    const stored = await readFile(join(directory, 'recent-connections.json'), 'utf8');
    expect(stored).not.toContain('credentialId');
    expect(stored).not.toContain('sudoCredentialId');
    expect(stored).not.toContain('secret');
    await expect(repository.list()).resolves.toMatchObject({
      recent: [{ host: '10.0.0.9', port: 2222, username: 'ops', lastConnectedAt: '2026-08-28T10:00:00.000Z' }]
    });
  });

  it('同一目标只保留最新记录并将最近连接限制为二十条', async () => {
    const { repository } = await createRepository();
    for (let index = 0; index < 22; index += 1) {
      await repository.recordRecent({ name: `设备 ${index}`, host: `10.0.0.${index}`, port: 22, username: 'ops', auth: 'password' }, new Date(index * 1000).toISOString());
    }
    await repository.recordRecent({ name: '设备 10 新名称', host: '10.0.0.10', port: 22, username: 'ops', auth: 'password' }, new Date(30_000).toISOString());

    const result = await repository.list();
    expect(result.recent).toHaveLength(20);
    expect(result.recent[0]).toMatchObject({ name: '设备 10 新名称', host: '10.0.0.10' });
    expect(result.recent.filter((item) => item.host === '10.0.0.10')).toHaveLength(1);
  });
});
