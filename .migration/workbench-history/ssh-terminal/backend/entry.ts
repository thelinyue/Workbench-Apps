import { Client } from 'ssh2';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

interface Context { dataDirectory: string; emit(event: string, payload: unknown): void; }
interface Profile { id: string; name: string; host: string; port: number; username: string; auth: 'password' | 'privateKey'; privateKeyPath?: string; credentialId?: string; hostKey?: string; }

/** SSH 应用后端独占连接和配置数据；密码只以 Credential Manager 引用形式保存。 */
export function createAppBackend(context: Context) {
  const profilesPath = join(context.dataDirectory, 'profiles.json');
  const sessions = new Map<string, { client: Client; stream?: { write(data: string): void; setWindow(rows: number, cols: number, height: number, width: number): void; end(): void } }>();
  const load = async (): Promise<Profile[]> => { try { return JSON.parse(await readFile(profilesPath, 'utf8')) as Profile[]; } catch { return []; } };
  const save = async (profiles: Profile[]) => { await mkdir(context.dataDirectory, { recursive: true }); await writeFile(profilesPath, JSON.stringify(profiles, null, 2), 'utf8'); };
  return {
    async invoke(method: string, payload: unknown): Promise<unknown> {
      if (method === 'profiles.list') return load();
      if (method === 'profiles.save') { const input = payload as Profile; const profiles = await load(); const profile = { ...input, id: input.id || randomUUID(), port: input.port || 22 }; const index = profiles.findIndex((item) => item.id === profile.id); if (index >= 0) profiles[index] = profile; else profiles.push(profile); await save(profiles); return profile; }
      if (method === 'profiles.delete') { const id = String((payload as { id: string }).id); await save((await load()).filter((item) => item.id !== id)); return undefined; }
      if (method === 'sessions.connect') {
        const { profile, secret } = payload as { profile: Profile; secret?: string };
        if (!profile.host || !profile.username) throw new Error('请填写主机地址和用户名。');
        const id = randomUUID(); const client = new Client(); sessions.set(id, { client });
        client.on('ready', () => client.shell((error, stream) => { if (error) return context.emit('session.error', { id, message: error.message }); const session = sessions.get(id); if (!session) return; session.stream = stream; stream.on('data', (data: Buffer) => context.emit('session.data', { id, data: data.toString('utf8') })); stream.on('close', () => { sessions.delete(id); context.emit('session.closed', { id }); }); context.emit('session.ready', { id, title: profile.name || `${profile.username}@${profile.host}` }); }))
          .on('error', (error) => context.emit('session.error', { id, message: `SSH 连接失败：${error.message}` }))
          .connect({ host: profile.host, port: profile.port || 22, username: profile.username, password: profile.auth === 'password' ? secret : undefined, privateKey: profile.auth === 'privateKey' && profile.privateKeyPath ? await readFile(profile.privateKeyPath) : undefined, passphrase: profile.auth === 'privateKey' ? secret : undefined, hostHash: 'sha256', hostVerifier: (fingerprint) => { if (!profile.hostKey) context.emit('session.host-key', { id, profile, fingerprint }); return profile.hostKey === fingerprint; } });
        return { id };
      }
      const { id, data, cols, rows } = payload as { id: string; data?: string; cols?: number; rows?: number };
      const session = sessions.get(id); if (!session) throw new Error('终端会话不存在或已关闭。');
      if (method === 'sessions.input') { session.stream?.write(data ?? ''); return undefined; }
      if (method === 'sessions.resize') { session.stream?.setWindow(rows ?? 24, cols ?? 80, 0, 0); return undefined; }
      if (method === 'sessions.disconnect') { session.stream?.end(); session.client.end(); sessions.delete(id); return undefined; }
      throw new Error(`SSH 终端不支持该请求：${method}`);
    },
    close() { for (const session of sessions.values()) session.client.end(); sessions.clear(); }
  };
}
