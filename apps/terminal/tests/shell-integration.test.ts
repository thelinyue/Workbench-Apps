import { describe, expect, it } from 'vitest';
import { ShellIntegrationService, parseOsc7Cwd } from '../backend/shell-integration-service';

describe('零注入目录跟随', () => {
  it('只接受远端主动上报的规范绝对路径', () => {
    expect(parseOsc7Cwd('\u001b]7;file://server/var/log\u0007')).toBe('/var/log');
    expect(parseOsc7Cwd('\u001b]7;file://server/opt/app\u001b\\')).toBe('/opt/app');
    expect(parseOsc7Cwd('\u001b]7;file:///root\u0007')).toBe('/root');
    expect(parseOsc7Cwd('\u001b]7;file://server/../etc\u0007')).toBeUndefined();
    expect(parseOsc7Cwd('\u001b]7;file://server/tmp/%E6%97%A5%E5%BF%97\u0007')).toBe('/tmp/日志');
  });

  it('开启监听时不向远端 PTY 写入 shell 探测或钩子命令', () => {
    const writes: string[] = [];
    const events: Array<{ event: string; payload: unknown }> = [];
    const service = new ShellIntegrationService({ emit: (event, payload) => events.push({ event, payload }) });

    service.detect('session-passive', { write: (data) => writes.push(data) });

    expect(writes).toEqual([]);
    expect(events).toContainEqual({
      event: 'session.integration',
      payload: { id: 'session-passive', status: 'independent', reason: '远端尚未主动上报当前目录，文件面板使用独立导航。' }
    });
  });

  it('收到原生 OSC 7 后上报 cwd 并从终端输出中移除控制序列', () => {
    const events: Array<{ event: string; payload: unknown }> = [];
    const service = new ShellIntegrationService({ emit: (event, payload) => events.push({ event, payload }) });
    service.detect('session-following', { write: () => undefined });

    expect(service.consume('session-following', 'before\u001b]7;file://host/var/log\u0007after')).toBe('beforeafter');
    expect(events).toContainEqual({ event: 'session.cwd', payload: { id: 'session-following', cwd: '/var/log' } });
    expect(events).toContainEqual({ event: 'session.integration', payload: { id: 'session-following', status: 'following' } });
  });

  it('OSC 7 跨 SSH 数据块时仍可靠上报目录', () => {
    const events: Array<{ event: string; payload: unknown }> = [];
    const service = new ShellIntegrationService({ emit: (event, payload) => events.push({ event, payload }) });
    service.detect('session-fragmented', { write: () => undefined });

    expect(service.consume('session-fragmented', 'before\u001b]7;file://remote/var')).toBe('before');
    expect(service.consume('session-fragmented', '/log\u0007after')).toBe('after');
    expect(events).toContainEqual({ event: 'session.cwd', payload: { id: 'session-fragmented', cwd: '/var/log' } });
  });

  it('ST 结束符在 ESC 与反斜杠之间分块时仍不会泄露控制序列', () => {
    const events: Array<{ event: string; payload: unknown }> = [];
    const service = new ShellIntegrationService({ emit: (event, payload) => events.push({ event, payload }) });
    service.detect('session-st', { write: () => undefined });

    expect(service.consume('session-st', 'before\u001b]7;file://remote/opt/app\u001b')).toBe('before');
    expect(service.consume('session-st', '\\after')).toBe('after');
    expect(events).toContainEqual({ event: 'session.cwd', payload: { id: 'session-st', cwd: '/opt/app' } });
  });

  it('关闭监听只更新本地状态，不向远端 PTY 写入恢复命令', () => {
    const writes: string[] = [];
    const events: Array<{ event: string; payload: unknown }> = [];
    const service = new ShellIntegrationService({ emit: (event, payload) => events.push({ event, payload }) });
    service.detect('session-disabled', { write: (data) => writes.push(data) });

    service.disable('session-disabled');

    expect(writes).toEqual([]);
    expect(events.at(-1)).toEqual({
      event: 'session.integration',
      payload: { id: 'session-disabled', status: 'independent', reason: '已关闭跟随终端目录，文件面板使用独立导航。' }
    });
  });
});
