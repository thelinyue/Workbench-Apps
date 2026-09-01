// @vitest-environment happy-dom

import { act, createElement, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import * as viewModule from '../renderer/view';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('分析任务紧凑工具栏', () => {
  it('默认只呈现筛选、排序和批量管理三个入口', () => {
    const Toolbar = (viewModule as unknown as { AnalysisTaskToolbar?: React.ComponentType<Record<string, unknown>> }).AnalysisTaskToolbar;
    expect(Toolbar).toBeTypeOf('function');
    if (!Toolbar) return;

    const markup = renderToStaticMarkup(createElement(Toolbar, {
      count: 12,
      filter: 'all',
      counts: { all: 12, pending: 3, active: 1, recent: 8 },
      sort: 'action-priority',
      selectionOpen: false,
      selectedCount: 0,
      allSelectableSelected: false,
      batchBusy: false,
      batchAvailable: true,
      onFilterChange: vi.fn(),
      onSortChange: vi.fn(),
      onEnterSelection: vi.fn(),
      onToggleAll: vi.fn(),
      onDelete: vi.fn(),
      onExitSelection: vi.fn()
    }));

    expect(markup).toContain('>分析任务 <span>12</span>');
    expect(markup).toContain('全部任务 12');
    expect(markup).toContain('行动优先');
    expect(markup).toContain('批量管理');
    expect(markup).not.toContain('全选终态');
  });

  it('选择模式用已选数量和批量操作替换筛选排序入口', () => {
    const Toolbar = (viewModule as unknown as { AnalysisTaskToolbar?: React.ComponentType<Record<string, unknown>> }).AnalysisTaskToolbar;
    expect(Toolbar).toBeTypeOf('function');
    if (!Toolbar) return;

    const markup = renderToStaticMarkup(createElement(Toolbar, {
      count: 12,
      filter: 'recent',
      counts: { all: 12, pending: 3, active: 1, recent: 8 },
      sort: 'action-priority',
      selectionOpen: true,
      selectedCount: 3,
      allSelectableSelected: false,
      batchBusy: false,
      batchAvailable: true,
      onFilterChange: vi.fn(),
      onSortChange: vi.fn(),
      onEnterSelection: vi.fn(),
      onToggleAll: vi.fn(),
      onDelete: vi.fn(),
      onExitSelection: vi.fn()
    }));

    expect(markup).toContain('已选择 3 项');
    expect(markup).toContain('>全选<');
    expect(markup).toContain('批量删除（3）');
    expect(markup).toContain('>退出<');
    expect(markup).not.toContain('全部任务 12');
    expect(markup).not.toContain('行动优先');
  });

  it('统一列表保留终态结论标题、状态图标和运行任务完整进度', () => {
    const TaskList = (viewModule as unknown as { AnalysisTaskList?: React.ComponentType<Record<string, unknown>> }).AnalysisTaskList;
    expect(TaskList).toBeTypeOf('function');
    if (!TaskList) return;

    const markup = renderToStaticMarkup(createElement(TaskList, {
      packages: [
        { id: 'running', displayName: 'running.tgz', sourcePath: 'D:/running.tgz', detectedAt: '2026-08-28T10:00:00Z', status: 'running' },
        { id: 'ready', displayName: 'ready.tgz', sourcePath: 'D:/ready.tgz', detectedAt: '2026-08-28T09:00:00Z', lastAnalysisAt: '2026-08-28T11:00:00Z', status: 'report-ready' },
        { id: 'failed', displayName: 'failed.tgz', sourcePath: 'D:/failed.tgz', detectedAt: '2026-08-28T08:00:00Z', lastAnalysisAt: '2026-08-28T10:30:00Z', status: 'failed' }
      ],
      tasks: [
        { id: 'task-running', packageId: 'running', status: 'running', createdAt: '2026-08-28T10:00:00Z', startedAt: '2026-08-28T10:00:01Z', progress: 35, stage: 'analyze-storage', message: '正在分析存储状态' },
        { id: 'task-failed', packageId: 'failed', status: 'failed', createdAt: '2026-08-28T10:20:00Z', progress: 20, stage: 'parse-system-events', message: '诊断包无法解压', errorMessage: '诊断包损坏，无法完成解压。' }
      ],
      now: Date.parse('2026-08-28T10:00:10Z'),
      resultByPackageId: new Map([['ready', { diagnoses: [{ title: '硬盘掉盘且阵列降级', severity: 'critical' }] }]]),
      highlightedRef: createRef(),
      onAnalyze: async () => undefined,
      onOpenResult: async () => undefined,
      onChanged: async () => undefined,
      onError: vi.fn()
    }));

    expect(markup).toContain('硬盘掉盘且阵列降级');
    expect(markup).toContain('ready.tgz');
    expect(markup).toContain('分析失败');
    expect(markup).toContain('诊断包损坏，无法完成解压。');
    expect(markup).toContain('failed.tgz');
    expect(markup).toContain('aria-label="严重诊断或分析失败"');
    expect(markup).toContain('aria-label="running.tgz分析进度"');
    expect(markup).toContain('value="35"');
    expect(markup).toContain('识别诊断包');
    expect(markup).toContain('解析系统事件');
    expect(markup).toContain('分析存储状态');
    expect(markup).toContain('聚合异常');
    expect(markup).toContain('形成诊断结论');
  });

  it('筛选菜单支持方向键、Enter、Escape，并在关闭后恢复触发器焦点', async () => {
    const Toolbar = (viewModule as unknown as { AnalysisTaskToolbar?: React.ComponentType<Record<string, unknown>> }).AnalysisTaskToolbar;
    expect(Toolbar).toBeTypeOf('function');
    if (!Toolbar) return;

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onFilterChange = vi.fn();
    const props = {
      count: 12,
      filter: 'all',
      counts: { all: 12, pending: 3, active: 1, recent: 8 },
      sort: 'action-priority',
      selectionOpen: false,
      selectedCount: 0,
      allSelectableSelected: false,
      batchBusy: false,
      batchAvailable: true,
      onFilterChange,
      onSortChange: vi.fn(),
      onEnterSelection: vi.fn(),
      onToggleAll: vi.fn(),
      onDelete: vi.fn(),
      onExitSelection: vi.fn()
    };

    await act(async () => { root.render(createElement(Toolbar, props)); });
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="筛选分析任务"]')!;
    await act(async () => { trigger.click(); });
    expect(document.activeElement?.textContent).toContain('全部任务');

    const menu = container.querySelector<HTMLElement>('[role="menu"]')!;
    await act(async () => { menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
    expect(document.activeElement?.textContent).toContain('待分析');

    await act(async () => { document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(onFilterChange).toHaveBeenCalledWith('pending');
    expect(document.activeElement).toBe(trigger);

    await act(async () => { trigger.click(); });
    await act(async () => { container.querySelector<HTMLElement>('[role="menu"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    await act(async () => { root.unmount(); });
    container.remove();
  });

  it('进入批量管理后扩展状态区域，并且只为终态任务显示复选框', async () => {
    const TaskList = (viewModule as unknown as { AnalysisTaskList?: React.ComponentType<Record<string, unknown>> }).AnalysisTaskList;
    expect(TaskList).toBeTypeOf('function');
    if (!TaskList) return;

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(TaskList, {
        packages: [
          { id: 'ready', displayName: 'ready.tgz', sourcePath: 'D:/ready.tgz', detectedAt: '2026-08-28T09:00:00Z', lastAnalysisAt: '2026-08-28T11:00:00Z', status: 'report-ready' },
          { id: 'pending', displayName: 'pending.tgz', sourcePath: 'D:/pending.tgz', detectedAt: '2026-08-28T10:00:00Z', status: 'pending' }
        ],
        tasks: [],
        now: Date.parse('2026-08-28T12:00:00Z'),
        resultByPackageId: new Map([['ready', { diagnoses: [] }]]),
        highlightedRef: createRef(),
        onAnalyze: async () => undefined,
        onOpenResult: async () => undefined,
        onChanged: async () => undefined,
        onError: vi.fn()
      }));
    });

    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === '批量管理')!.click();
    });
    expect(container.querySelector('.workspace-list')?.classList).toContain('is-selection-mode');
    expect(container.querySelectorAll('.package-selection')).toHaveLength(1);
    expect(container.querySelector('.package-selection')?.getAttribute('aria-label')).toBe('选择删除ready.tgz');

    await act(async () => { root.unmount(); });
    container.remove();
  });
});
