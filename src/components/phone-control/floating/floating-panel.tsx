"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  clampFloatingRect,
  defaultFloatPosition,
  readSafeInsets,
  type FloatingRect,
} from "@/lib/ui/floating-clamp";
import { cn } from "@/lib/utils";

function viewportSize() {
  const vv = window.visualViewport;
  return {
    width: Math.round(vv?.width ?? window.innerWidth),
    height: Math.round(vv?.height ?? window.innerHeight),
    offsetLeft: Math.round(vv?.offsetLeft ?? 0),
    offsetTop: Math.round(vv?.offsetTop ?? 0),
  };
}

function readStored(key: string): { x: number; y: number } | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { x?: unknown; y?: unknown };
    if (typeof parsed.x === "number" && typeof parsed.y === "number") {
      return { x: parsed.x, y: parsed.y };
    }
  } catch {
    // private mode / quota
  }
  return null;
}

function writeStored(key: string, pos: { x: number; y: number }) {
  try {
    sessionStorage.setItem(key, JSON.stringify(pos));
  } catch {
    // private mode
  }
}

export interface FloatingPanelProps {
  storageKey: string;
  kind: "stats" | "controls" | "nav";
  className?: string;
  children: ReactNode;
  /** Compact height hint for default placement before measure. */
  defaultSize?: { width: number; height: number };
}

export function FloatingPanel({
  storageKey,
  kind,
  className,
  children,
  defaultSize = { width: 200, height: 56 },
}: FloatingPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const clampToViewport = useCallback(
    (x: number, y: number, width: number, height: number): FloatingRect => {
      const vp = viewportSize();
      const root = document.documentElement;
      const insets = readSafeInsets(getComputedStyle(root));
      return clampFloatingRect(
        { x, y, width, height },
        {
          viewportWidth: vp.width,
          viewportHeight: vp.height,
          insetTop: insets.top,
          insetRight: insets.right,
          insetBottom: insets.bottom,
          insetLeft: insets.left,
          margin: 8,
        },
      );
    },
    [],
  );

  const reclamp = useCallback(() => {
    const node = panelRef.current;
    if (!node) return;
    const width = node.offsetWidth || defaultSize.width;
    const height = node.offsetHeight || defaultSize.height;
    setPos((prev) => {
      const vp = viewportSize();
      const landscape = vp.width > vp.height;
      const base =
        prev ??
        readStored(storageKey) ??
        (() => {
          const d = defaultFloatPosition(kind, vp.width, vp.height, { width, height }, landscape);
          return { x: d.x, y: d.y };
        })();
      const next = clampToViewport(base.x, base.y, width, height);
      writeStored(storageKey, { x: next.x, y: next.y });
      return { x: next.x, y: next.y };
    });
  }, [clampToViewport, defaultSize.height, defaultSize.width, kind, storageKey]);

  useLayoutEffect(() => {
    reclamp();
  }, [reclamp]);

  useEffect(() => {
    const onOrient = () => reclamp();
    const onResize = () => reclamp();
    window.addEventListener("orientationchange", onOrient);
    window.visualViewport?.addEventListener("resize", onResize);
    window.visualViewport?.addEventListener("scroll", onResize);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("orientationchange", onOrient);
      window.visualViewport?.removeEventListener("resize", onResize);
      window.visualViewport?.removeEventListener("scroll", onResize);
      window.removeEventListener("resize", onResize);
    };
  }, [reclamp]);

  const onHandlePointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    const node = panelRef.current;
    if (!node || pos == null) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: pos.x,
      originY: pos.y,
    };
    setDragging(true);
  };

  const onHandlePointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    const node = panelRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !node) return;
    const width = node.offsetWidth || defaultSize.width;
    const height = node.offsetHeight || defaultSize.height;
    const next = clampToViewport(
      drag.originX + (event.clientX - drag.startX),
      drag.originY + (event.clientY - drag.startY),
      width,
      height,
    );
    setPos({ x: next.x, y: next.y });
  };

  const endDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // already released
    }
    const node = panelRef.current;
    if (node && pos) {
      const next = clampToViewport(pos.x, pos.y, node.offsetWidth, node.offsetHeight);
      setPos({ x: next.x, y: next.y });
      writeStored(storageKey, { x: next.x, y: next.y });
    }
  };

  const vp = typeof window !== "undefined" ? viewportSize() : { offsetLeft: 0, offsetTop: 0 };

  return (
    <div
      ref={panelRef}
      data-floating-panel={kind}
      data-dragging={dragging ? "1" : "0"}
      className={cn(
        "pointer-events-auto absolute touch-none select-none rounded-2xl border border-[var(--pc-line)] bg-[var(--pc-panel)]/90 shadow-lg backdrop-blur-md",
        dragging && "cursor-grabbing",
        className,
      )}
      style={{
        left: (pos?.x ?? 0) + (typeof window !== "undefined" ? vp.offsetLeft : 0),
        top: (pos?.y ?? 0) + (typeof window !== "undefined" ? vp.offsetTop : 0),
        visibility: pos ? "visible" : "hidden",
        zIndex: 20,
      }}
    >
      <div
        data-float-handle
        role="separator"
        aria-label="Drag panel"
        className="flex h-5 cursor-grab items-center justify-center active:cursor-grabbing"
        onPointerDown={onHandlePointerDown}
        onPointerMove={onHandlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <span className="h-1 w-8 rounded-full bg-[var(--pc-line)]" aria-hidden />
      </div>
      <div className="touch-auto px-2 pb-2">{children}</div>
    </div>
  );
}
