import { Check, CircleAlert, Download, Pause, Play, RotateCcw, Trash2, Upload, X } from 'lucide-react';
import { useEffect } from 'react';
import type { TransferTask } from '../shared/types';

interface TransferTaskPopoverProps {
  open: boolean;
  tasks: TransferTask[];
  onClose(): void;
  onPause(id: string): void;
  onResume(id: string): void;
  onCancel(id: string): void;
  onRetry(id: string): void;
  onPauseAll(): void;
  onClearCompleted(): void;
}

/** 传输弹层只展示 backend 任务快照，关闭弹层不会影响文件流。 */
export function TransferTaskPopover({ open, tasks, onClose, onPause, onResume, onCancel, onRetry, onPauseAll, onClearCompleted }: TransferTaskPopoverProps) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);
  if (!open) return null;
  const activeCount = tasks.filter((task) => task.state === 'running' || task.state === 'paused' || task.state === 'queued').length;
  return <section className="transfer-popover" role="dialog" aria-label="传输任务">
    <header><strong>传输任务 ({activeCount})</strong><button className="icon-button" type="button" aria-label="关闭传输任务" title="关闭" onClick={onClose}><X size={17} aria-hidden="true" /></button></header>
    <div className="transfer-list">
      {tasks.length === 0 && <p className="popover-empty">暂无传输任务</p>}
      {tasks.map((task) => {
        const progress = task.totalBytes > 0 ? Math.min(100, Math.round(task.transferredBytes / task.totalBytes * 100)) : 0;
        return <article className="transfer-row" key={task.id}>
          <div className={`transfer-kind ${task.state}`}>{task.direction === 'upload' ? <Upload size={16} aria-hidden="true" /> : <Download size={16} aria-hidden="true" />}</div>
          <div className="transfer-content">
            <div className="transfer-title"><strong>{task.name}</strong><span className={`transfer-state ${task.state}`}>{stateLabel(task.state)}</span></div>
            <small title={task.direction === 'upload' ? task.remotePath : task.localPath}>{task.direction === 'upload' ? task.remotePath : task.localPath}</small>
            <div className="transfer-progress" role="progressbar" aria-label={`${task.name} 传输进度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}><span style={{ width: `${progress}%` }} /></div>
            <div className="transfer-meta"><span>{formatBytes(task.transferredBytes)} / {formatBytes(task.totalBytes)} ({progress}%)</span><span>{task.speedBytesPerSecond > 0 ? `${formatBytes(task.speedBytesPerSecond)}/s` : ''}</span></div>
            {task.message && <p className="transfer-error"><CircleAlert size={13} aria-hidden="true" />{task.message}</p>}
          </div>
          <div className="transfer-actions">
            {task.state === 'running' && <button className="icon-button small" type="button" aria-label={`暂停 ${task.name}`} title="暂停" onClick={() => onPause(task.id)}><Pause size={14} aria-hidden="true" /></button>}
            {task.state === 'paused' && <button className="icon-button small" type="button" aria-label={`继续 ${task.name}`} title="继续" onClick={() => onResume(task.id)}><Play size={14} aria-hidden="true" /></button>}
            {(task.state === 'failed' || task.state === 'cancelled') && <button className="icon-button small" type="button" aria-label={`重试 ${task.name}`} title="重试" onClick={() => onRetry(task.id)}><RotateCcw size={14} aria-hidden="true" /></button>}
            {(task.state === 'queued' || task.state === 'running' || task.state === 'paused') && <button className="icon-button small" type="button" aria-label={`取消 ${task.name}`} title="取消" onClick={() => onCancel(task.id)}><X size={14} aria-hidden="true" /></button>}
            {task.state === 'completed' && <Check size={15} aria-label="已完成" />}
          </div>
        </article>;
      })}
    </div>
    <footer><button className="text-button" type="button" onClick={onPauseAll}><Pause size={14} aria-hidden="true" />全部暂停</button><button className="text-button" type="button" onClick={onClearCompleted}><Trash2 size={14} aria-hidden="true" />清空已完成</button></footer>
  </section>;
}

function stateLabel(state: TransferTask['state']): string {
  return ({ queued: '等待中', running: '传输中', paused: '已暂停', completed: '已完成', failed: '失败', cancelled: '已取消' })[state];
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}
