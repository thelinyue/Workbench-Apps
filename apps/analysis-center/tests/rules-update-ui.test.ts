import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const source = await readFile(new URL('../renderer/view.tsx', import.meta.url), 'utf8');

describe('分析中心规则更新界面', () => {
  it('加载当前规则版本并通过独立忙碌状态执行更新', () => {
    expect(source).toContain("host.invoke<RuleUpdateState>('rules.getUpdateState')");
    expect(source).toContain("host.invoke<RuleUpdateResult>('rules.updateOfficial')");
    expect(source).toContain('const [ruleUpdateBusy, setRuleUpdateBusy] = useState(false);');
    expect(source).toContain('disabled={ruleUpdateBusy}');
  });

  it('显示规则版本、检查动作和可访问状态反馈', () => {
    expect(source).toContain('规则版本');
    expect(source).toContain('检查更新');
    expect(source).toContain('正在检查');
    expect(source).toContain('role="status"');
    expect(source).toContain('RefreshCw');
  });
});
