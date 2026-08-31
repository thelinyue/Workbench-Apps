import { describe, expect, it, vi } from 'vitest';
import { createSettingsActions, type MonitorSettings } from '../renderer/settings-actions';

describe('分析中心设置操作', () => {
  it.each([
    ['chooseDirectory', '选择监控目录失败。'],
    ['save', '保存监控设置失败。']
  ] as const)('%s 的后端错误进入设置弹窗且不关闭弹窗', async (action, errorMessage) => {
    const draft: MonitorSettings = { enabled: false, autoAnalyzeEnabled: true, scanIntervalSeconds: 10 };
    const reportError = vi.fn();
    const close = vi.fn();
    const refresh = vi.fn(async () => undefined);
    const actions = createSettingsActions({
      host: { invoke: vi.fn(async () => { throw new Error(errorMessage); }) },
      getDraft: () => draft,
      changeDraft: vi.fn(),
      reportError,
      refresh,
      close
    });

    await actions[action]();

    expect(reportError).toHaveBeenLastCalledWith(errorMessage);
    expect(close).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('重新执行成功设置操作前清除旧错误，保存成功后刷新并关闭', async () => {
    const draft: MonitorSettings = { directory: 'D:/inbox', enabled: true, autoAnalyzeEnabled: false, scanIntervalSeconds: 60 };
    const reportError = vi.fn();
    const refresh = vi.fn(async () => undefined);
    const close = vi.fn();
    const host = { invoke: vi.fn(async () => undefined) };
    const actions = createSettingsActions({ host, getDraft: () => draft, changeDraft: vi.fn(), reportError, refresh, close });

    await actions.save();

    expect(reportError).toHaveBeenCalledWith('');
    expect(host.invoke).toHaveBeenCalledWith('settings.save', draft);
    expect(refresh).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('扫描间隔超过60秒时在弹窗内阻止保存', async () => {
    const draft: MonitorSettings = { directory: 'D:/inbox', enabled: true, autoAnalyzeEnabled: true, scanIntervalSeconds: 70 };
    const reportError = vi.fn();
    const host = { invoke: vi.fn(async () => undefined) };
    const actions = createSettingsActions({ host, getDraft: () => draft, changeDraft: vi.fn(), reportError, refresh: vi.fn(async () => undefined), close: vi.fn() });

    await actions.save();

    expect(reportError).toHaveBeenLastCalledWith('自动扫描间隔最多为 60 秒。');
    expect(host.invoke).not.toHaveBeenCalled();
  });

  it('非10秒步进的扫描间隔在弹窗内阻止保存', async () => {
    const draft: MonitorSettings = { directory: 'D:/inbox', enabled: true, autoAnalyzeEnabled: true, scanIntervalSeconds: 15 };
    const reportError = vi.fn();
    const host = { invoke: vi.fn(async () => undefined) };
    const actions = createSettingsActions({ host, getDraft: () => draft, changeDraft: vi.fn(), reportError, refresh: vi.fn(async () => undefined), close: vi.fn() });

    await actions.save();

    expect(reportError).toHaveBeenLastCalledWith('自动扫描间隔必须为 10 秒的整数倍。');
    expect(host.invoke).not.toHaveBeenCalled();
  });
});
