import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { normalizeSysinfo, renderSysinfoReport } from '../backend/lib/reports/sysinfo-report';

const sampleSysinfo = {
  sn: 'EC752JJ042500D34',
  systemVersion: '1.8.0.0020',
  deviceName: 'UGREEN NASync DXP6800 Pro',
  platform: 'x86_64',
  client: 'web',
  memInfo: '',
  network: {
    interface: [
      {
        name: 'eth1',
        mac: '6C:1F:F7:40:2C:77',
        is_running: true,
        ipv4: '192.168.1.12',
        ipv6: ['fe80::1', '2409:8a30::59c'],
        NetInterface: { MTU: 1500 }
      },
      {
        name: 'eth2',
        mac: '6C:1F:F7:40:2C:78',
        is_running: false,
        ipv4: [],
        ipv6: [],
        NetInterface: { MTU: 1500 }
      }
    ]
  },
  disk: {
    devices: [
      {
        disk_info: {
          label: 'Hard Drive 1',
          name: 'sda',
          dev_name: '/dev/sda',
          used_for: 'Storage Pool 1',
          slot: 'ata1',
          model: 'ST4000"VN008<&',
          serial: "S0I7'PFCR",
          brand: 'Seagate',
          interface_type: 'sata',
          size: 4_000_787_030_016,
          temperature: 42,
          power_on_hours: 12_052,
          status: 1
        },
        smart_info: {
          report: [
            { id: 5, name: 'Reallocated_Sector_Ct', value: 100, worst: 100, thresh: 10, raw: 3, raw_string: '3', status: 1 },
            { id: 197, name: 'Current_Pending_Sector', value: 100, worst: 100, thresh: 0, raw: 0, raw_string: '0 (Min/Max 28/44)', status: 1 },
            { id: 198, name: 'Offline_Uncorrectable', value: 100, worst: 100, thresh: 0, raw: 0, raw_string: '不可解析', status: 1 },
            { id: 1, name: 'Raw_Read_Error_Rate', value: 74, worst: 58, thresh: 44, raw: 26_618_550, raw_string: '26618550', status: 1 }
          ]
        }
      },
      {
        disk_info: {
          label: 'M.2 Hard Drive 1',
          name: 'nvme0n1',
          dev_name: '/dev/nvme0n1',
          used_for: 'Storage Pool 2',
          slot: 'nvme1',
          model: 'WD Blue SN580',
          serial: 'S0I7PFCS',
          interface_type: 'nvme',
          size: 2_000_398_934_016,
          temperature: 40,
          power_on_hours: 11_000,
          status: 1
        },
        smart_info: { report: [] }
      }
    ]
  },
  unknownSection: { note: '<script>alert("xss")</script>' }
};

const sampleSmartTranslations: Record<string, string> = {
  Raw_Read_Error_Rate: '原始读取错误率',
  temperature: '温度',
  available_spare: '可用备用空间',
  available_spare_threshold: '可用备用空间阈值',
  Spin_Up_Time: '启动旋转时间',
  percentage_used: '已用寿命百分比',
  Start_Stop_Count: '启停次数',
  data_units_read: '已读取数据单元',
  Reallocated_Sector_Ct: '重映射扇区计数',
  data_units_written: '已写入数据单元',
  host_reads: '主机读取命令数',
  Seek_Error_Rate: '寻道错误率',
  host_writes: '主机写入命令数',
  controller_busy_time: '控制器忙碌时间',
  Power_On_Hours: '通电时长',
  power_cycles: '电源循环次数',
  Spin_Retry_Count: '旋转重试计数',
  Calibration_Retry_Count: '校准重试计数',
  power_on_hours: '通电时长',
  Power_Cycle_Count: '电源循环次数',
  unsafe_shutdowns: '非正常关机次数',
  warning_temp_time: '警告温度持续时间',
  temperature_sensors: '温度传感器',
  'End-to-End_Error': '端到端错误计数',
  Reported_Uncorrect: '报告的不可校正错误计数',
  Command_Timeout: '命令超时计数',
  High_Fly_Writes: '磁头高飞写入计数',
  Airflow_Temperature_Cel: '气流温度',
  'G-Sense_Error_Rate': '冲击感应错误率',
  'Power-Off_Retract_Count': '断电磁头回缩计数',
  Load_Cycle_Count: '磁头加载循环计数',
  Temperature_Celsius: '温度',
  Hardware_ECC_Recovered: '硬件 ECC 恢复计数',
  Reallocated_Event_Count: '扇区重映射事件计数',
  Current_Pending_Sector: '当前待处理扇区计数',
  Offline_Uncorrectable: '离线不可校正扇区计数',
  UDMA_CRC_Error_Count: 'UDMA CRC 错误计数',
  Multi_Zone_Error_Rate: '多区域错误率',
  Head_Flying_Hours: '磁头飞行时长',
  Total_LBAs_Written: '累计写入 LBA 数',
  Total_LBAs_Read: '累计读取 LBA 数'
};

