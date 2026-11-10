"use client";

import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

/**
 * The one sheet used by the mobile app (devices, macros, more). Slides up
 * from the bottom, closes with Escape, the backdrop or the close button, and
 * returns focus to whatever opened it.
 */
export function BottomSheet({
  title,
  onClose,
  children,
  full = false,
  dataSheet,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Fill the whole screen instead of rising from the bottom. */
  full?: boolean;
  dataSheet?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      before?.focus?.();
    };
  }, []);

  // Drag the title row down to close (touch or mouse).
  const drag = useRef<{ y: number } | null>(null);
  const onDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;
    drag.current = { y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current || !panel.current) return;
    const dy = Math.max(0, event.clientY - drag.current.y);
    panel.current.style.transform = `translateY(${dy}px)`;
    panel.current.style.transition = "none";
  };
  const onUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current || !panel.current) return;
    const dy = event.clientY - drag.current.y;
    drag.current = null;
    const calm = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    panel.current.style.transition = calm ? "none" : "transform 150ms ease";
    panel.current.style.transform = "";
    if (dy > 90) onClose();
  };

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      className="fixed inset-x-0 z-40 flex flex-col justify-end"
      data-m-sheet={dataSheet ?? title.toLowerCase()}>
      <button type="button" aria-label={`Close ${title}`} tabIndex={-1} className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={`relative flex min-h-0 flex-col gap-3 overflow-y-auto rounded-t-2xl border-t border-[var(--pc-line)] bg-[var(--pc-paper)] px-3 pt-5 pb-[max(0.75rem,env(safe-area-inset-bottom))] outline-none ${
          full ? "h-full rounded-none pt-[max(0.75rem,env(safe-area-inset-top))]" : "max-h-[88%]"
        }`}
      >
        <div
          data-m-sheet-handle
          className="flex shrink-0 touch-none items-center justify-between gap-2"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        >
          <span data-m-sheet-grab aria-hidden />
          <h2 className="font-display text-base font-semibold text-[var(--pc-ink)]">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={`Close ${title}`}
            className="inline-flex size-11 items-center justify-center rounded-xl border border-[var(--pc-line)] text-[var(--pc-ink)]"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
