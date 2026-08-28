import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('SSH 终端应用 manifest', () => {
  it('声明 2.0 独立窗口、兼容门槛和所需最小宿主能力', () => {
    const manifestPath = resolve(process.cwd(), 'apps/terminal/manifest.json');

    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      id: 'terminal',
      version: '2.0.0',
      minWorkbenchVersion: '0.1.8',
      window: {
        defaultSize: { width: 1440, height: 900 },
        minSize: { width: 960, height: 640 }
      },
      runtime: { rendererEntry: 'renderer/index.html', backendEntry: 'backend/entry.js' },
      capabilities: ['ssh.credentials', 'file.open', 'file.save', 'clipboard.read', 'clipboard.write']
    });
  });
});
