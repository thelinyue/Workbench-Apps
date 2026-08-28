export type AuthenticationMethod = 'password' | 'privateKey';

export interface ConnectionProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth: AuthenticationMethod;
  privateKeyPath?: string;
  credentialId?: string;
  sudoCredentialId?: string;
  hostKey?: string;
  autoRoot?: boolean;
  shellIntegration?: boolean;
  notes?: string;
  lastConnectedAt?: string;
}

export interface ConnectionTarget extends Omit<ConnectionProfile, 'id' | 'credentialId' | 'sudoCredentialId' | 'lastConnectedAt'> {
  savedProfileId?: string;
}

export interface RecentConnection extends ConnectionTarget {
  id: string;
  lastConnectedAt: string;
}

export interface ConnectionCollection {
  saved: ConnectionProfile[];
  recent: RecentConnection[];
}

export type SessionState = 'connecting' | 'connected' | 'disconnected' | 'error';
export type TransferState = 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';

export interface SessionSummary {
  id: string;
  title: string;
  profile: ConnectionTarget;
  state: SessionState;
  message?: string;
  cwd?: string;
  integration: 'pending' | 'following' | 'independent';
}

export interface RemoteFileEntry {
  name: string;
  path: string;
  kind: 'directory' | 'file' | 'link';
  size: number;
  modifiedAt?: number;
}

export interface TransferTask {
  id: string;
  sessionId: string;
  direction: 'upload' | 'download';
  name: string;
  localPath: string;
  remotePath: string;
  transferredBytes: number;
  totalBytes: number;
  state: TransferState;
  speedBytesPerSecond: number;
  message?: string;
}
