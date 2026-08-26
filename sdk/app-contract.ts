/**
 * 工作台与内嵌应用之间的稳定契约。
 *
 * 应用包只能依赖这些公开类型和 Host API，不得引用工作台主进程内部服务，
 * 这样应用才能在不修改工作台版本的情况下独立发布。
 */
export interface AppManifestV1 {
  schemaVersion: 1;
  id: string;
  name: string;
  description: string;
  publisherId: string;
  version: string;
  hostApiVersion: string;
  minWorkbenchVersion: string;
  runtime: AppRuntimeV1;
  capabilities: string[];
}

/** 应用 renderer 的运行方式；backendEntry 保持可选以支持纯静态 Web 工具。 */
export type AppRuntimeV1 =
  | { kind: 'web'; rendererEntry: string; icon: string }
  | { kind?: 'backend'; rendererEntry: string; backendEntry: string; icon: string };

export interface AppCatalogRelease {
  version: string;
  hostApiVersion: string;
  minWorkbenchVersion: string;
  url: string;
  size: number;
  sha256: string;
  signature: { keyId: string; signature: string };
}

export interface AppCatalogItem {
  id: string;
  name: string;
  description: string;
  publisherId: string;
  releases: AppCatalogRelease[];
}

export interface AppCatalogDocumentV1 {
  schemaVersion: 1;
  apps: AppCatalogItem[];
}

export type AppInstallState = 'not-installed' | 'installed' | 'update-available' | 'incompatible' | 'broken' | 'installing';

export interface AppInstallRecord {
  id: string;
  name: string;
  description: string;
  publisherId: string;
  installedVersion?: string;
  availableVersion?: string;
  activeVersion?: string;
  installPath?: string;
  state: AppInstallState;
  errorMessage?: string;
}

export interface AppCatalogSnapshot {
  catalog: AppCatalogDocumentV1;
  fetchedAt: string;
  fromCache: boolean;
  warning?: string;
}

export interface AppRpcRequest {
  appId: string;
  requestId: string;
  method: string;
  payload: unknown;
}

export interface AppRpcResponse {
  requestId: string;
  ok: boolean;
  result?: unknown;
  errorMessage?: string;
}

export interface AppHostEvent {
  appId: string;
  event: string;
  payload: unknown;
}
