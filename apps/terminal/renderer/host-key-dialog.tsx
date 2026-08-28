import { Fingerprint, ShieldAlert, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { ConnectionTarget } from '../shared/types';

export interface HostKeyRequest {
  id: string;
  profile: ConnectionTarget;
  fingerprint: string;
  changed: boolean;
}

interface HostKeyDialogProps {
  request?: HostKeyRequest;
  onCancel(): void;
  onTrust(request: HostKeyRequest): void;
}

/** 主机身份确认必须在应用内完成，指纹变化默认阻断且不会自动覆盖旧值。 */
export function HostKeyDialog({ request, onCancel, onTrust }: HostKeyDialogProps) {
  const trustRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!request) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKeyDown);
    queueMicrotask(() => trustRef.current?.focus());
    return () => { window.removeEventListener('keydown', onKeyDown); previous?.focus(); };
  }, [request, onCancel]);
  if (!request) return null;
  return <div className="dialog-backdrop">
    <section className={`host-key-dialog${request.changed ? ' changed' : ''}`} role="alertdialog" aria-modal="true" aria-labelledby="host-key-title">
      <header><span>{request.changed ? <ShieldAlert size={20} aria-hidden="true" /> : <Fingerprint size={20} aria-hidden="true" />}<strong id="host-key-title">{request.changed ? '主机指纹已变化' : '确认主机指纹'}</strong></span><button className="icon-button" type="button" aria-label="关闭主机指纹确认" title="关闭" onClick={onCancel}><X size={18} aria-hidden="true" /></button></header>
      <div className="host-key-content">
        <p>{request.changed ? '服务器返回的指纹与已保存值不同，连接已阻止。仅在确认服务器密钥确实更换后重新信任。' : `首次连接 ${request.profile.host}，请核对服务器主机密钥指纹。`}</p>
        <code>{request.fingerprint}</code>
      </div>
      <footer><button className="secondary-button" type="button" onClick={onCancel}>取消</button><button ref={trustRef} className={request.changed ? 'danger-button' : 'primary-button'} type="button" onClick={() => onTrust(request)}>{request.changed ? '重新信任并连接' : '信任并连接'}</button></footer>
    </section>
  </div>;
}
