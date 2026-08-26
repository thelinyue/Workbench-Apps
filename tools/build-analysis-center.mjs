import { execFileSync } from 'node:child_process';
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { access, copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDeterministicZip } from './create-deterministic-zip.mjs';
import { getReleaseAssetName, getReleaseUrl } from './release-config.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appRoot = join(root, 'apps', 'analysis-center');
const dist = join(appRoot, 'dist');
const manifestPath = join(appRoot, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
runVite('vite.renderer.config.ts');
runVite('vite.backend.config.ts');
await copyFile(manifestPath, join(dist, 'manifest.json'));
await mkdir(join(dist, 'renderer'), { recursive: true });
await copyFile(join(appRoot, 'renderer', 'icon.svg'), join(dist, 'renderer', 'icon.svg'));

const zipPath = join(dist, getReleaseAssetName(manifest.id, manifest.version));
await createDeterministicZip(dist, zipPath);
const bytes = await readFile(zipPath);
const release = {
  appId: manifest.id,
  version: manifest.version,
  hostApiVersion: manifest.hostApiVersion,
  minWorkbenchVersion: manifest.minWorkbenchVersion,
  url: getReleaseUrl(manifest.id, manifest.version),
  size: bytes.byteLength,
  sha256: createHash('sha256').update(bytes).digest('hex')
};
const privateKeyPem = process.env.HEPHAESTUS_APP_SIGNING_PRIVATE_KEY;
const keyId = process.env.HEPHAESTUS_APP_SIGNING_KEY_ID;
if (privateKeyPem && keyId) {
  release.signature = { keyId, signature: sign(null, bytes, createPrivateKey(privateKeyPem)).toString('base64') };
}
await writeFile(join(dist, 'release.json'), JSON.stringify(release, null, 2));
console.log(`已构建分析中心种子包：${zipPath}`);
console.log(`SHA-256：${release.sha256}`);
if (!release.signature) console.warn('警告：未提供签名私钥，当前 ZIP 只能用于构建检查，不能通过正式安装校验。');

function runVite(config) {
  execFileSync(process.execPath, [join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', join(appRoot, config)], { cwd: root, stdio: 'inherit' });
}
