import { readFile } from 'node:fs/promises';
import { getReleaseUrl } from './release-config.mjs';

const catalogPath = process.argv[2];
if (!catalogPath) throw new Error('用法：node tools/validate-catalog.mjs <catalog.json>');

const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.apps)) throw new Error('catalog.json 必须是 AppCatalogDocumentV1。');

const appIds = new Set();
for (const app of catalog.apps) {
  if (!app || typeof app !== 'object' || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(app.id ?? '')) throw new Error('应用目录包含无效应用 ID。');
  if (appIds.has(app.id)) throw new Error(`应用目录存在重复应用：${app.id}`);
  appIds.add(app.id);
  if (!app.name || !app.description || !app.publisherId || !Array.isArray(app.releases)) throw new Error(`应用目录条目不完整：${app.id}`);

  const versions = new Set();
  for (const release of app.releases) {
    if (!release || typeof release !== 'object') throw new Error(`应用版本记录无效：${app.id}`);
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(release.version ?? '')) throw new Error(`应用版本号无效：${app.id}`);
    if (versions.has(release.version)) throw new Error(`应用目录存在重复版本：${app.id}@${release.version}`);
    versions.add(release.version);
    if (!/^\d+\.\d+$/.test(release.hostApiVersion ?? '') || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(release.minWorkbenchVersion ?? '')) throw new Error(`应用宿主兼容版本无效：${app.id}@${release.version}`);
    const legacyUrl = `https://github.com/thelinyue/Workbench-Apps/releases/download/${app.id}-v${release.version}/${app.id}-v${release.version}.zip`;
    const unifiedUrl = getReleaseUrl(app.id, release.version);
    if (release.url !== legacyUrl && release.url !== unifiedUrl) throw new Error(`应用 Release 地址不符合约定：${app.id}@${release.version}`);
    if (!Number.isInteger(release.size) || release.size <= 0 || release.size > 200 * 1024 * 1024) throw new Error(`应用 ZIP 大小无效：${app.id}@${release.version}`);
    if (!/^[0-9a-f]{64}$/i.test(release.sha256 ?? '')) throw new Error(`应用 ZIP SHA-256 无效：${app.id}@${release.version}`);
    if (!release.signature?.keyId || typeof release.signature.signature !== 'string') throw new Error(`应用 Release 缺少签名：${app.id}@${release.version}`);
    const signature = Buffer.from(release.signature.signature, 'base64');
    if (signature.byteLength !== 64) throw new Error(`应用 Release 签名长度无效：${app.id}@${release.version}`);
  }
}

console.log(`应用目录校验通过：${catalog.apps.length} 个应用，${catalog.apps.reduce((count, app) => count + app.releases.length, 0)} 个版本。`);
