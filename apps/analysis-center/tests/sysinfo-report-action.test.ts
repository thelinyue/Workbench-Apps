import { describe, expect, it } from 'vitest';
import { openSysinfoReport, type SysinfoReportHost } from '../renderer/sysinfo-report-action';

describe('结果页完整 sysinfo 操作', () => {
  it('先按 packageId 请求报告路径，再交给宿主使用系统默认应用打开', async () => {
    const calls: Array<{ method: string; payload: unknown }> = [];
    const host: SysinfoReportHost = {
      async invoke<T>(method: string, payload?: unknown): Promise<T> {
        calls.push({ method, payload });
        return (method === 'results.sysinfo-report-path' ? 'D:\\extract\\sysinfo-report.html' : undefined) as T;
      }
    };

    await openSysinfoReport(host, 'package-1');

    expect(calls).toEqual([
      { method: 'results.sysinfo-report-path', payload: { packageId: 'package-1' } },
      { method: 'host.openPath', payload: { path: 'D:\\extract\\sysinfo-report.html' } }
    ]);
  });

  it('backend 未返回路径时不调用宿主打开空路径', async () => {
    const calls: Array<{ method: string; payload: unknown }> = [];
    const host: SysinfoReportHost = {
      async invoke<T>(method: string, payload?: unknown): Promise<T> {
        calls.push({ method, payload });
        return '' as T;
      }
    };

    await expect(openSysinfoReport(host, 'package-1')).rejects.toThrow('完整 sysinfo 报告路径无效');
    expect(calls).toEqual([{ method: 'results.sysinfo-report-path', payload: { packageId: 'package-1' } }]);
  });
});
