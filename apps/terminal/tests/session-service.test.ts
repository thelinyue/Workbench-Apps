import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { SessionService, type SessionClient, type SessionStream } from '../backend/session-service';
import type { ConnectionTarget } from '../shared/types';

class FakeStream extends EventEmitter implements SessionStream {
  public readonly writes: string[] = [];
  public readonly windows: Array<{ rows: number; cols: number }> = [];
  public ended = false;
  public write(data: string) { this.writes.push(data); return true; }
  public setWindow(rows: number, cols: number) { this.windows.push({ rows, cols }); }
  public end() { this.ended = true; }
}

class FakeClient extends EventEmitter implements SessionClient {
  public readonly stream = new FakeStream();
  public readonly sftpChannel = { name: 'sftp-channel' };
  public ended = false;
  public connectOptions?: { hostVerifier?: (fingerprint: string) => boolean };
  public connect(options: { hostVerifier?: (fingerprint: string) => boolean }) { this.connectOptions = options; return this; }
  public shell(callback: (error: Error | undefined, stream: SessionStream) => void) { callback(undefined, this.stream); return this; }
  public sftp(callback: (error: Error | undefined, channel?: unknown) => void) { callback(undefined, this.sftpChannel); return this; }
  public end() { this.ended = true; }
}

const target = (name: string): ConnectionTarget => ({ name, host: `${name}.example.com`, port: 22, username: 'ops', auth: 'password', shellIntegration: false });

