import { posix } from 'node:path';
import { randomUUID } from 'node:crypto';
import { OscStreamBuffer } from './osc-stream-buffer';

export type SupportedShell = 'bash' | 'zsh';

interface IntegrationStream {
  write(data: string): unknown;
}

interface IntegrationRecord {
  marker: string;
  shell?: SupportedShell;
  stream: IntegrationStream;
  following: boolean;
  outputBuffer: OscStreamBuffer;
  confirmationTimer?: ReturnType<typeof setTimeout>;
}

export interface ShellIntegrationServiceOptions {
  emit(event: string, payload: unknown): void;
  createMarker?: () => string;
}

/**
 * 生成仅作用于当前 shell 进程内存的 cwd 上报命令。
 *
 * 命令只能修改函数和钩子变量，不能读取、写入或创建任何远端文件。SSH 会话结束后 shell
 * 进程销毁，所有状态随之消失；不支持的 shell 必须由调用方降级为独立 SFTP 导航。
 */
export function buildShellIntegrationCommand(shell: SupportedShell, marker: string): string {
  const safeMarker = marker.replace(/[^A-Za-z0-9._-]/g, '');
  if (!safeMarker) throw new Error('Shell Integration 标记无效。');
  const names = integrationNames(safeMarker);
  const report = `${names.report}(){ printf '\\033]7;file://${safeMarker}%s\\007' \"$PWD\"; }`;
  if (shell === 'bash') {
    const unsupported = `printf '\\033]9;WB_INTEGRATION_UNSUPPORTED:${safeMarker}:prompt-command-array\\007'`;
    return `${names.declaration}=; if [[ -v PROMPT_COMMAND ]]; then ${names.declaration}=$(declare -p PROMPT_COMMAND); fi; case \"$${names.declaration}\" in \"declare -a\"*|\"declare -A\"*) ${unsupported};; *) ${names.previous}=$PROMPT_COMMAND; ${report}; PROMPT_COMMAND=\"${names.report}\${PROMPT_COMMAND:+;$PROMPT_COMMAND}\"; ${names.report};; esac; unset ${names.declaration}`;
  }
  return `typeset -ga ${names.previous}; ${names.previous}=(\${precmd_functions[@]}); ${report}; precmd_functions=(${names.report} \${precmd_functions:#${names.report}}); ${names.report}`;
}

/** 恢复本会话注入前的内存钩子，不访问任何持久配置。 */
export function buildShellIntegrationRestoreCommand(shell: SupportedShell, marker: string): string {
  const names = integrationNames(normalizeMarker(marker));
  if (shell === 'bash') return `PROMPT_COMMAND=$${names.previous}; unset ${names.previous}; unset -f ${names.report}`;
  return `precmd_functions=(\${${names.previous}[@]}); unset ${names.previous}; unfunction ${names.report} 2>/dev/null`;
}

/** 使用当前交互式 shell 的内存变量上报 shell 名称，不读取任何配置文件。 */
export function buildShellDetectionCommand(marker: string): string {
  const safeMarker = normalizeMarker(marker);
  return `__WB_SHELL_NAME=\${0#-}; __WB_SHELL_NAME=\${__WB_SHELL_NAME##*/}; printf '\\033]9;WB_SHELL:${safeMarker}:%s\\007' "$__WB_SHELL_NAME"; unset __WB_SHELL_NAME`;
}

/** 从输出中提取属于当前会话标记的 OSC 7 绝对路径。 */
export function parseOsc7Cwd(data: string, marker: string): string | undefined {
  const pattern = /\u001b\]7;file:\/\/([^/\u0007]+)(\/[^\u0007]*)\u0007/g;
  let cwd: string | undefined;
  for (const match of data.matchAll(pattern)) {
    if (match[1] !== marker) continue;
    try {
      const decoded = decodeURIComponent(match[2]);
      if (!posix.isAbsolute(decoded) || decoded.includes('\u0000') || posix.normalize(decoded) !== decoded) continue;
      cwd = decoded;
    } catch { /* 非法转义序列直接忽略，不能影响终端数据主链路。 */ }
  }
  return cwd;
}

/**
 * 维护各 SSH Session 的临时 shell 钩子状态。
 *
 * 本服务只向已存在的交互式 PTY 写入内存命令，不打开 SFTP、不执行 cd，也不承担 SSH
 * 连接职责。无法安全组合的 shell 会直接报告独立导航，终端主链路继续透传。
 */
export class ShellIntegrationService {
  private readonly records = new Map<string, IntegrationRecord>();
  private readonly createMarker: () => string;

  public constructor(private readonly options: ShellIntegrationServiceOptions) {
    this.createMarker = options.createMarker ?? randomUUID;
  }

  public detect(sessionId: string, stream: IntegrationStream): void {
    const record: IntegrationRecord = { marker: this.createMarker(), stream, following: false, outputBuffer: new OscStreamBuffer() };
    this.records.set(sessionId, record);
    stream.write(`${buildShellDetectionCommand(record.marker)}\n`);
  }

