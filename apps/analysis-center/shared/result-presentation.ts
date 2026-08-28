import type { AnalysisResult, DeviceAssessment } from '../backend/lib/analysis-v1/pipeline';
import { selectImportantFindings } from './finding-presentation';

type ResultInput = Pick<AnalysisResult, 'status' | 'diagnoses' | 'findings' | 'recommendations' | 'metadata'> & { deviceAssessments?: DeviceAssessment[]; };

const localizeDevice = (label: string | undefined, resource: string) => {
  const m2 = label?.match(/^M\.2\s+Hard Drive\s+(\d+)$/i);
  const disk = label?.match(/^Hard Drive\s+(\d+)$/i);
  return m2 ? `M.2 硬盘 ${m2[1]}` : disk ? `硬盘 ${disk[1]}` : label ?? resource;
};
const localizePool = (value: string) => value.replace(/^Storage Pool\s+(\d+)$/i, '存储池 $1').replace(/^pool(\d+)$/i, '存储池 $1');

/** 结果展示只整理既有诊断事实，绝不从证据重新推断或提高结论确定性。 */
export function buildResultPresentation(result: ResultInput) {
  const primary = result.diagnoses[0];
  const primaryFindingIds = new Set(primary?.findingIds ?? []);
  const deviceResources = new Set(primary?.affectedDeviceResources ?? []);
  const devices = (result.deviceAssessments ?? []).filter((item) => deviceResources.has(item.resource)).map((item: DeviceAssessment) => ({ ...item, label: localizeDevice(item.label, item.resource), usedFor: item.usedFor ? localizePool(item.usedFor) : '日志未提供' }));
  const resources = primary?.affectedResources ?? [];
  const storage = resources.filter((value) => /^(?:pool|storage)\d+$/i.test(value) || value.startsWith('/volume')).map((resource) => ({ resource, label: localizePool(resource) }));
  const raids = resources.filter((value) => /^md\d+$/i.test(value)).map((resource) => ({ resource, label: resource }));
  const importantFindings = selectImportantFindings(result.findings, primaryFindingIds);
  const summary = primary ? { title: primary.title, text: primary.summary, severity: primary.severity, confidence: primary.confidence } : result.status === 'partial'
    ? { title: '分析部分完成', text: `当前日志缺少${result.metadata.missingData.join('、') || '部分信息'}，结论可能受到影响。`, severity: 'warning', confidence: 'medium' }
    : { title: '未发现明确异常', text: '当前日志范围内未检测到现有规则覆盖的高风险系统或存储故障，不等同于设备绝对正常。', severity: 'info', confidence: 'low' };
  const customerReply = primary?.userConclusion ?? (result.status === 'partial' ? `经检查，当前诊断日志缺少${result.metadata.missingData.join('、') || '部分信息'}，暂时无法形成完整结论。` : '经检查，目前提供的诊断日志中暂未发现明确的系统或存储异常。');
  return { primary, summary, customerReply, impact: { devices, raids, storage }, importantFindings };
}