describe('完整 sysinfo 可视化报告', () => {
  it('规范化设备、网络、存储池、硬盘和完整 SMART，同时保留原始数据', () => {
    const report = normalizeSysinfo(sampleSysinfo);

    expect(report.system).toEqual({
      deviceName: 'UGREEN NASync DXP6800 Pro',
      serialNumber: 'EC752JJ042500D34',
      systemVersion: '1.8.0.0020',
      platform: 'x86_64'
    });
    expect(report.memory).toEqual([]);
    expect(report.networks).toEqual([
      { name: 'eth1', running: true, mac: '6C:1F:F7:40:2C:77', ipv4: ['192.168.1.12'], ipv6: ['fe80::1', '2409:8a30::59c'], mtu: '1500' },
      { name: 'eth2', running: false, mac: '6C:1F:F7:40:2C:78', ipv4: [], ipv6: [], mtu: '1500' }
    ]);
    expect(report.storagePools).toHaveLength(2);
    expect(report.storagePools[0]).toMatchObject({ name: 'Storage Pool 1', diskCount: 1, totalSizeBytes: 4_000_787_030_016 });
    expect(report.storagePools[1]).toMatchObject({ name: 'Storage Pool 2', diskCount: 1, totalSizeBytes: 2_000_398_934_016 });
    expect(report.storagePools[0].disks[0]).toMatchObject({
      label: 'Hard Drive 1',
      device: '/dev/sda',
      sizeBytes: 4_000_787_030_016,
      temperature: '42',
      powerOnHours: '12052',
      sourceStatus: '1'
    });
    expect(report.storagePools[0].disks[0].smart).toHaveLength(4);
    expect(report.storagePools[0].disks[0].keySmart).toEqual([
      { id: 5, sourceId: '5', name: 'Reallocated_Sector_Ct', current: '100', worst: '100', threshold: '10', raw: '3', sourceStatus: '1' },
      { id: 197, sourceId: '197', name: 'Current_Pending_Sector', current: '100', worst: '100', threshold: '0', raw: '0 (Min/Max 28/44)', sourceStatus: '1' },
      { id: 198, sourceId: '198', name: 'Offline_Uncorrectable', current: '100', worst: '100', threshold: '0', raw: '不可解析', sourceStatus: '1' }
    ]);
    expect(report.raw).toBe(sampleSysinfo);
    expect(report.raw.client).toBe('web');
  });

  it('本地化存储标签并只在原始数据中保留客户端信息', () => {
    const html = renderSample();

    expect(html).toContain('<h3>存储池 1</h3>');
    expect(html).toContain('<h4>硬盘 1</h4>');
    expect(html).toContain('<h3>存储池 2</h3>');
    expect(html).toContain('<h4>M.2 硬盘 1</h4>');
    expect(html).not.toContain('<dt>客户端</dt>');
    expect(html).toContain('&quot;client&quot;: &quot;web&quot;');
    expect(html).toContain('&quot;used_for&quot;: &quot;Storage Pool 1&quot;');
    expect(html).toContain('&quot;label&quot;: &quot;Hard Drive 1&quot;');
  });

  it('为设备序列号、硬盘型号和硬盘序列号生成复制原始值的按钮', () => {
    const html = renderSample();

    expect(html).toContain('aria-label="复制设备序列号" data-copy-value="EC752JJ042500D34"');
    expect(html).toContain('aria-label="复制硬盘型号" data-copy-value="ST4000&quot;VN008&lt;&amp;"');
    expect(html).toContain('aria-label="复制硬盘序列号" data-copy-value="S0I7&#39;PFCR"');

    const withoutCopyValues = structuredClone(sampleSysinfo);
    withoutCopyValues.sn = '';
    withoutCopyValues.disk.devices[0].disk_info.model = '';
    withoutCopyValues.disk.devices[0].disk_info.serial = '';
    const missingHtml = renderSysinfoReport(normalizeSysinfo(withoutCopyValues), {
      packageName: '_2608281619.tgz',
      generatedAt: new Date('2026-08-28T10:00:00.000Z')
    });
    expect(missingHtml).not.toContain('aria-label="复制设备序列号"');
    expect(missingHtml).toContain('aria-label="复制硬盘型号" data-copy-value="WD Blue SN580"');
    expect(missingHtml).toContain('aria-label="复制硬盘序列号" data-copy-value="S0I7PFCS"');
  });

  it('重点 SMART 使用原始 ID、移除状态，并只强调首个非零 Raw 数值', () => {
    const html = renderSample();
    const keySmart = extractKeySmart(html);

    expect(keySmart).toContain('<span class="smart-id">5</span>');
    expect(keySmart).toContain('<span class="smart-id">197</span>');
    expect(keySmart).toContain('<span class="smart-id">198</span>');
    expect(keySmart).not.toContain('<span class="smart-id">05</span>');
    expect(keySmart).not.toContain('<span class="smart-id">C5</span>');
    expect(keySmart).not.toContain('<span class="smart-id">C6</span>');
    expect(keySmart).not.toContain('<dt>状态</dt>');
    expect(keySmart).toContain('<dd class="mono raw-attention">3</dd>');
    expect(keySmart).toContain('<dd class="mono">0 (Min/Max 28/44)</dd>');
    expect(keySmart).toContain('<dd class="mono">不可解析</dd>');

    expect(html).toContain('<th>源状态</th>');
    expect(html).toContain('未提供 5、197、198 或源数据标记异常的属性');
    expect(html).toContain('<td class="mono strong">5</td>');
    expect(html).toContain('<td class="mono strong">197</td>');
    expect(html).toContain('<td class="mono strong">198</td>');
    expect(html).toContain('<td class="mono">1</td>');
  });

  it('重点 SMART 正确识别十六进制 Raw 首值', () => {
    const input = structuredClone(sampleSysinfo);
    input.disk.devices[0].smart_info.report[0].raw_string = '0x10 (十六进制)';
    input.disk.devices[0].smart_info.report[1].raw_string = '0x0 (十六进制)';
    const html = renderSysinfoReport(normalizeSysinfo(input), {
      packageName: '_2608281619.tgz',
      generatedAt: new Date('2026-08-28T10:00:00.000Z')
    });
    const keySmart = extractKeySmart(html);

    expect(keySmart).toContain('<dd class="mono raw-attention">0x10 (十六进制)</dd>');
    expect(keySmart).toContain('<dd class="mono">0x0 (十六进制)</dd>');
  });

  it('将 dmidecode 内存记录按物理条目显示为高密度表格', () => {
    const memory = [
      { size: '8 GB', manufacturer: 'Samsung', model: 'M425R1GB4BB0-CQKOL' },
      { size: '16 GB', manufacturer: 'JUHOR', model: 'JHE4800S4016JG' }
    ];
    const report = normalizeSysinfo(sampleSysinfo, memory);
    const html = renderSysinfoReport(report, {
      packageName: '_2608281619.tgz',
      generatedAt: new Date('2026-08-28T10:00:00.000Z')
    });

    expect(report.memory).toEqual(memory);
    expect(html).toContain('<table class="memory-table"><thead><tr><th>内存</th><th>容量</th><th>品牌</th><th>型号</th></tr>');
    expect(html).toContain('<td class="strong">内存 1</td><td class="mono">8 GB</td><td>Samsung</td><td class="mono">M425R1GB4BB0-CQKOL</td>');
    expect(html).toContain('<td class="strong">内存 2</td><td class="mono">16 GB</td><td>JUHOR</td><td class="mono">JHE4800S4016JG</td>');
  });

  it('为真实样本中的 SMART 名称提供中文翻译，未知名称明确标注未收录', () => {
    const translatedInput = structuredClone(sampleSysinfo);
    translatedInput.disk.devices[0].smart_info.report = [
      ...Object.keys(sampleSmartTranslations).map((name, index) => ({ id: index + 1, name, value: 100, worst: 100, thresh: 0, raw_string: '0', status: 1 })),
      { id: 999, name: 'Vendor_Specific_Unknown', value: 100, worst: 100, thresh: 0, raw_string: '0', status: 1 }
    ];
    const html = renderSysinfoReport(normalizeSysinfo(translatedInput), {
      packageName: '_2608281619.tgz',
      generatedAt: new Date('2026-08-28T10:00:00.000Z')
    });

    for (const [name, translation] of Object.entries(sampleSmartTranslations)) {
      expect(html).toContain(`${name}<span class="smart-translation">（${translation}）</span>`);
    }
    expect(html).toContain('Vendor_Specific_Unknown<span class="smart-translation missing">（中文名未收录）</span>');
  });

  it('复制脚本优先使用 Clipboard API，并在本地文件受限时回退或显示失败', async () => {
    const script = extractInlineScript(renderSample());
    const clipboardWrite = vi.fn(async () => undefined);
    const clipboardRuntime = executeCopyScript(script, { clipboardWrite, execCommandResult: true });
    const clipboardButton = fakeCopyButton('EC752JJ042500D34');
    await clipboardRuntime.click(clipboardButton);
    expect(clipboardWrite).toHaveBeenCalledWith('EC752JJ042500D34');
    expect(clipboardRuntime.fallbackValue()).toBe('');
    expect(clipboardButton.textContent).toBe('已复制');
    clipboardRuntime.finishFeedback();
    expect(clipboardButton.textContent).toBe('复制');

    const fallbackRuntime = executeCopyScript(script, { execCommandResult: true });
    const fallbackButton = fakeCopyButton('ST4000"VN008<&');
    await fallbackRuntime.click(fallbackButton);
    expect(fallbackRuntime.fallbackValue()).toBe('ST4000"VN008<&');
    expect(fallbackButton.textContent).toBe('已复制');

    const failureRuntime = executeCopyScript(script, { execCommandResult: false });
    const failureButton = fakeCopyButton('S0I7PFCR');
    await failureRuntime.click(failureButton);
    expect(failureButton.textContent).toBe('复制失败');
  });

  it('生成自包含、可核对数值且安全转义的离线 HTML', () => {
    const html = renderSample();
    const script = extractInlineScript(html);
    const scriptHash = createHash('sha256').update(script).digest('base64');

    expect(html).toContain('完整 sysinfo 报告');
    expect(html).toContain('UGREEN NASync DXP6800 Pro');
    expect(html).toContain('仅按 sysinfo.json 的 used_for 分组，不代表 RAID 级别');
    expect(html).toContain('4,000,787,030,016 bytes');
    expect(html).toContain('Reallocated_Sector_Ct');
    expect(html).toContain('<td class="mono">3</td>');
    expect(html).not.toContain('raw-risk');
    expect(html).toContain('完整 SMART 属性');
    expect(html).toContain('未提供内存信息');
    expect(html).toContain('完整 sysinfo.json 原始数据');
    expect(html).toContain('&lt;script&gt;alert(\\&quot;xss\\&quot;)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert("xss")</script>');
    expect(html).toContain("default-src 'none'");
    expect(html).toContain(`script-src 'sha256-${scriptHash}'`);
    expect(html).not.toContain("script-src 'unsafe-inline'");
    expect(html).not.toMatch(/https?:\/\//i);
    expect(html).not.toMatch(/<(?:link|img)\b/i);
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html).toContain('@media (max-width:800px)');
    expect(html).not.toContain('@media (max-width:799px)');
  });
});

