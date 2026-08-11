// renderer/src/InfoTip.tsx — 通用悬浮说明（Portal 到 body 的 fixed 层）
// 两种用法：<InfoTip text="说明" /> 渲染 ? 图标；<HoverTip text="说明">内容</HoverTip> 包裹任意内容 hover 显示
import { useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

// ? 图标悬浮说明（用于空间紧凑处）
export function InfoTip({ text }: { text: string }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  return (
    <>
      <span
        className="info-dot"
        onMouseEnter={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setPos({ x: r.left + 8, y: r.top - 8 });
        }}
        onMouseLeave={() => setPos(null)}
      >?</span>
      {pos && createPortal(
        <div className="info-pop" style={{ left: pos.x, top: pos.y }}>{text}</div>,
        document.body,
      )}
    </>
  );
}

// 包裹内容整块 hover 显示说明（用于按钮/属性行）
export function HoverTip({ text, children }: { text: string; children: ReactNode }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  return (
    <span
      className="hover-tip"
      onMouseEnter={(e) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        setPos({ x: r.left + Math.min(r.width / 2, 120), y: r.top - 8 });
      }}
      onMouseLeave={() => setPos(null)}
    >
      {children}
      {pos && createPortal(
        <div className="info-pop" style={{ left: pos.x, top: pos.y }}>{text}</div>,
        document.body,
      )}
    </span>
  );
}
