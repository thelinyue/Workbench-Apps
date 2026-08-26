import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('SSH 终端应用 manifest', () => {
  it('声明独立运行时和受限的 SSH 凭据能力', () => {
    const manifestPath = resolve(process.cwd(), 'apps/ssh-terminal/manifest.json');

    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      id: 'ssh-terminal',
      runtime: { rendererEntry: 'renderer/index.html', backendEntry: 'backend/entry.js' },
      capabilities: ['ssh.credentials']
    });
  });
});