function renderSample(): string {
  return renderSysinfoReport(normalizeSysinfo(sampleSysinfo), {
    packageName: '_2608281619.tgz',
    generatedAt: new Date('2026-08-28T10:00:00.000Z')
  });
}

function extractKeySmart(html: string): string {
  const match = html.match(/<div class="smart-key-grid">([\s\S]*?)<\/div><\/div>\s*<\/div>\s*<details class="smart-details">/);
  expect(match).not.toBeNull();
  return match?.[1] ?? '';
}

function extractInlineScript(html: string): string {
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  expect(match).not.toBeNull();
  return match?.[1] ?? '';
}

interface FakeCopyButton {
  dataset: { copyValue: string };
  disabled: boolean;
  textContent: string;
  closest: (selector: string) => FakeCopyButton | null;
}

function fakeCopyButton(copyValue: string): FakeCopyButton {
  const button: FakeCopyButton = {
    dataset: { copyValue },
    disabled: false,
    textContent: '复制',
    closest: (selector) => selector === '[data-copy-value]' ? button : null
  };
  return button;
}

function executeCopyScript(
  script: string,
  options: { clipboardWrite?: (value: string) => Promise<void>; execCommandResult: boolean }
): {
  click: (button: FakeCopyButton) => Promise<void>;
  fallbackValue: () => string;
  finishFeedback: () => void;
} {
  let clickHandler: ((event: { target: FakeCopyButton }) => Promise<void>) | undefined;
  let copiedByFallback = '';
  let feedbackTimer: (() => void) | undefined;
  const textarea = {
    value: '',
    style: {} as Record<string, string>,
    setAttribute: vi.fn(),
    select: vi.fn(),
    remove: vi.fn()
  };
  const document = {
    addEventListener: (event: string, handler: typeof clickHandler) => {
      if (event === 'click') clickHandler = handler;
    },
    createElement: () => textarea,
    body: { appendChild: vi.fn() },
    execCommand: (command: string) => {
      if (command === 'copy') copiedByFallback = textarea.value;
      return options.execCommandResult;
    }
  };
  runInNewContext(script, {
    document,
    navigator: options.clipboardWrite ? { clipboard: { writeText: options.clipboardWrite } } : {},
    setTimeout: (callback: () => void) => {
      feedbackTimer = callback;
      return 1;
    }
  });
  if (!clickHandler) throw new Error('报告复制脚本没有注册点击处理器。');
  return {
    click: (button) => clickHandler?.({ target: button }) ?? Promise.resolve(),
    fallbackValue: () => copiedByFallback,
    finishFeedback: () => feedbackTimer?.()
  };
}
