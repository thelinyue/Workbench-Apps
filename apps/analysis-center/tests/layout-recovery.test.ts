import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const viewSource = await readFile(new URL('../renderer/view.tsx', import.meta.url), 'utf8');
const styleSource = await readFile(new URL('../renderer/style.css', import.meta.url), 'utf8');

describe('分析中心 V1 工作区', () => {
  it('按快速分析、待分析、正在分析和最近分析的优先级组织工作区', () => {
    expect(viewSource).toContain('className="quick-analysis"');
    expect(viewSource).toContain('待分析');
    expect(viewSource).toContain('正在分析');
    expect(viewSource).toContain('最近分析');
    expect(viewSource).toContain('.slice(0, 20)');
    expect(styleSource).toContain('.analysis-app { min-height: 100vh;');
    expect(styleSource).not.toContain('.content { margin-top: 18px; align-items: flex-start; }');
  });

  it('仅允许一个可启停的监控目录，并由宿主选择', () => {
    expect(viewSource).toContain("host.invoke<string[]>('host.chooseDirectory')");
    expect(viewSource).toContain("host.invoke('settings.save', { directory");
    expect(viewSource).toContain('启用监控');
    expect(viewSource).toContain('更换目录');
  });

  it('结果页提供浏览器呈现和明确触发的 HTML 副本保存', () => {
    expect(viewSource).toContain("host.invoke('host.openPath'");
    expect(viewSource).toContain("host.invoke('host.saveFile'");
    expect(viewSource).toContain('另存为 HTML');
    expect(styleSource).toContain('.evidence-drawer');
  });
});
