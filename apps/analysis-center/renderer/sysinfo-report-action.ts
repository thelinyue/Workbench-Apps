export interface SysinfoReportHost {
  invoke<T = unknown>(method: string, payload?: unknown): Promise<T>;
}

/** Renderer 不接触 sysinfo 源路径，只串联应用 backend 的受信任路径与宿主打开能力。 */
export async function openSysinfoReport(host: SysinfoReportHost, packageId: string): Promise<void> {
  const reportPath = await host.invoke<string>('results.sysinfo-report-path', { packageId });
  if (!reportPath) throw new Error('完整 sysinfo 报告路径无效。');
  await host.invoke('host.openPath', { path: reportPath });
}
