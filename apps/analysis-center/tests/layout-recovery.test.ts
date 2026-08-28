import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const viewSource = await readFile(new URL('../renderer/view.tsx', import.meta.url), 'utf8');
const styleSource = await readFile(new URL('../renderer/style.css', import.meta.url), 'utf8');
const hostSource = await readFile(new URL('../renderer/host-api.ts', import.meta.url), 'utf8');

describe('分析中心 V1 工作区', () => {
  it('按快速分析、待分析、正在分析和最近分析的优先级组织工作区', () => {
    expect(viewSource).toContain('className="workspace-dropzone"');
    expect(viewSource).toContain('待分析');
    expect(viewSource).toContain('分析队列');
    expect(viewSource).toContain('最近分析');
    expect(viewSource).toContain('.slice(0, 20)');
    expect(styleSource).toContain('.workspace-view { max-width: 980px;');
    expect(styleSource).toContain('.workspace-list-item, .running-task');
  });

  it('通过设置弹窗维护单一监控目录，而不在首页展示监控卡', () => {
    expect(viewSource).toContain('createSettingsActions');
    expect(viewSource).toContain('settingsActions.chooseDirectory()');
    expect(viewSource).toContain('settingsActions.save()');
    expect(viewSource).toContain('启用目录监控');
    expect(viewSource).toContain('分析中心设置');
    expect(viewSource.match(/aria-label="打开分析中心设置"/g)).toHaveLength(2);
    expect(viewSource.match(/title="打开分析中心设置"/g)).toHaveLength(2);
    expect(viewSource.match(/onClick=\{openSettings\}/g)).toHaveLength(2);
    expect(viewSource).toContain("const openSettings = () => { setSettingsDraft(monitor); setSettingsError(''); setSettingsOpen(true); };");
    expect(viewSource).not.toContain('host.onCommand');
    expect(viewSource).not.toContain('settings.open');
    expect(hostSource).not.toContain('workbench-app-command');
    expect(hostSource).not.toContain('commandListeners');
    expect(hostSource).not.toContain('onCommand(');
    expect(viewSource).not.toContain('workspace-section monitor');
  });

  it('结果页提供浏览器呈现和明确触发的 HTML 副本保存', () => {
    expect(viewSource).toContain("host.invoke('host.openPath'");
    expect(viewSource).toContain("host.invoke('host.saveFile'");
    expect(viewSource).toContain('另存为 HTML');
    expect(styleSource).toContain('.result-evidence-panel');
  });

  it('使用 1100px 产品边界在固定证据栏和覆盖式 Drawer 之间切换', () => {
    expect(viewSource).toContain('className="workspace-dropzone"');
    expect(viewSource).toContain('className="workspace-list-item"');
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

  it('首次加载和应用事件监听不因监控设置对象更新而重复注册', () => {
    expect(viewSource).toContain('}, [load, packageImportWorkflow]);');
    expect(viewSource).toContain('packageImportWorkflow.handleHostEvent(event)');
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
    expect(viewSource).toContain('拖入诊断包，导入到“待分析”');
    expect(viewSource).not.toContain('拖入诊断包开始分析');
  });
});
