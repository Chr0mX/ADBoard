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
import { ChevronDown, ChevronUp, Pin } from "lucide-react";
import {
  clampFloatingRect,
  defaultFloatPosition,
  readSafeInsets,
  type FloatingRect,
} from "@/lib/ui/floating-clamp";
import { cn } from "@/lib/utils";

const PANEL_LABEL: Record<"stats" | "controls" | "nav", string> = {
  stats: "Stats",
  controls: "Tools",
  nav: "Nav",
};

function viewportSize() {
  const vv = window.visualViewport;
  return {
    width: Math.round(vv?.width ?? window.innerWidth),
    height: Math.round(vv?.height ?? window.innerHeight),
    offsetLeft: Math.round(vv?.offsetLeft ?? 0),
    offsetTop: Math.round(vv?.offsetTop ?? 0),
  };
}

interface PanelPrefs {
  x: number;
  y: number;
  pinned: boolean;
  collapsed: boolean;
}

function readPrefs(key: string): PanelPrefs | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PanelPrefs>;
    if (typeof parsed.x !== "number" || typeof parsed.y !== "number") return null;
    return {
      x: parsed.x,
      y: parsed.y,
      pinned: parsed.pinned === true,
      collapsed: parsed.collapsed === true,
    };
  } catch {
    return null;
  }
}

function writePrefs(key: string, prefs: PanelPrefs) {
  try {
    sessionStorage.setItem(key, JSON.stringify(prefs));
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
  /** Optional title shown when collapsed. */
  title?: string;
}

export function FloatingPanel({
  storageKey,
  kind,
  className,
  children,
  defaultSize = { width: 200, height: 56 },
  title,
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
  const [pinned, setPinned] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const prefsHydrated = useRef(false);

  useLayoutEffect(() => {
    if (prefsHydrated.current) return;
    prefsHydrated.current = true;
    const prefs = readPrefs(storageKey);
    if (prefs?.pinned) setPinned(true);
    if (prefs?.collapsed) setCollapsed(true);
  }, [storageKey]);

  const persist = useCallback(
    (next: { x: number; y: number; pinned: boolean; collapsed: boolean }) => {
      writePrefs(storageKey, next);
    },
    [storageKey],
  );

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
      const stored = readPrefs(storageKey);
      const base =
        prev ??
        (stored ? { x: stored.x, y: stored.y } : null) ??
        (() => {
          const d = defaultFloatPosition(kind, vp.width, vp.height, { width, height }, landscape);
          return { x: d.x, y: d.y };
        })();
      const next = clampToViewport(base.x, base.y, width, height);
      persist({
        x: next.x,
        y: next.y,
        pinned: stored?.pinned ?? pinned,
        collapsed: stored?.collapsed ?? collapsed,
      });
      return { x: next.x, y: next.y };
    });
  }, [
    clampToViewport,
    collapsed,
    defaultSize.height,
    defaultSize.width,
    kind,
    persist,
    pinned,
    storageKey,
  ]);

  useLayoutEffect(() => {
    reclamp();
  }, [reclamp, collapsed]);

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
    if (pinned) return;
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
    if (pinned) return;
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
      persist({ x: next.x, y: next.y, pinned, collapsed });
    }
  };

  const togglePinned = () => {
    setPinned((value) => {
      const next = !value;
      if (pos) persist({ x: pos.x, y: pos.y, pinned: next, collapsed });
      return next;
    });
  };

  const toggleCollapsed = () => {
    setCollapsed((value) => {
      const next = !value;
      if (pos) persist({ x: pos.x, y: pos.y, pinned, collapsed: next });
      return next;
    });
  };

  const vp = typeof window !== "undefined" ? viewportSize() : { offsetLeft: 0, offsetTop: 0 };
  const label = title ?? PANEL_LABEL[kind];

  return (
    <div
      ref={panelRef}
      data-floating-panel={kind}
      data-dragging={dragging ? "1" : "0"}
      data-pinned={pinned ? "1" : "0"}
      data-collapsed={collapsed ? "1" : "0"}
      className={cn(
        "pointer-events-auto absolute touch-none select-none rounded-2xl border border-[var(--pc-line)] bg-[var(--pc-panel)]/90 shadow-lg backdrop-blur-md",
        dragging && "cursor-grabbing",
        pinned && "border-[var(--pc-accent)]/50",
        className,
      )}
      style={{
        left: (pos?.x ?? 0) + (typeof window !== "undefined" ? vp.offsetLeft : 0),
        top: (pos?.y ?? 0) + (typeof window !== "undefined" ? vp.offsetTop : 0),
        visibility: pos ? "visible" : "hidden",
        zIndex: 20,
      }}
    >
      <div className="flex items-center gap-1 px-1 pt-1">
        <div
          data-float-handle
          role="separator"
          aria-label={pinned ? "Panel pinned" : "Drag panel"}
          aria-disabled={pinned || undefined}
          className={cn(
            "flex h-11 min-h-11 min-w-0 flex-1 items-center justify-center rounded-xl",
            pinned ? "cursor-default opacity-60" : "cursor-grab active:cursor-grabbing",
          )}
          onPointerDown={onHandlePointerDown}
          onPointerMove={onHandlePointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <span className="h-1 w-8 rounded-full bg-[var(--pc-line)]" aria-hidden />
          {collapsed && (
            <span className="ml-2 truncate font-mono text-[11px] text-[var(--pc-muted)]">
              {label}
            </span>
          )}
        </div>
        <button
          type="button"
          data-float-collapse
          aria-label={collapsed ? `Expand ${label}` : `Collapse ${label}`}
          aria-pressed={collapsed}
          className="inline-flex h-11 min-h-11 w-11 min-w-11 touch-auto items-center justify-center rounded-xl text-[var(--pc-ink)] active:bg-[var(--pc-accent-soft)] aria-pressed:text-[var(--pc-accent)]"
          onClick={toggleCollapsed}
        >
          {collapsed ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
        </button>
        <button
          type="button"
          data-float-pin
          aria-label={pinned ? `Unpin ${label}` : `Pin ${label}`}
          aria-pressed={pinned}
          className={cn(
            "inline-flex h-11 min-h-11 w-11 min-w-11 touch-auto items-center justify-center rounded-xl text-[var(--pc-ink)] active:bg-[var(--pc-accent-soft)]",
            pinned && "text-[var(--pc-accent)]",
          )}
          onClick={togglePinned}
        >
          <Pin className={cn("size-4", pinned && "fill-current")} />
        </button>
      </div>
      {!collapsed && <div className="touch-auto px-2 pb-2">{children}</div>}
    </div>
  );
}
