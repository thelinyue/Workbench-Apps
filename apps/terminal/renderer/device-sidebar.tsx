import { Clock3, Edit3, Monitor, Plus, Trash2, X } from 'lucide-react';
import type { ConnectionCollection, ConnectionProfile, ConnectionTarget, RecentConnection } from '../shared/types';

interface DeviceSidebarProps {
  collapsed: boolean;
  connections: ConnectionCollection;
  onNew(): void;
  onConnect(profile: ConnectionProfile | RecentConnection): void;
  onEdit(profile: ConnectionProfile): void;
  onDelete(profile: ConnectionProfile): void;
  onClearRecent(): void;
}

/** 左侧设备导航只承载连接入口，不持有密码或 SSH 会话状态。 */
export function DeviceSidebar({ collapsed, connections, onNew, onConnect, onEdit, onDelete, onClearRecent }: DeviceSidebarProps) {
  return <aside className={`device-sidebar${collapsed ? ' is-collapsed' : ''}`} aria-label="SSH 设备">
    <ConnectionGroup
      title="最近连接"
      icon={<Clock3 size={14} aria-hidden="true" />}
      items={connections.recent}
      collapsed={collapsed}
      action={<button className="text-button" type="button" onClick={onClearRecent} aria-label="清空最近连接" title="清空最近连接"><X size={14} aria-hidden="true" />{!collapsed && '清空'}</button>}
      onConnect={onConnect}
    />
    <ConnectionGroup
      title="已保存连接"
      icon={<Monitor size={14} aria-hidden="true" />}
      items={connections.saved}
      collapsed={collapsed}
      action={<button className="icon-button small" type="button" onClick={onNew} aria-label="新增已保存连接" title="新增已保存连接"><Plus size={15} aria-hidden="true" /></button>}
      onConnect={onConnect}
      onEdit={onEdit}
      onDelete={onDelete}
    />
  </aside>;
}

interface ConnectionGroupProps<T extends ConnectionTarget & { id: string }> {
  title: string;
  icon: React.ReactNode;
  items: T[];
  collapsed: boolean;
  action: React.ReactNode;
  onConnect(item: T): void;
  onEdit?: (item: T) => void;
  onDelete?: (item: T) => void;
}

function ConnectionGroup<T extends ConnectionTarget & { id: string }>({ title, icon, items, collapsed, action, onConnect, onEdit, onDelete }: ConnectionGroupProps<T>) {
  return <section className="connection-group" aria-label={title}>
    <div className="connection-group-heading"><span>{icon}{!collapsed && title}</span>{action}</div>
    <div className="connection-list">
      {items.length === 0 && !collapsed && <p className="compact-empty">暂无记录</p>}
      {items.map((item) => <div className="connection-row" key={item.id}>
        <button className="connection-main" type="button" onClick={() => onConnect(item)} title={`连接 ${item.name || item.host}`}>
          <Monitor size={17} aria-hidden="true" />
          {!collapsed && <span><strong>{item.name || item.host}</strong><small>{item.username}@{item.host}:{item.port}</small></span>}
        </button>
        {!collapsed && onEdit && onDelete && <span className="connection-actions">
          <button className="icon-button small" type="button" aria-label={`编辑${item.name || item.host}`} title={`编辑 ${item.name || item.host}`} onClick={() => onEdit(item)}><Edit3 size={14} aria-hidden="true" /></button>
          <button className="icon-button small danger" type="button" aria-label={`删除${item.name || item.host}`} title={`删除 ${item.name || item.host}`} onClick={() => onDelete(item)}><Trash2 size={14} aria-hidden="true" /></button>
        </span>}
      </div>)}
    </div>
  </section>;
}