describe('SSH 多会话服务', () => {
  it('按 sessionId 隔离终端输入、输出和窗口尺寸', async () => {
    const firstClient = new FakeClient();
    const secondClient = new FakeClient();
    const clients = [firstClient, secondClient];
    const events: Array<{ event: string; payload: unknown }> = [];
    const service = new SessionService({ createClient: () => clients.shift()!, emit: (event, payload) => events.push({ event, payload }) });
    const first = await service.connect({ profile: target('alpha'), secret: 'secret-a' });
    const second = await service.connect({ profile: target('beta'), secret: 'secret-b' });
    firstClient.emit('ready');
    secondClient.emit('ready');
    firstClient.stream.emit('data', Buffer.from('alpha-output'));
    secondClient.stream.emit('data', Buffer.from('beta-output'));

    service.input(first.id, 'pwd\n');
    service.resize(second.id, 120, 36);

    expect(firstClient.stream.writes).toEqual(['pwd\n']);
    expect(secondClient.stream.writes).toEqual([]);
    expect(secondClient.stream.windows).toEqual([{ rows: 36, cols: 120 }]);
    expect(service.snapshot(first.id)).toBe('alpha-output');
    expect(service.snapshot(second.id)).toBe('beta-output');
    expect(events.filter((item) => item.event === 'session.data')).toHaveLength(2);
  });

  it('把恢复快照限制在最后 1 MiB 且窗口关闭不销毁会话', async () => {
    const client = new FakeClient();
    const service = new SessionService({ createClient: () => client, emit: () => undefined });
    const session = await service.connect({ profile: target('buffer'), secret: 'secret' });
    client.emit('ready');
    client.stream.emit('data', Buffer.from(`prefix-${'x'.repeat(1024 * 1024)}`));

    const snapshot = Buffer.from(service.snapshot(session.id));
    expect(snapshot.byteLength).toBe(1024 * 1024);
    expect(snapshot.toString().startsWith('prefix-')).toBe(false);
    expect(service.list()).toMatchObject([{ id: session.id, state: 'connected' }]);
    expect(client.ended).toBe(false);
  });

  it('主动关闭标签后忽略旧 PTY 延迟到达的 close 事件', async () => {
    const client = new FakeClient();
    const events: Array<{ event: string; payload: unknown }> = [];
    const service = new SessionService({ createClient: () => client, emit: (event, payload) => events.push({ event, payload }) });
    const session = await service.connect({ profile: target('closed-tab'), secret: 'secret' });
    client.emit('ready');

    service.disconnect(session.id);
    const eventCountAfterDisconnect = events.length;
    client.stream.emit('close');

    expect(service.list()).toEqual([]);
    expect(events).toHaveLength(eventCountAfterDisconnect);
    expect(events.at(-1)).toEqual({ event: 'session.closed', payload: { id: session.id } });
  });

  it('重连前通知依赖服务释放该 Session 的旧通道', async () => {
    const firstClient = new FakeClient();
    const secondClient = new FakeClient();
    const clients = [firstClient, secondClient];
    const unavailable: string[] = [];
    const service = new SessionService({
      createClient: () => clients.shift()!,
      emit: () => undefined,
      onSessionUnavailable: (id) => unavailable.push(id)
    });
    const session = await service.connect({ profile: target('reconnect'), secret: 'secret' });
    firstClient.emit('ready');

    await service.reconnect(session.id);

    expect(unavailable).toEqual([session.id]);
  });

  it('首次主机指纹不可信时发出确认事件并拒绝本次握手', async () => {
    const client = new FakeClient();
    const events: Array<{ event: string; payload: unknown }> = [];
    const service = new SessionService({ createClient: () => client, emit: (event, payload) => events.push({ event, payload }) });
    const session = await service.connect({ profile: target('new-host'), secret: 'secret' });

    expect(client.connectOptions?.hostVerifier?.('SHA256:first')).toBe(false);
    expect(events).toContainEqual({ event: 'session.host-key', payload: expect.objectContaining({ id: session.id, fingerprint: 'SHA256:first' }) });
  });

  it('auto-root 成功后才安装临时目录跟随且控制序列不进入输出快照', async () => {
    const client = new FakeClient();
    const markers = ['root-marker', 'cwd-marker'];
    const events: Array<{ event: string; payload: unknown }> = [];
    const service = new SessionService({
      createClient: () => client,
      createMarker: () => markers.shift()!,
      emit: (event, payload) => events.push({ event, payload })
    });
    const session = await service.connect({
      profile: { ...target('root-host'), autoRoot: true, shellIntegration: true },
      secret: 'login-password'
    });
    client.emit('ready');

    expect(client.stream.writes[0]).toContain('WB_SUDO:root-marker');
    client.stream.emit('data', '\u001b]9;WB_SUDO:root-marker\u0007');
    expect(client.stream.writes[1]).toBe('login-password\n');
    client.stream.emit('data', '\u001b]9;WB_ROOT_READY:root-marker:bash\u0007');
    expect(client.stream.writes[2]).toContain('PROMPT_COMMAND');
    client.stream.emit('data', 'ready\r\n\u001b]7;file://cwd-marker/root\u0007');

    expect(service.snapshot(session.id)).toBe('ready\r\n');
    expect(service.list()).toMatchObject([{ id: session.id, state: 'connected', integration: 'following', cwd: '/root' }]);
    expect(events).toContainEqual({ event: 'session.cwd', payload: { id: session.id, cwd: '/root' } });
  });

  it('按 sessionId 从对应 SSH Client 懒加载 SFTP 通道', async () => {
    const firstClient = new FakeClient();
    const secondClient = new FakeClient();
    const clients = [firstClient, secondClient];
    const service = new SessionService({ createClient: () => clients.shift()!, emit: () => undefined });
    const first = await service.connect({ profile: target('sftp-a') });
    const second = await service.connect({ profile: target('sftp-b') });
    firstClient.emit('ready');
    secondClient.emit('ready');

    await expect(service.openSftp(first.id)).resolves.toBe(firstClient.sftpChannel);
    await expect(service.openSftp(second.id)).resolves.toBe(secondClient.sftpChannel);
  });

  it('重连保留原 sessionId 与输出快照并替换底层 SSH Client', async () => {
    const firstClient = new FakeClient();
    const secondClient = new FakeClient();
    const clients = [firstClient, secondClient];
    const service = new SessionService({ createClient: () => clients.shift()!, emit: () => undefined });
    const session = await service.connect({ profile: target('reconnect'), secret: 'secret' });
    firstClient.emit('ready');
    firstClient.stream.emit('data', 'before-reconnect\r\n');

    await expect(service.reconnect(session.id)).resolves.toEqual({ id: session.id });
    secondClient.emit('ready');

    expect(firstClient.ended).toBe(true);
    expect(service.snapshot(session.id)).toBe('before-reconnect\r\n');
    expect(service.list()).toMatchObject([{ id: session.id, state: 'connected' }]);
  });

  it('关闭目录跟随时恢复内存钩子，重新开启时再次探测当前 shell', async () => {
    const client = new FakeClient();
    const markers = ['detect-one', 'detect-two'];
    const service = new SessionService({ createClient: () => client, createMarker: () => markers.shift()!, emit: () => undefined });
    const session = await service.connect({ profile: { ...target('toggle'), shellIntegration: true } });
    client.emit('ready');
    client.stream.emit('data', '\u001b]9;WB_SHELL:detect-one:bash\u0007');
    client.stream.emit('data', '\u001b]7;file://detect-one/home/ops\u0007');

    service.setIntegration(session.id, false);
    expect(client.stream.writes.at(-1)).toContain('unset -f __WB_OSC7');
    expect(service.list()).toMatchObject([{ id: session.id, integration: 'independent' }]);

    service.setIntegration(session.id, true);
    expect(client.stream.writes.at(-1)).toContain('WB_SHELL:detect-two');
  });

  it('用户主动关闭标签时移除 Session，自然断线则保留用于重连', async () => {
    const firstClient = new FakeClient();
    const secondClient = new FakeClient();
    const clients = [firstClient, secondClient];
    const service = new SessionService({ createClient: () => clients.shift()!, emit: () => undefined });
    const closed = await service.connect({ profile: target('close-tab') });
    const reconnectable = await service.connect({ profile: target('network-close') });
    firstClient.emit('ready');
    secondClient.emit('ready');

    service.disconnect(closed.id);
    secondClient.stream.emit('close');

    expect(service.list()).toEqual([expect.objectContaining({ id: reconnectable.id, state: 'disconnected' })]);
  });
});
