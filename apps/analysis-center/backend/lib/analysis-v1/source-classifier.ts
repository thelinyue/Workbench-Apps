export type V1SourceType = 'kernel' | 'sysinfo' | 'mdstat' | 'ugvolume';

/**
 * 将诊断包内的已知文件名归一化为稳定来源类型。
 *
 * 这里只接受具备明确语义的文件名，以及真实 ZIP 使用的“设备标识_日志名”形式；未知日志
 * 保持未分类，防止结构化文件或应用日志退化为通用文本扫描而放大耗时和误报范围。
 */
export function classifyV1Source(file: string): V1SourceType | undefined {
  const name = file.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() ?? '';
  if (name === 'sysinfo.json') return 'sysinfo';
  if (name === 'mdstat.log') return 'mdstat';
  if (name === 'ugvolume.log') return 'ugvolume';
  if (/^(?:kern(?:\.log(?:\.\d+)?)?(?:\.gz)?|syslog(?:\.\d+)?(?:\.gz)?|journal[^/]*|dmesg[^/]*)$/.test(name)) return 'kernel';
  if (/^[^/]+_(?:syslog(?:\.\d+)?(?:\.gz)?|dmsg\.log\.gz)$/.test(name)) return 'kernel';
  return undefined;
}
