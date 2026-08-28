/** dmidecode 中一条已安装的物理内存，缺失字段保留空字符串供报告降级展示。 */
export interface MemoryModule {
  size: string;
  manufacturer: string;
  model: string;
}

/**
 * 解析 dmidecode 的 DMI type 17 段。
 *
 * 相同容量、品牌和型号可能对应不同插槽，因此这里按 Memory Device 段逐条保留，不能按
 * 字段值去重。解析器只读取报告需要的字段，不根据厂商文本推断额外硬件信息。
 */
export function parseDmidecodeMemory(content: string): MemoryModule[] {
  const modules: MemoryModule[] = [];
  let current: MemoryModule | undefined;
  const flush = () => {
    if (current?.size && !/^no module installed$/i.test(current.size)) modules.push(current);
    current = undefined;
  };

  for (const line of content.split(/\r?\n/)) {
    if (/^\s*Memory Device\s*$/i.test(line)) {
      flush();
      current = { size: '', manufacturer: '', model: '' };
      continue;
    }
    if (!current) continue;
    const match = line.match(/^\s*(Size|Manufacturer|Part Number|Model):\s*(.*?)\s*$/i);
    if (!match) continue;
    const field = match[1].toLowerCase();
    if (field === 'size') current.size = match[2];
    else if (field === 'manufacturer') current.manufacturer = match[2];
    else current.model = match[2];
  }
  flush();
  return modules;
}
