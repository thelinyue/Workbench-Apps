import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const viewSource = await readFile(new URL('../renderer/view.tsx', import.meta.url), 'utf8');
const styleSource = await readFile(new URL('../renderer/style.css', import.meta.url), 'utf8');
const hostSource = await readFile(new URL('../renderer/host-api.ts', import.meta.url), 'utf8');

describe('分析中心 V1 工作区', () => {
  it('按监控状态、待分析、正在分析、最近分析和手动导入组织工作区', () => {
    expect(viewSource).toContain('className="workspace-dropzone"');
    expect(viewSource).toContain('待分析');
    expect(viewSource).toContain('正在分析');
    expect(viewSource).toContain('最近分析');
    expect(viewSource).toContain('getWorkspaceGroups(packages)');
    expect(styleSource).toContain('.workspace-view { max-width: 1370px;');
    expect(styleSource).toContain('.workspace-list-item {');
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
    expect(viewSource).toContain('workspace-list-item${');
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

  it('800px 最近分析行的操作区固定在末列，不会因缺少文件大小而溢出窗口', () => {
    expect(styleSource).toContain('.package-size { grid-column: 3;');
    expect(styleSource).toContain('.package-time { grid-column: 4;');
    expect(styleSource).toContain('.card-actions { grid-column: 5;');
    expect(styleSource).toContain('.card-actions { grid-column: 4; }');
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

  it('文件选择和拖入均接入批次导入 workflow，拖入文案明确只导入待分析', () => {
    expect(viewSource).toContain('packageImportWorkflow.importSelectedFiles()');
    expect(viewSource).toContain('packageImportWorkflow.importDroppedFiles(files)');
    expect(viewSource).toContain('导入后将加入待分析');
    expect(viewSource).not.toContain('拖入诊断包开始分析');
    expect(viewSource).toContain('className="drop-overlay"');
    expect(viewSource).toContain('松开以导入诊断包');
  });
});
