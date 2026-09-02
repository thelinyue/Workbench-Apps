/**
 * 统一应用发布页的稳定配置。
 *
 * 应用版本仍由各自 manifest 管理，只有下载资产的 Release 页面统一，
 * 这样目录可以保留独立版本，同时让用户从一个页面获取所有应用更新。
 */
export const UNIFIED_RELEASE_TAG = 'workbench-apps';

const RELEASE_BASE_URL = `https://github.com/thelinyue/Workbench-Apps/releases/download/${UNIFIED_RELEASE_TAG}`;

export function getReleaseAssetName(appId, version) {
  return `${appId}-v${version}.zip`;
}

export function getReleaseUrl(appId, version) {
  return `${RELEASE_BASE_URL}/${getReleaseAssetName(appId, version)}`;
}

export function getAnalysisRulesReleaseUrl(version) {
  return `${RELEASE_BASE_URL}/analysis-center-rules-v${version}.json`;
}
