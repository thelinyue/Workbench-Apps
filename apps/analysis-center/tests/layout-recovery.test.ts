import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const viewSource = await readFile(new URL('../renderer/view.tsx', import.meta.url), 'utf8');
const styleSource = await readFile(new URL('../renderer/style.css', import.meta.url), 'utf8');
const hostSource = await readFile(new URL('../renderer/host-api.ts', import.meta.url), 'utf8');

describe('分析中心 V1 工作区', () => {
  it('按监控状态、统一分析任务列表和手动导入组织工作区', () => {
    expect(viewSource).toContain('className="workspace-dropzone"');
    expect(viewSource).toContain('<AnalysisTaskList packages={packages} tasks={tasks}');
    expect(viewSource).toContain('export function AnalysisTaskToolbar');
    expect(viewSource).toContain("useState<AnalysisTaskFilter>('all')");
    expect(viewSource).toContain("useState<AnalysisTaskSort>('action-priority')");
    expect(styleSource).toContain('.workspace-view { max-width: 1370px;');
    expect(styleSource).toContain('.analysis-task-row {');
  });

  it('最小宽度下监控操作行固定高度并保持三个按钮对齐', () => {
    expect(styleSource).toContain('.monitor-actions { display: flex; height: 34px; min-height: 34px;');
    expect(styleSource).toContain('.monitor-actions > button { height: 34px; min-height: 34px;');
    expect(styleSource).toContain('.monitor-actions { grid-column: 2 / -1; justify-self: end; justify-content: flex-end; }');
  });

  it('首页状态条与设置弹窗明确区分新增自动分析和手动扫描存量', () => {
    expect(viewSource).toContain('createSettingsActions');
    expect(viewSource).toContain('settingsActions.chooseDirectory()');
    expect(viewSource).toContain('settingsActions.save()');
    expect(viewSource).toContain('启用目录监控');
    expect(viewSource).toContain('发现后自动分析');
    expect(viewSource).toContain('扫描存量');
    expect(viewSource).toContain('仅处理启用监控后新增');
    expect(viewSource).toContain("host.invoke('packages.scan')");
    expect(viewSource).toContain('分析中心设置');
    expect(viewSource.match(/aria-label="打开分析中心设置"/g)).toHaveLength(2);
    expect(viewSource.match(/title="打开分析中心设置"/g)).toHaveLength(2);
    expect(viewSource.match(/onClick=\{\(event\) => openSettings\(event\.currentTarget\)\}/g)).toHaveLength(2);
    expect(viewSource).toContain('setSettingsDraft(monitor)');
    expect(viewSource).not.toContain('host.onCommand');
    expect(viewSource).not.toContain('settings.open');
    expect(hostSource).not.toContain('workbench-app-command');
    expect(hostSource).not.toContain('commandListeners');
    expect(hostSource).not.toContain('onCommand(');
    expect(viewSource).toContain('className="monitor-statusbar"');
  });

  it('结果页提供浏览器呈现和明确触发的 HTML 副本保存', () => {
    expect(viewSource).toContain("host.invoke('host.openPath'");
    expect(viewSource).toContain("host.invoke('host.saveFile'");
    expect(viewSource).toContain('另存为 HTML');
    expect(viewSource).toContain('aria-label="打开结果更多操作"');
    expect(viewSource).toContain('定位原始诊断包');
    expect(styleSource).toContain('.result-evidence-panel');
    expect(viewSource).toContain('查看完整 sysinfo');
    expect(viewSource).toContain('sysinfoReportLoading ? \'生成中\' : \'查看完整 sysinfo\'');
    expect(viewSource).toContain('disabled={sysinfoReportLoading}');
    expect(styleSource).toContain('.sysinfo-report-button { min-width: 142px;');
  });

  it('结果页仅为非 ZIP 诊断包渲染完整 sysinfo 入口', () => {
    expect(viewSource).toContain('shouldShowSysinfoReport');
    expect(viewSource).toContain('sourcePath');
    expect(viewSource).toContain('shouldShowSysinfoReport(resultSourcePath) &&');
  });

  it('使用 1100px 产品边界在固定证据栏和覆盖式 Drawer 之间切换', () => {
    expect(viewSource).toContain('className="workspace-dropzone"');
    expect(viewSource).toContain('analysis-task-row${highlighted');
    expect(viewSource).toContain('className="result-evidence-panel"');
    expect(viewSource).toContain('当前主要诊断没有关联证据');
    expect(viewSource).toContain('诊断证据</button>');
    expect(viewSource).toContain('role="dialog"');
    expect(viewSource).toContain('aria-modal="true"');
    expect(viewSource).toContain('aria-label="诊断证据抽屉"');
    expect(viewSource).toContain('aria-label="关闭诊断证据"');
    expect(viewSource).toContain('className="evidence-drawer-backdrop"');
    expect(viewSource).toContain('onClick={(event) => openEvidence(event.currentTarget)}');
    expect(viewSource).toContain('onEvidence={(trigger) => openEvidence(trigger)}');
    expect(viewSource).toContain('onMouseDown={evidenceDrawerController.close}');
    expect(viewSource).toContain('onClose={evidenceDrawerController.close}');
    expect(viewSource).toContain('ref={evidenceDrawerRef}');
    expect(viewSource).toContain('attachLifecycle(document, evidenceCloseRef.current, evidenceDrawerRef.current)');
    expect(viewSource).toContain('evidenceDrawerController.setPresentation(getEvidencePresentation(window.innerWidth))');
    expect(styleSource).toContain('.workspace-dropzone {');
    expect(styleSource).toContain('.result-layout {');
    expect(styleSource).toContain('.result-evidence-panel {');
    expect(styleSource).toContain('@media (max-width: 1099px)');
    expect(styleSource).not.toContain('@media (max-width: 920px)');
    expect(styleSource).toContain('.evidence-drawer-backdrop');
    expect(styleSource).toContain('.evidence-drawer');
  });

  it('普通任务行只保留状态、信息和操作区域，时间与大小不再独占列', () => {
    expect(styleSource).toContain('grid-template-columns: 34px minmax(0, 1fr) auto;');
    expect(styleSource).toContain('.running-task.analysis-task-row { display: block; }');
    expect(styleSource).toContain('.task-title-line {');
    expect(styleSource).toContain('.task-inline-meta {');
    expect(styleSource).not.toContain('.package-size { grid-column: 3;');
    expect(styleSource).not.toContain('.package-time { grid-column: 4;');
  });

  it('首次加载和应用事件监听不因监控设置对象更新而重复注册', () => {
    expect(viewSource).toContain('}, [load, openResult, packageImportWorkflow]);');
    expect(viewSource).toContain('packageImportWorkflow.handleHostEvent(event)');
    expect(viewSource).toContain('getNotificationActivation(event)');
  });

  it('列表始终由用户主动进入结果，且结果页也能渲染设置弹窗', () => {
    expect(viewSource).not.toContain('openedTaskIds');
    expect(viewSource).not.toContain('setResult(completedResult)');
    expect(viewSource).toContain('resultPage');
    expect(viewSource).toContain('const settingsDialog = settingsOpen && <SettingsDialog');
  });

  it('默认隐藏单项勾选框，点击批量管理后进入上下文选择模式', () => {
    expect(viewSource).toContain('const [batchSelectionOpen, setBatchSelectionOpen] = useState(false);');
    expect(viewSource).toContain('onEnterSelection={() => setBatchSelectionOpen(true)}');
    expect(viewSource).toContain('batchSelectionOpen && isRecent &&');
    expect(viewSource).toContain('props.selectionOpen ? <div className="selection-toolbar">');
  });

  it('清空全选或删除完成后退出批量选择模式', () => {
    expect(viewSource).toContain('const exitSelection = () => { setBatchSelectionOpen(false); setSelectedPackageIds([]); };');
    expect(viewSource).toContain('setBatchSelectionOpen(false);');
    expect(viewSource).toContain('setSelectedPackageIds([]);');
  });

  it('文件选择和拖入均接入批次导入 workflow，拖入文案明确只导入待分析', () => {
    expect(viewSource).toContain('packageImportWorkflow.importSelectedFiles()');
    expect(viewSource).toContain('packageImportWorkflow.importDroppedFiles(files)');
    expect(viewSource).toContain('导入后将加入待分析');
    expect(viewSource).not.toContain('拖入诊断包开始分析');
    expect(viewSource).toContain('className="drop-overlay"');
    expect(viewSource).toContain('松开以导入诊断包');
  });
});
