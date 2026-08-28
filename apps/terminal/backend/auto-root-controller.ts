import { OscStreamBuffer } from './osc-stream-buffer';

const AUTO_ROOT_FAILURE = '自动切换 root 失败，请检查 sudo 密码或权限。已保留普通用户会话。';

export interface AutoRootControllerOptions {
  marker: string;
  secret: string;
  write(data: string): void;
  onReady(shell: string): void;
  onFailure(message: string): void;
}

/**
 * 构造只作用于当前 PTY 的 sudo 登录命令。
 *
 * 随机标记通过 OSC 9 返回给本地状态机，sudo 密码不会拼入命令。root shell 启动后直接
 * exec 当前登录 shell，整个过程不创建脚本、不写入配置，也不在远端留下需要清理的文件。
 */
export function buildAutoRootCommand(marker: string): string {
  const safeMarker = normalizeMarker(marker);
  return `sudo -S -p "$(printf '\\033]9;WB_SUDO:${safeMarker}\\007')" -i sh -c 'printf "\\033]9;WB_ROOT_READY:${safeMarker}:%s\\007" "\${SHELL##*/}"; exec "\${SHELL:-/bin/sh}" -l'`;
}

/**
 * 解析 auto-root 私有控制序列并驱动密码状态机。
 *
 * 控制序列不会转发给 xterm，防止随机标记污染终端快照。第二次出现 sudo 提示意味着认证
 * 失败，此时只中止当前 sudo 命令，普通用户的交互式 shell 仍然保持可用。
 */
export class AutoRootController {
  private readonly controlPattern: RegExp;
  private readonly outputBuffer = new OscStreamBuffer();
  private promptCount = 0;
  private settled = false;

  public constructor(private readonly options: AutoRootControllerOptions) {
    const marker = normalizeMarker(options.marker);
    this.controlPattern = new RegExp(`\\u001b\\]9;WB_(SUDO|ROOT_READY):${escapeRegExp(marker)}(?::([^\\u0007]*))?\\u0007`, 'g');
  }

  public consume(data: string): string {
    return this.outputBuffer.consume(data, (completeData) => completeData.replace(this.controlPattern, (_sequence, type: string, shell?: string) => {
      if (type === 'SUDO') this.handlePrompt();
      else this.handleReady(shell || 'sh');
      return '';
    }));
  }

  private handlePrompt(): void {
    if (this.settled) return;
    this.promptCount += 1;
    if (this.promptCount === 1 && this.options.secret) {
      this.options.write(`${this.options.secret}\n`);
      return;
    }
    this.settled = true;
    this.options.write('\u0003');
    this.options.onFailure(AUTO_ROOT_FAILURE);
  }

  private handleReady(shell: string): void {
    if (this.settled) return;
    this.settled = true;
    this.options.onReady(shell);
  }
}

function normalizeMarker(marker: string): string {
  const safeMarker = marker.replace(/[^A-Za-z0-9._-]/g, '');
  if (!safeMarker) throw new Error('自动切换 root 控制标记无效。');
  return safeMarker;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
