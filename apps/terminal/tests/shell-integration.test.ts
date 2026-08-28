import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShellIntegrationService, buildShellDetectionCommand, buildShellIntegrationCommand, buildShellIntegrationRestoreCommand, parseOsc7Cwd } from '../backend/shell-integration-service';

describe('纯会话级 Shell Integration', () => {
  afterEach(() => vi.useRealTimers());
  it('Bash 和 Zsh 注入命令只修改当前 shell 内存且不触碰远端文件', () => {
    for (const shell of ['bash', 'zsh'] as const) {
      const command = buildShellIntegrationCommand(shell, 'nonce-123');
      expect(command).toContain('OSC7');
      expect(command).toContain('__WB_OSC7_nonce_123');
      expect(buildShellIntegrationRestoreCommand(shell, 'nonce-123')).toContain('__WB_OSC7_nonce_123');
      expect(command).not.toMatch(/(?:\.bashrc|\.zshrc|\.profile|sshd?_config|sudoers)/i);
      expect(command).not.toMatch(/(?:^|[;&|\s])(?:touch|tee|install|scp|sftp|sed\s+-i)(?:\s|$)/i);
      expect(command).not.toMatch(/(?:^|\s)(?:>>?|\d>>?)\s*[^&]/);
    }
  });

  it('仅接受带匹配随机标记和绝对路径的 OSC 7 cwd', () => {
    expect(parseOsc7Cwd('\u001b]7;file://server/var/log\u0007', 'server')).toBe('/var/log');
    expect(parseOsc7Cwd('\u001b]7;file://other/etc\u0007', 'server')).toBeUndefined();
    expect(parseOsc7Cwd('\u001b]7;file://server/../etc\u0007', 'server')).toBeUndefined();
    expect(parseOsc7Cwd('\u001b]7;file://server/tmp/%E6%97%A5%E5%BF%97\u0007', 'server')).toBe('/tmp/日志');
  });

  it('确认 OSC 7 后上报 cwd，关闭时只恢复当前 shell 内存钩子', () => {
    const writes: string[] = [];
    const events: Array<{ event: string; payload: unknown }> = [];
    const service = new ShellIntegrationService({
      createMarker: () => 'session-marker',
      emit: (event, payload) => events.push({ event, payload })
    });
    service.install('session-1', 'bash', { write: (data) => writes.push(data) });

    expect(writes[0]).toContain('PROMPT_COMMAND');
    expect(service.consume('session-1', 'before\u001b]7;file://session-marker/var/log\u0007after')).toBe('beforeafter');
    expect(events).toContainEqual({ event: 'session.cwd', payload: { id: 'session-1', cwd: '/var/log' } });
    expect(events).toContainEqual({ event: 'session.integration', payload: { id: 'session-1', status: 'following' } });

    service.disable('session-1');
    expect(writes.at(-1)).toContain('unset -f __WB_OSC7');
    expect(writes.join('\n')).not.toMatch(/(?:\.bashrc|\.zshrc|\.profile|touch|tee|sed\s+-i)/i);
  });

  it('不支持的 shell 不执行注入并立即降级为独立 SFTP 导航', () => {
    const writes: string[] = [];
    const events: Array<{ event: string; payload: unknown }> = [];
    const service = new ShellIntegrationService({ emit: (event, payload) => events.push({ event, payload }) });

    service.install('session-2', 'fish', { write: (data) => writes.push(data) });

    expect(writes).toEqual([]);
    expect(events).toContainEqual({
      event: 'session.integration',
      payload: { id: 'session-2', status: 'independent', reason: '远端 shell fish 不支持安全的目录跟随，已切换为独立导航。' }
    });
  });

  it('通过当前 PTY 控制序列探测 shell，确认支持后才安装临时钩子', () => {
    const writes: string[] = [];
    const events: Array<{ event: string; payload: unknown }> = [];
    const service = new ShellIntegrationService({
      createMarker: () => 'detect-marker',
      emit: (event, payload) => events.push({ event, payload })
    });

    service.detect('session-3', { write: (data) => writes.push(data) });

    expect(writes).toEqual([`${buildShellDetectionCommand('detect-marker')}\n`]);
    expect(writes[0]).not.toMatch(/(?:\.bashrc|\.zshrc|\.profile|touch|tee|sed\s+-i)/i);
    expect(service.consume('session-3', 'a\u001b]9;WB_SHELL:detect-marker:zsh\u0007b')).toBe('ab');
    expect(writes[1]).toContain('precmd_functions');
    expect(events).toEqual([]);
  });

  it('注入后未收到可靠 OSC 7 时恢复内存钩子并降级', () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const events: Array<{ event: string; payload: unknown }> = [];
    const service = new ShellIntegrationService({ createMarker: () => 'timeout-marker', emit: (event, payload) => events.push({ event, payload }) });
    service.install('session-timeout', 'bash', { write: (data) => writes.push(data) });

    vi.advanceTimersByTime(3_000);

    expect(writes.at(-1)).toContain('unset -f __WB_OSC7');
    expect(events).toContainEqual({
      event: 'session.integration',
      payload: { id: 'session-timeout', status: 'independent', reason: '未收到可靠的目录上报，已切换为独立导航。' }
    });
  });

  it('Bash 钩子无法安全组合时在修改前上报并降级', () => {
    const writes: string[] = [];
    const events: Array<{ event: string; payload: unknown }> = [];
    const service = new ShellIntegrationService({ createMarker: () => 'array-marker', emit: (event, payload) => events.push({ event, payload }) });
    service.install('session-array', 'bash', { write: (data) => writes.push(data) });

    expect(writes[0]).toContain('WB_INTEGRATION_UNSUPPORTED:array-marker');
    const output = service.consume('session-array', '\u001b]9;WB_INTEGRATION_UNSUPPORTED:array-marker:prompt-command-array\u0007');

    expect(output).toBe('');
    expect(writes).toHaveLength(1);
    expect(events).toContainEqual({
      event: 'session.integration',
      payload: { id: 'session-array', status: 'independent', reason: '当前 shell 钩子无法安全组合，已切换为独立导航。' }
    });
  });

  it('OSC 7 跨 SSH 数据块时仍可靠上报 cwd 且不泄露控制序列', () => {
    const events: Array<{ event: string; payload: unknown }> = [];
    const service = new ShellIntegrationService({
      createMarker: () => 'fragmented-cwd',
      emit: (event, payload) => events.push({ event, payload })
    });
    service.install('session-fragmented', 'zsh', { write: () => undefined });

    expect(service.consume('session-fragmented', 'before\u001b]7;file://fragment')).toBe('before');
    expect(service.consume('session-fragmented', 'ed-cwd/var/log\u0007after')).toBe('after');
    expect(events).toContainEqual({
      event: 'session.cwd',
      payload: { id: 'session-fragmented', cwd: '/var/log' }
    });
  });
});
