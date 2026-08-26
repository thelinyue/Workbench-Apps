import { readFile, writeFile } from 'node:fs/promises';

const catalogPath = process.argv[2];
const releasePath = process.argv[3];
const manifestPath = process.argv[4];
if (!catalogPath || !releasePath) throw new Error('用法：node tools/update-app-catalog.mjs <catalog.json> <release.json> [manifest.json]');

const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
const release = JSON.parse(await readFile(releasePath, 'utf8'));
if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.apps)) throw new Error('应用目录格式无效');
if (!release.signature?.keyId || !release.signature?.signature) throw new Error('release.json 缺少签名，拒绝更新应用目录');
const appId = release.appId ?? 'analysis-center';
let item = catalog.apps.find((app) => app.id === appId);
if (!item && manifestPath) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.id !== appId) throw new Error('manifest 与 release.json 的应用 ID 不一致');
  item = { id: manifest.id, name: manifest.name, description: manifest.description, publisherId: manifest.publisherId, releases: [] };
  catalog.apps.push(item);
}
if (!item) throw new Error(`应用目录缺少 ${appId} 条目`);
if (item.releases.some((candidate) => candidate.version === release.version)) throw new Error(`应用目录已存在版本：${appId}@${release.version}`);
item.releases.push({
  version: release.version,
  hostApiVersion: release.hostApiVersion,
  minWorkbenchVersion: release.minWorkbenchVersion,
  url: release.url,
  size: release.size,
  sha256: release.sha256,
  signature: release.signature
});
item.releases.sort((left, right) => left.version.localeCompare(right.version, undefined, { numeric: true }));
await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
console.log(`已更新应用目录：${appId}@${release.version}`);
