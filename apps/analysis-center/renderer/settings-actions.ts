export interface MonitorSettings {
  directory?: string;
  enabled: boolean;
  scanIntervalMinutes: number;
}

interface SettingsHost {
  invoke<T = unknown>(method: string, payload?: unknown): Promise<T>;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : `设置操作失败：${String(error)}`;
}

/** 设置弹窗的目录选择与保存动作统一在这里处理，使任一入口都能在 Dialog 内呈现错误。 */
export function createSettingsActions({
  host,
  getDraft,
  changeDraft,
  reportError,
  refresh,
  close
}: {
  host: SettingsHost;
  getDraft: () => MonitorSettings;
  changeDraft: (draft: MonitorSettings) => void;
  reportError: (message: string) => void;
  refresh: () => Promise<void>;
  close: () => void;
}) {
  return {
    async chooseDirectory() {
      reportError('');
      try {
        const [directory] = await host.invoke<string[]>('host.chooseDirectory');
        if (directory) changeDraft({ ...getDraft(), directory });
      } catch (error) {
        reportError(getErrorMessage(error));
      }
    },
    async save() {
      reportError('');
      const draft = getDraft();
      if (draft.enabled && !draft.directory) {
        reportError('启用监控前请选择目录。');
        return;
      }
      if (!Number.isInteger(draft.scanIntervalMinutes) || draft.scanIntervalMinutes < 1) {
        reportError('自动扫描间隔至少为 1 分钟。');
        return;
      }
      try {
        await host.invoke('settings.save', draft);
        await refresh();
        close();
      } catch (error) {
        reportError(getErrorMessage(error));
      }
    }
  };
}
