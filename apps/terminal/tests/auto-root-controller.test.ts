import { describe, expect, it } from 'vitest';
import { AutoRootController, buildAutoRootCommand } from '../backend/auto-root-controller';

describe('自动切换 root 状态机', () => {
  it('sudo 命令只包含随机控制标记而不包含密码或持久化操作', () => {
    const command = buildAutoRootCommand('nonce-1');
    expect(command).toContain('sudo -S');
    expect(command).toContain('WB_SUDO:nonce-1');
    expect(command).toContain('WB_ROOT_READY:nonce-1');
    expect(command).not.toContain('very-secret');
    expect(command).not.toMatch(/(?:\.bashrc|\.zshrc|\.profile|touch|tee|sed\s+-i)/i);
  });

  it('root 登录 shell 二次解析命令时不依赖尚未生效的临时变量', () => {
    const command = buildAutoRootCommand('nonce-shell');

    expect(command).not.toContain('WB_ROOT_SHELL');
    expect(command).not.toContain('WB_ROOT_NAME');
    expect(command).toContain('"${SHELL##*/}"');
    expect(command).toContain('exec "${SHELL:-/bin/sh}" -l');
  });

  it('只在 sudo 控制提示出现后发送密码并从终端输出中移除控制序列', () => {
    const writes: string[] = [];
    const events: string[] = [];
    const controller = new AutoRootController({
      marker: 'nonce-2',
      secret: 'very-secret',
      write: (data) => writes.push(data),
      onReady: (shell) => events.push(`ready:${shell}`),
      onFailure: (message) => events.push(`failure:${message}`)
    });
    expect(controller.consume(`before\u001b]9;WB_SUDO:nonce-2\u0007after`)).toBe('beforeafter');
    expect(writes[0]).toBe('very-secret\n');
    expect(controller.consume(`\u001b]9;WB_ROOT_READY:nonce-2:bash\u0007`)).toBe('');
    expect(events).toEqual(['ready:bash']);
  });

  it('密码再次被请求时中止 sudo 并保留普通用户会话', () => {
    const writes: string[] = [];
    const failures: string[] = [];
    const controller = new AutoRootController({
      marker: 'nonce-3', secret: 'wrong', write: (data) => writes.push(data), onReady: () => undefined, onFailure: (message) => failures.push(message)
    });
    controller.consume('\u001b]9;WB_SUDO:nonce-3\u0007');
    controller.consume('Sorry, try again.\r\n\u001b]9;WB_SUDO:nonce-3\u0007');

    expect(writes.at(-1)).toBe('\u0003');
    expect(failures).toEqual(['自动切换 root 失败，请检查 sudo 密码或权限。已保留普通用户会话。']);
  });

  it('控制序列跨 SSH 数据块时仍只发送一次密码并隐藏控制标记', () => {
    const writes: string[] = [];
    const events: string[] = [];
    const controller = new AutoRootController({
      marker: 'fragmented',
      secret: 'secret',
      write: (data) => writes.push(data),
      onReady: (shell) => events.push(shell),
      onFailure: () => undefined
    });
    expect(controller.consume('prompt\u001b]9;WB_SU')).toBe('prompt');
    expect(controller.consume('DO:fragmented\u0007')).toBe('');
    expect(writes.at(-1)).toBe('secret\n');
    expect(controller.consume('\u001b]9;WB_ROOT_READY:frag')).toBe('');
    expect(controller.consume('mented:zsh\u0007ready')).toBe('ready');
    expect(events).toEqual(['zsh']);
  });
});