  public install(sessionId: string, shellName: string, stream: IntegrationStream): void {
    this.installWithRecord(sessionId, shellName, {
      marker: this.records.get(sessionId)?.marker ?? this.createMarker(),
      stream,
      following: false,
      outputBuffer: new OscStreamBuffer()
    });
  }

  private installWithRecord(sessionId: string, shellName: string, record: IntegrationRecord): void {
    const shell = normalizeShell(shellName);
    if (!shell) {
      this.records.delete(sessionId);
      this.options.emit('session.integration', {
        id: sessionId,
        status: 'independent',
        reason: `远端 shell ${shellName || '未知'} 不支持安全的目录跟随，已切换为独立导航。`
      });
      return;
    }
    record.shell = shell;
    this.records.set(sessionId, record);
    record.stream.write(`${buildShellIntegrationCommand(shell, record.marker)}\n`);
    record.confirmationTimer = setTimeout(() => {
      if (this.records.get(sessionId) !== record || record.following) return;
      this.degrade(sessionId, record, '未收到可靠的目录上报，已切换为独立导航。');
    }, 3_000);
    if (typeof record.confirmationTimer === 'object') record.confirmationTimer.unref?.();
  }

  public consume(sessionId: string, data: string): string {
    const record = this.records.get(sessionId);
    if (!record) return data;
    return record.outputBuffer.consume(data, (completeData) => this.consumeComplete(sessionId, completeData, record));
  }

  private consumeComplete(sessionId: string, data: string, record: IntegrationRecord): string {
    let unsupported = false;
    const unsupportedPattern = new RegExp(`\\u001b\\]9;WB_INTEGRATION_UNSUPPORTED:${escapeRegExp(record.marker)}:[^\\u0007]+\\u0007`, 'g');
    const withoutUnsupported = data.replace(unsupportedPattern, () => { unsupported = true; return ''; });
    if (unsupported) {
      if (record.confirmationTimer) clearTimeout(record.confirmationTimer);
      this.records.delete(sessionId);
      this.options.emit('session.integration', { id: sessionId, status: 'independent', reason: '当前 shell 钩子无法安全组合，已切换为独立导航。' });
      return withoutUnsupported;
    }
    const shellPattern = new RegExp(`\\u001b\\]9;WB_SHELL:${escapeRegExp(record.marker)}:([^\\u0007]+)\\u0007`, 'g');
    const withoutShellControl = withoutUnsupported.replace(shellPattern, (_sequence, shell: string) => {
      this.installWithRecord(sessionId, shell, record);
      return '';
    });
    if (!record.shell) return withoutShellControl;
    const pattern = /\u001b\]7;file:\/\/([^/\u0007]+)(\/[^\u0007]*)\u0007/g;
    return withoutShellControl.replace(pattern, (sequence, host: string) => {
      if (host !== record.marker) return sequence;
      const cwd = parseOsc7Cwd(sequence, record.marker);
      if (!cwd) return '';
      this.options.emit('session.cwd', { id: sessionId, cwd });
      if (!record.following) {
        record.following = true;
        if (record.confirmationTimer) clearTimeout(record.confirmationTimer);
        record.confirmationTimer = undefined;
        this.options.emit('session.integration', { id: sessionId, status: 'following' });
      }
      return '';
    });
  }

  public disable(sessionId: string): void {
    const record = this.records.get(sessionId);
    if (!record) return;
    this.degrade(sessionId, record, '已关闭跟随终端目录，文件面板使用独立导航。');
  }

  public close(sessionId?: string): void {
    if (sessionId) {
      const record = this.records.get(sessionId);
      if (record?.confirmationTimer) clearTimeout(record.confirmationTimer);
      this.records.delete(sessionId);
      return;
    }
    for (const record of this.records.values()) if (record.confirmationTimer) clearTimeout(record.confirmationTimer);
    this.records.clear();
  }

  private degrade(sessionId: string, record: IntegrationRecord, reason: string): void {
    if (record.confirmationTimer) clearTimeout(record.confirmationTimer);
    if (record.shell) record.stream.write(`${buildShellIntegrationRestoreCommand(record.shell, record.marker)}\n`);
    this.records.delete(sessionId);
    this.options.emit('session.integration', { id: sessionId, status: 'independent', reason });
  }
}

function normalizeShell(shell: string): SupportedShell | undefined {
  const name = shell.replace(/^-/, '').split('/').pop()?.toLowerCase();
  return name === 'bash' || name === 'zsh' ? name : undefined;
}

function integrationNames(marker: string): { report: string; previous: string; declaration: string } {
  const suffix = marker.replace(/[^A-Za-z0-9_]/g, '_');
  return {
    report: `__WB_OSC7_${suffix}`,
    previous: `__WB_PREVIOUS_HOOK_${suffix}`,
    declaration: `__WB_PROMPT_DECL_${suffix}`
  };
}

function normalizeMarker(marker: string): string {
  const safeMarker = marker.replace(/[^A-Za-z0-9._-]/g, '');
  if (!safeMarker) throw new Error('Shell Integration 控制标记无效。');
  return safeMarker;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
