export interface RuleUpdateState { currentVersion: string; source: 'bundled' | 'downloaded'; }
export interface RuleUpdateResult { status: 'updated' | 'up-to-date'; previousVersion: string; currentVersion: string; }

export function getRuleUpdatePresentation(state: RuleUpdateState): string {
  return `规则 ${state.currentVersion} · ${state.source === 'downloaded' ? '已更新' : '内置'}`;
}

export function getRuleUpdateMessage(result: RuleUpdateResult): string {
  return result.status === 'updated'
    ? `分析规则已更新至 ${result.currentVersion}，将在下一次分析时生效。`
    : '当前已是最新分析规则。';
}
