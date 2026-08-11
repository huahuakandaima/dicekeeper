// renderer/src/drag-guard.ts — 弹窗遮罩"拖选保护"（修复"拖选文字出窗口直接关闭"）
// 现象：在弹窗里拖选文字时 mousedown 在内容区、mouseup 落在遮罩层 → click 目标变成遮罩 → 误触发"点遮罩关闭"
// 方案：mousedown 记录起点到 DOM dataset（跨渲染保留），click 时 mouseup 与 mousedown 距离大 → 视为拖选，不关闭
import type React from 'react';

export const DRAG_GUARD = {
  onMouseDownCapture: (e: React.MouseEvent) => {
    const el = e.currentTarget as HTMLElement;
    el.dataset.dgx = String(e.clientX);
    el.dataset.dgy = String(e.clientY);
  },
  isDrag: (e: React.MouseEvent): boolean => {
    const el = e.currentTarget as HTMLElement;
    const dx = Math.abs(Number(el.dataset.dgx ?? e.clientX) - e.clientX);
    const dy = Math.abs(Number(el.dataset.dgy ?? e.clientY) - e.clientY);
    return dx + dy > 12;
  },
};
