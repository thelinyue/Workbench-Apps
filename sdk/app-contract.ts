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
  window?: AppWindowManifest;
  runtime: AppRuntimeV1;
  capabilities: string[];
}

/**
 * 原生独立应用窗口的初始与最小尺寸。
 *
 * 该字段只描述窗口宿主的通用尺寸约束，不承载应用特有的窗口 DSL，
 * 以保持应用包可独立发布且由宿主统一管理窗口生命周期。
 */
export interface AppWindowManifest {
  defaultSize: AppWindowSize;
  minSize: AppWindowSize;
}

/** 原生窗口的像素尺寸。 */
export interface AppWindowSize {
  width: number;
  height: number;
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
