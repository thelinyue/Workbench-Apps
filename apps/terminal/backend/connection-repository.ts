import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ConnectionCollection, ConnectionProfile, ConnectionTarget, RecentConnection } from '../shared/types';

const MAX_RECENT_CONNECTIONS = 20;

/**
 * 保存 SSH 设备的非敏感配置和最近连接历史。
 *
 * 登录密码、私钥口令及 sudo 密码始终由 Windows Credential Manager 管理，本仓储只能持有
 * 凭据 ID。临时连接写入最近历史时会主动去除所有凭据引用，避免把短期秘密变成持久数据。
 */
export class ConnectionRepository {
  private readonly profilesPath: string;
  private readonly recentPath: string;

  public constructor(private readonly dataDirectory: string) {
    this.profilesPath = join(dataDirectory, 'profiles.json');
    this.recentPath = join(dataDirectory, 'recent-connections.json');
  }

  public async list(): Promise<ConnectionCollection> {
    const [saved, recent] = await Promise.all([
      this.readJson<ConnectionProfile[]>(this.profilesPath, []),
      this.readJson<RecentConnection[]>(this.recentPath, [])
    ]);
    return { saved, recent: recent.sort((left, right) => right.lastConnectedAt.localeCompare(left.lastConnectedAt)).slice(0, MAX_RECENT_CONNECTIONS) };
  }

  public async save(input: ConnectionProfile): Promise<ConnectionProfile> {
    const profiles = (await this.list()).saved;
    const profile = { ...input, id: input.id || randomUUID(), port: input.port || 22 };
    const index = profiles.findIndex((item) => item.id === profile.id);
    if (index >= 0) profiles[index] = profile;
    else profiles.push(profile);
    await this.writeJson(this.profilesPath, profiles);
    return profile;
  }

  public async delete(id: string): Promise<ConnectionProfile | undefined> {
    const profiles = (await this.list()).saved;
    const removed = profiles.find((item) => item.id === id);
    if (!removed) return undefined;
    await this.writeJson(this.profilesPath, profiles.filter((item) => item.id !== id));
    return removed;
  }

  public async recordRecent(input: ConnectionTarget, lastConnectedAt = new Date().toISOString()): Promise<RecentConnection> {
    const recent = (await this.list()).recent;
    const key = targetKey(input);
    const record: RecentConnection = {
      id: recent.find((item) => targetKey(item) === key)?.id ?? randomUUID(),
      name: input.name,
      host: input.host,
      port: input.port,
      username: input.username,
      auth: input.auth,
      ...(input.privateKeyPath ? { privateKeyPath: input.privateKeyPath } : {}),
      ...(input.hostKey ? { hostKey: input.hostKey } : {}),
      ...(input.autoRoot !== undefined ? { autoRoot: input.autoRoot } : {}),
      ...(input.shellIntegration !== undefined ? { shellIntegration: input.shellIntegration } : {}),
      ...(input.notes ? { notes: input.notes } : {}),
      ...(input.savedProfileId ? { savedProfileId: input.savedProfileId } : {}),
      lastConnectedAt
    };
    const next = [record, ...recent.filter((item) => targetKey(item) !== key)]
      .sort((left, right) => right.lastConnectedAt.localeCompare(left.lastConnectedAt))
      .slice(0, MAX_RECENT_CONNECTIONS);
    await this.writeJson(this.recentPath, next);
    return record;
  }

  public async clearRecent(): Promise<void> {
    await this.writeJson(this.recentPath, []);
  }

  private async readJson<T>(path: string, fallback: T): Promise<T> {
    try { return JSON.parse(await readFile(path, 'utf8')) as T; }
    catch { return fallback; }
  }

  private async writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(this.dataDirectory, { recursive: true });
    await writeFile(path, JSON.stringify(value, null, 2), 'utf8');
  }
}

function targetKey(target: Pick<ConnectionTarget, 'host' | 'port' | 'username'>): string {
  return `${target.username}\u0000${target.host.toLowerCase()}\u0000${target.port}`;
}
