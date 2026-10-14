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
  EDGE_PEEK,
  clampFloatingRect,
  defaultFloatPosition,
  edgePeekRect,
  edgeRevealRect,
  readSafeInsets,
  resolveCollapsedEdge,
  type FloatEdge,
  type FloatingBounds,
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

function currentBounds(): FloatingBounds {
  const vp = viewportSize();
  const insets = readSafeInsets(getComputedStyle(document.documentElement));
  return {
    viewportWidth: vp.width,
    viewportHeight: vp.height,
    insetTop: insets.top,
    insetRight: insets.right,
    insetBottom: insets.bottom,
    insetLeft: insets.left,
    margin: 8,
  };
}

interface PanelPrefs {
  x: number;
  y: number;
  pinned: boolean;
  collapsed: boolean;
  edge: FloatEdge | null;
}

function readPrefs(key: string): PanelPrefs | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PanelPrefs>;
    if (typeof parsed.x !== "number" || typeof parsed.y !== "number") return null;
    const edge = parsed.edge === "left" || parsed.edge === "right" ? parsed.edge : null;
    return {
      x: parsed.x,
      y: parsed.y,
      pinned: parsed.pinned === true,
      collapsed: parsed.collapsed === true,
      edge,
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
  const [edge, setEdge] = useState<FloatEdge | null>(null);
  const [dragging, setDragging] = useState(false);
  const prefsHydrated = useRef(false);
  const edgeRef = useRef<FloatEdge | null>(null);
  const collapsedRef = useRef(false);
  const pinnedRef = useRef(false);
  edgeRef.current = edge;
  collapsedRef.current = collapsed;
  pinnedRef.current = pinned;

  const persist = useCallback(
    (next: PanelPrefs) => {
      writePrefs(storageKey, next);
    },
    [storageKey],
  );

  useLayoutEffect(() => {
    if (prefsHydrated.current) return;
    prefsHydrated.current = true;
    const prefs = readPrefs(storageKey);
    if (prefs?.pinned) setPinned(true);
    if (prefs?.collapsed) setCollapsed(true);
    if (prefs?.edge) setEdge(prefs.edge);
    // Recover panels stuck off-screen from the old wide-panel edge math.
    if (prefs?.edge && prefs.collapsed) {
      const peek = edgePeekRect(prefs.edge, defaultSize.height, currentBounds(), prefs.y);
      writePrefs(storageKey, {
        x: peek.x,
        y: peek.y,
        pinned: prefs.pinned,
        collapsed: true,
        edge: prefs.edge,
      });
      setPos({ x: peek.x, y: peek.y });
    }
  }, [defaultSize.height, storageKey]);

  // Panels always stay fully on-screen, docked edge peeks aside. Letting a
  // collapsed chip hang off the side left only EDGE_PEEK visible: on the right
  // that was the drag grip with the "Stats" label pushed off-screen, on the
  // left the pin button. Docking needs no overhang; resolveCollapsedEdge snaps
  // any chip released within its threshold of either edge.
  const clampToViewport = useCallback(
    (x: number, y: number, width: number, height: number): FloatingRect =>
      clampFloatingRect({ x, y, width, height }, currentBounds()),
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
      const bounds = currentBounds();
      const isCollapsed = stored?.collapsed ?? collapsedRef.current;
      const isPinned = stored?.pinned ?? pinnedRef.current;
      let nextEdge = stored?.edge ?? edgeRef.current;

      // Expanding clears an edge dock — panel returns fully on-screen.
      if (!isCollapsed) nextEdge = null;

      const base =
        prev ??
        (stored ? { x: stored.x, y: stored.y } : null) ??
        (() => {
          const d = defaultFloatPosition(kind, vp.width, vp.height, { width, height }, landscape);
          return { x: d.x, y: d.y };
        })();

      let next: FloatingRect;
      if (isCollapsed && nextEdge) {
        next = edgePeekRect(nextEdge, height, bounds, base.y);
      } else {
        next = clampToViewport(base.x, base.y, width, height);
        nextEdge = null;
      }

      if (edgeRef.current !== nextEdge) setEdge(nextEdge);
      persist({
        x: next.x,
        y: next.y,
        pinned: isPinned,
        collapsed: isCollapsed,
        edge: nextEdge,
      });
      return { x: next.x, y: next.y };
    });
  }, [clampToViewport, defaultSize.height, defaultSize.width, kind, persist, storageKey]);

  useLayoutEffect(() => {
    reclamp();
  }, [reclamp, collapsed, edge]);

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
    // Pulling an edge peek starts a drag back into the screen.
    if (edge) setEdge(null);
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
    if (!node || !pos) return;
    const width = node.offsetWidth || defaultSize.width;
    const height = node.offsetHeight || defaultSize.height;
    const bounds = currentBounds();

    if (collapsed) {
      const snapped = resolveCollapsedEdge(
        { x: pos.x, y: pos.y, width, height },
        bounds,
      );
      setEdge(snapped.edge);
      setPos({ x: snapped.x, y: snapped.y });
      persist({
        x: snapped.x,
        y: snapped.y,
        pinned,
        collapsed: true,
        edge: snapped.edge,
      });
      return;
    }

    const next = clampToViewport(pos.x, pos.y, width, height);
    setEdge(null);
    setPos({ x: next.x, y: next.y });
    persist({ x: next.x, y: next.y, pinned, collapsed: false, edge: null });
  };

  const togglePinned = () => {
    setPinned((value) => {
      const next = !value;
      if (pos) {
        persist({
          x: pos.x,
          y: pos.y,
          pinned: next,
          collapsed,
          edge: collapsed ? edge : null,
        });
      }
      return next;
    });
  };

  const toggleCollapsed = () => {
    setCollapsed((value) => {
      const next = !value;
      if (!next) {
        setEdge(null);
        // Bring fully on-screen when expanding from an edge dock.
        const node = panelRef.current;
        if (node && pos) {
          const fully = clampToViewport(
            pos.x,
            pos.y,
            node.offsetWidth || defaultSize.width,
            node.offsetHeight || defaultSize.height,
          );
          setPos({ x: fully.x, y: fully.y });
          persist({
            x: fully.x,
            y: fully.y,
            pinned,
            collapsed: false,
            edge: null,
          });
        }
        return false;
      }
      if (pos) persist({ x: pos.x, y: pos.y, pinned, collapsed: true, edge });
      return true;
    });
  };

  const revealFromEdge = () => {
    const node = panelRef.current;
    const width = node?.offsetWidth || defaultSize.width;
    const height = node?.offsetHeight || defaultSize.height;
    const bounds = currentBounds();
    // Width here is still the peek strip; reclamp re-fits with the real width
    // after the panel renders, keeping it on the side it was docked to.
    const fully = edgeRevealRect(edge, { width, height }, bounds, pos?.y ?? bounds.margin ?? 8);
    setEdge(null);
    setPos({ x: fully.x, y: fully.y });
    persist({
      x: fully.x,
      y: fully.y,
      pinned,
      collapsed: true,
      edge: null,
    });
  };

  const peekDragRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  const onPeekPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (pinned) return;
    event.preventDefault();
    peekDragRef.current = { x: event.clientX, y: event.clientY, moved: false };
  };

  const onPeekPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const start = peekDragRef.current;
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.hypot(dx, dy) > 10) start.moved = true;
    const towardCenter =
      (edge === "left" && dx > 18) || (edge === "right" && dx < -18);
    if (start.moved && towardCenter) revealFromEdge();
  };

  const onPeekPointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const start = peekDragRef.current;
    peekDragRef.current = null;
    if (!start || start.moved) return;
    event.preventDefault();
    revealFromEdge();
  };

  const vp = typeof window !== "undefined" ? viewportSize() : { offsetLeft: 0, offsetTop: 0 };
  const label = title ?? PANEL_LABEL[kind];
  const edgeHidden = collapsed && edge != null && !dragging;

  return (
    <div
      ref={panelRef}
      data-floating-panel={kind}
      data-dragging={dragging ? "1" : "0"}
      data-pinned={pinned ? "1" : "0"}
      data-collapsed={collapsed ? "1" : "0"}
      data-edge={edge ?? ""}
      className={cn(
        "pointer-events-auto absolute touch-none select-none rounded-2xl border border-[var(--pc-line)] bg-[var(--pc-panel)]/90 shadow-lg backdrop-blur-md transition-[border-radius] duration-150",
        dragging && "cursor-grabbing",
        pinned && "border-[var(--pc-accent)]/50",
        edgeHidden && "rounded-none shadow-md",
        edgeHidden && edge === "left" && "rounded-r-2xl border-l-0",
        edgeHidden && edge === "right" && "rounded-l-2xl border-r-0",
        className,
      )}
      style={{
        left: (pos?.x ?? 0) + (typeof window !== "undefined" ? vp.offsetLeft : 0),
        top: (pos?.y ?? 0) + (typeof window !== "undefined" ? vp.offsetTop : 0),
        visibility: pos ? "visible" : "hidden",
        zIndex: edgeHidden ? 25 : 20,
        // Override panel min-width utilities (e.g. Stats min-w-[10rem]) so the
        // peek strip is truly EDGE_PEEK wide — otherwise a right dock centers
        // the label in the off-screen portion of a wide panel.
        width: edgeHidden ? EDGE_PEEK : undefined,
        minWidth: edgeHidden ? EDGE_PEEK : undefined,
        maxWidth: edgeHidden ? EDGE_PEEK : undefined,
        // Tall enough for a rotated 5-letter label inside EDGE_PEEK.
        height: edgeHidden ? Math.max(EDGE_PEEK * 2.5, 110) : undefined,
        overflow: edgeHidden ? "hidden" : undefined,
      }}
    >
      {edgeHidden ? (
        <button
          type="button"
          data-float-edge-peek
          aria-label={`Show ${label}. Tap or swipe toward the screen.`}
          className="flex h-full w-full touch-auto items-center justify-center overflow-hidden bg-[var(--pc-accent-fill)] text-white active:brightness-110"
          onPointerDown={onPeekPointerDown}
          onPointerMove={onPeekPointerMove}
          onPointerUp={onPeekPointerUp}
          onPointerCancel={() => {
            peekDragRef.current = null;
          }}
        >
          {/*
            Stack letters (no writing-mode / rotate): Safari/iOS has painted
            vertical-lr and rotated flex labels at zero size inside a clipped
            EDGE_PEEK strip, which left the Stats word blank.
          */}
          <span
            data-float-edge-label
            aria-hidden
            className="pointer-events-none flex flex-col items-center justify-center gap-0.5 font-mono text-[11px] font-semibold leading-none tracking-wide text-white"
          >
            {Array.from(label).map((ch, i) => (
              <span key={`${ch}-${i}`}>{ch}</span>
            ))}
          </span>
        </button>
      ) : (
        <>
          <div className="flex items-center gap-1 px-1 pt-1">
            <div
              data-float-handle
              role="separator"
              aria-label={
                pinned
                  ? "Panel pinned"
                  : collapsed
                    ? "Drag to screen edge to hide"
                    : "Drag panel"
              }
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
                <span className="ml-2 shrink-0 whitespace-nowrap font-mono text-[11px] text-[var(--pc-muted)]">
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
        </>
      )}
    </div>
  );
}
