export interface FindingPresentationInput {
  type: string;
  severity: 'critical' | 'warning' | 'info';
  occurrenceCount: number;
  affectedResources?: string[];
}

export interface ImportantFindingInput extends FindingPresentationInput { id: string; }

interface FindingCopy {
  title: string;
  meaning: string;
  advice: string;
}

const findingCopies: Record<string, FindingCopy> = {
  'storage.io_error': { title: '块设备读写错误', meaning: '存储设备在读取或写入数据时返回错误，可能影响数据访问。', advice: '尽快备份重要数据，并检查硬盘健康状态、连接和供电。' },
  'storage.timeout': { title: '存储设备访问超时', meaning: '存储设备未在预期时间内响应，可能与硬盘、连接或控制器状态有关。', advice: '检查硬盘连接、供电和控制器状态；反复出现时请联系工程师。' },
  'storage.device_reset': { title: '存储设备发生重置', meaning: '系统尝试重新初始化存储设备，说明设备通信曾出现异常。', advice: '检查硬盘连接和供电；如持续发生，请联系工程师进一步检查。' },
  'storage.ata_error': { title: 'SATA/ATA 通信异常', meaning: '系统记录到 SATA/ATA 存储链路通信错误，可能影响硬盘访问稳定性。', advice: '检查硬盘、线缆、背板和供电；反复出现时请联系工程师。' },
  'storage.device_unrecognized': { title: '硬盘未被系统识别', meaning: '系统未能正常识别硬盘，可能与硬盘、槽位或连接状态有关。', advice: '请联系工程师检查硬盘、槽位和连接状态，避免在未确认前继续写入数据。' },
  'storage.media_error': { title: '磁盘介质读写错误', meaning: '存储设备报告无法更正的读写错误，存在数据访问风险。', advice: '尽快备份重要数据，并检查硬盘 SMART 健康状态；必要时联系工程师更换硬盘。' },
  'storage.nvme_error': { title: 'NVMe 固态硬盘异常', meaning: '系统记录到 NVMe 固态硬盘读写或通信错误，可能影响数据访问稳定性。', advice: '尽快备份重要数据，并检查固态硬盘健康、温度和连接状态。' },
  'storage.smart_risk': { title: '硬盘健康指标异常', meaning: '硬盘 SMART 健康指标出现风险值，提示存储介质可能存在故障隐患。', advice: '尽快备份重要数据，并安排工程师核验硬盘健康状态。' },
  'filesystem.error': { title: '文件系统错误', meaning: '文件系统记录到错误，可能影响文件读取、写入或挂载。', advice: '请联系工程师检查文件系统；不要自行执行可能写入数据的修复命令。' },
  'filesystem.read_only': { title: '文件系统已切换为只读', meaning: '系统为保护数据将文件系统切换为只读，后续写入可能失败。', advice: '尽快备份可读取的数据，并联系工程师检查文件系统和底层存储。' },
  'raid.member_failed': { title: 'RAID 成员盘异常', meaning: 'RAID 阵列中的一块成员硬盘已被标记为异常，阵列冗余可能降低。', advice: '尽快备份重要数据，并联系工程师确认阵列冗余和故障硬盘状态。' },
  'raid.degraded': { title: 'RAID 阵列已降级', meaning: 'RAID 阵列当前未处于完整冗余状态，继续发生故障可能影响数据可用性。', advice: '尽快备份重要数据，并联系工程师检查阵列成员和冗余状态。' },
  'system.kernel_panic': { title: '系统内核崩溃', meaning: '系统发生内核崩溃，服务可能已中断或异常重启。', advice: '请联系工程师保留日志并检查近期硬件和系统变更。' },
  'system.oom': { title: '系统内存耗尽', meaning: '系统可用内存不足，可能导致服务响应变慢或失败。', advice: '请联系工程师检查内存使用情况和异常进程。' },
  'system.oom_killer': { title: '系统因内存不足终止进程', meaning: '系统为释放内存终止了进程，相关服务可能已中断。', advice: '请联系工程师检查被终止的服务和内存使用情况。' },
  'system.watchdog': { title: '系统检测到卡死', meaning: '系统检测到内核或处理器长时间无响应，可能影响服务可用性。', advice: '请联系工程师保留日志并检查系统与硬件状态。' },
  'system.unclean_shutdown': { title: '检测到异常关机线索', meaning: '日志显示系统可能未按正常流程关机，需结合现场情况确认原因。', advice: '检查电源、设备运行记录和文件系统状态；如反复发生请联系工程师。' }
};

const riskLabels = { critical: '严重', warning: '警告', info: '提示' } as const;

/**
 * 仅将既有事件类型转换为面向用户的说明，不重新解析证据、推断根因或调整分析器给出的风险等级。
 * 原始事件键始终保留，便于工程师将页面内容与底层日志规则对应。
 */
export function presentFinding(input: FindingPresentationInput) {
  const copy = findingCopies[input.type] ?? {
    title: '未分类异常',
    meaning: '日志中记录到尚未归类的异常事件，当前无法仅凭该事件确定具体原因。',
    advice: '请保留诊断日志并联系工程师进一步检查。'
  };
  return { ...copy, occurrenceText: `已记录 ${input.occurrenceCount} 次。`, riskLabel: riskLabels[input.severity], technicalEvent: input.type, affectedResources: input.affectedResources ?? [] };
}

/** 页面与导出报告只列出未被主要诊断吸收的严重或警告事件，避免重复陈述相同证据。 */
export function selectImportantFindings<T extends ImportantFindingInput>(findings: readonly T[], primaryFindingIds: Iterable<string> = []) {
  const primaryIds = new Set(primaryFindingIds);
  return findings
    .filter((item) => !primaryIds.has(item.id) && (item.severity === 'critical' || item.severity === 'warning'))
    .map((item) => ({ ...item, display: presentFinding(item) }));
}
