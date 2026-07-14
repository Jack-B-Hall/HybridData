import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface PopoverProps {
  anchorEl: HTMLElement | null;
  onClose: () => void;
  children: React.ReactNode;
  width?: number;
}

const MARGIN = 12;

/**
 * A fixed-position popover portaled to <body>, anchored below (or above, if
 * there's no room) the trigger element, clamped to the viewport, closing on
 * outside click / Escape / scroll-away.
 */
export function Popover({ anchorEl, onClose, children, width = 420 }: PopoverProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({ opacity: 0 });

  useLayoutEffect(() => {
    if (!anchorEl) return;
    const rect = anchorEl.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = rect.left;
    if (left + width + MARGIN > vw) left = Math.max(MARGIN, vw - width - MARGIN);

    const spaceBelow = vh - rect.bottom;
    const openUpward = spaceBelow < 260 && rect.top > 260;
    const top = openUpward ? undefined : rect.bottom + 8;
    const bottom = openUpward ? vh - rect.top + 8 : undefined;

    setStyle({
      position: "fixed",
      left,
      top,
      bottom,
      width,
      maxHeight: Math.max(220, (openUpward ? rect.top : spaceBelow) - MARGIN * 2),
      opacity: 1,
    });
  }, [anchorEl, width]);

  useEffect(() => {
    function handlePointer(e: MouseEvent) {
      if (panelRef.current?.contains(e.target as Node)) return;
      if (anchorEl?.contains(e.target as Node)) return;
      onClose();
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("keydown", handleKey);
    window.addEventListener("scroll", onClose, true);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("keydown", handleKey);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [anchorEl, onClose]);

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      style={style}
      className="z-50 flex animate-pop-in flex-col overflow-hidden rounded-card border border-border bg-canvas-overlay shadow-popover"
    >
      {children}
    </div>,
    document.body,
  );
}
