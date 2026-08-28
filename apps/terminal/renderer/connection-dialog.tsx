import { CheckCircle2, FileKey2, Server, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { AuthenticationMethod, ConnectionProfile, ConnectionTarget, RecentConnection } from '../shared/types';
import { parseConnectionTemplate } from './connection-template';

export interface ConnectionDialogValue {
  profile: ConnectionTarget & { id?: string };
  secret?: string;
  sudoSecret?: string;
  saveDevice: boolean;
}

interface ConnectionDialogProps {
  open: boolean;
  initial?: ConnectionProfile | RecentConnection;
  onCancel(): void;
  onSubmit(value: ConnectionDialogValue): void | Promise<void>;
  onChoosePrivateKey(): Promise<string | undefined>;
}

interface Draft {
  id?: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth: AuthenticationMethod;
  privateKeyPath: string;
  secret: string;
  sudoSecret: string;
  autoRoot: boolean;
  shellIntegration: boolean;
  saveDevice: boolean;
  notes: string;
  hostKey?: string;
}

/** 新建与编辑连接共用的受控对话框，秘密只存在于当前 React 状态并直接交给 backend。 */
export function ConnectionDialog({ open, initial, onCancel, onSubmit, onChoosePrivateKey }: ConnectionDialogProps) {
  const [draft, setDraft] = useState<Draft>(() => createDraft(initial));
  const [template, setTemplate] = useState('');
  const [templateState, setTemplateState] = useState<{ kind: 'idle' | 'success' | 'error'; message?: string }>({ kind: 'idle' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const firstFieldRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDraft(createDraft(initial));
    setTemplate('');
    setTemplateState({ kind: 'idle' });
    setError('');
    queueMicrotask(() => firstFieldRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onCancel(); };
    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('keydown', onKeyDown); previousFocus?.focus(); };
  }, [open, initial]);

  if (!open) return null;

  const updateTemplate = (value: string) => {
    setTemplate(value);
    if (!value.trim()) { setTemplateState({ kind: 'idle' }); return; }
    try {
      const parsed = parseConnectionTemplate(value);
      setDraft((current) => ({ ...current, host: parsed.host, port: parsed.port }));
      setTemplateState({ kind: 'success', message: 'JSON 格式正确，已填充主机和端口。' });
    } catch (caught) {
      setTemplateState({ kind: 'error', message: caught instanceof Error ? caught.message : String(caught) });
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft.host.trim() || !draft.username.trim()) { setError('请填写主机和用户名。'); return; }
    if (!Number.isInteger(draft.port) || draft.port < 1 || draft.port > 65_535) { setError('端口必须在 1 到 65535 之间。'); return; }
    if (draft.auth === 'privateKey' && !draft.privateKeyPath.trim()) { setError('请选择私钥文件。'); return; }
    setBusy(true);
    setError('');
    try {
      await onSubmit({
        profile: {
          ...(draft.id ? { id: draft.id } : {}),
          name: draft.name.trim() || draft.host.trim(),
          host: draft.host.trim(),
          port: draft.port,
          username: draft.username.trim(),
          auth: draft.auth,
          ...(draft.privateKeyPath.trim() ? { privateKeyPath: draft.privateKeyPath.trim() } : {}),
          ...(draft.hostKey ? { hostKey: draft.hostKey } : {}),
          autoRoot: draft.autoRoot,
          shellIntegration: draft.shellIntegration,
          ...(draft.notes.trim() ? { notes: draft.notes.trim() } : {})
        },
        secret: draft.secret || undefined,
        sudoSecret: draft.auth === 'privateKey' && draft.autoRoot ? draft.sudoSecret || undefined : undefined,
        saveDevice: draft.saveDevice
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel(); }}>
    <section className="connection-dialog" role="dialog" aria-modal="true" aria-labelledby="connection-dialog-title">
      <header className="dialog-header"><span><Server size={19} aria-hidden="true" /><strong id="connection-dialog-title">{initial ? '编辑 SSH 连接' : '新建 SSH 连接'}</strong></span><button className="icon-button" type="button" aria-label="关闭连接对话框" title="关闭" onClick={onCancel} disabled={busy}><X size={18} aria-hidden="true" /></button></header>
      <div className="connection-dialog-content"><form onSubmit={(event) => void submit(event)}>
        <div className="dialog-scroll">
          <section className="form-section">
            <label htmlFor="connection-json">连接模板（粘贴 JSON）</label>
            <input ref={firstFieldRef} id="connection-json" className="connection-json-input" maxLength={200} value={template} onChange={(event) => updateTemplate(event.target.value)} placeholder={'{"port":8888,"ip":"192.168.1.1"}'} />
            <div className={`field-status ${templateState.kind}`} aria-live="polite">{templateState.kind === 'success' && <CheckCircle2 size={15} aria-hidden="true" />}{templateState.message || '严格接受包含 ip 与 port 的 JSON 对象。'}<span>{template.length}/200</span></div>
          </section>
          <section className="form-section">
            <h3>连接信息</h3>
            <div className="form-grid two-columns">
              <Field label="连接名称"><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="例如：生产存储节点" /></Field>
              <Field label="主机"><input required value={draft.host} onChange={(event) => setDraft({ ...draft, host: event.target.value })} placeholder="IP 或域名" /></Field>
              <Field label="端口"><input required type="number" min={1} max={65535} value={draft.port} onChange={(event) => setDraft({ ...draft, port: Number(event.target.value) })} /></Field>
              <Field label="用户名"><input required autoComplete="username" value={draft.username} onChange={(event) => setDraft({ ...draft, username: event.target.value })} placeholder="root、admin 或 ubuntu" /></Field>
              <Field label="认证方式"><select value={draft.auth} onChange={(event) => setDraft({ ...draft, auth: event.target.value as AuthenticationMethod })}><option value="password">密码认证</option><option value="privateKey">私钥认证</option></select></Field>
              {draft.auth === 'privateKey' && <Field label="私钥文件"><div className="inline-field"><input value={draft.privateKeyPath} onChange={(event) => setDraft({ ...draft, privateKeyPath: event.target.value })} /><button className="icon-button" type="button" aria-label="选择私钥文件" title="选择私钥文件" onClick={() => void onChoosePrivateKey().then((path) => path && setDraft((current) => ({ ...current, privateKeyPath: path })))}><FileKey2 size={17} aria-hidden="true" /></button></div></Field>}
              <Field label={draft.auth === 'password' ? '密码' : '私钥口令'}><input type="password" autoComplete="current-password" value={draft.secret} onChange={(event) => setDraft({ ...draft, secret: event.target.value })} placeholder={initial ? '留空则使用已保存凭据' : '仅保存在当前会话内存中'} /></Field>
            </div>
          </section>
          <div className="form-options-grid">
            <section className="form-section option-section">
              <h3>连接后操作</h3>
              <Checkbox checked={draft.autoRoot} onChange={(checked) => setDraft({ ...draft, autoRoot: checked })} label="连接后自动切换到 root 用户" />
              {draft.auth === 'privateKey' && draft.autoRoot && <Field label="sudo 密码"><input type="password" value={draft.sudoSecret} onChange={(event) => setDraft({ ...draft, sudoSecret: event.target.value })} placeholder="独立的 sudo 密码" /></Field>}
            </section>
            <section className="form-section option-section">
              <h3>保存选项</h3>
              <Checkbox checked={draft.saveDevice} onChange={(checked) => setDraft({ ...draft, saveDevice: checked })} label="保存此设备" />
              <Field label="备注"><input maxLength={100} value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} placeholder="可选" /></Field>
            </section>
          </div>
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
        <footer className="dialog-footer"><button className="secondary-button" type="button" onClick={onCancel} disabled={busy}>取消</button><button className="primary-button" type="submit" disabled={busy}>{busy ? '正在连接…' : '连接'}</button></footer>
      </form></div>
    </section>
  </div>;
}

function createDraft(initial?: ConnectionProfile | RecentConnection): Draft {
  const isSaved = Boolean(initial && !('lastConnectedAt' in initial));
  return {
    id: isSaved ? initial?.id : undefined,
    name: initial?.name ?? '', host: initial?.host ?? '', port: initial?.port ?? 22,
    username: initial?.username ?? '', auth: initial?.auth ?? 'password', privateKeyPath: initial?.privateKeyPath ?? '',
    secret: '', sudoSecret: '', autoRoot: initial?.autoRoot ?? false, shellIntegration: initial?.shellIntegration ?? true,
    saveDevice: isSaved, notes: initial?.notes ?? '', hostKey: initial?.hostKey
  };
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}

function Checkbox({ checked, onChange, label }: { checked: boolean; onChange(value: boolean): void; label: string }) {
  return <label className="checkbox-field"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><span>{label}</span></label>;
}
