"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import {
  desktopShortcutAria,
  desktopShortcutLabel,
  isTypingTarget,
  matchDesktopShortcut,
  type DesktopShortcut,
} from "@/lib/scrcpy/keyboard";

type Handlers = Partial<Record<DesktopShortcut, () => void>>;

/** Alt+Shift desktop shortcuts. Only actions with a handler are claimed. */
export function useDesktopShortcuts(enabled: boolean, handlers: Handlers) {
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.repeat || event.defaultPrevented) return;
      if (isTypingTarget(event.target)) return;
      const action = matchDesktopShortcut(event);
      const run = action ? handlersRef.current[action] : undefined;
      if (!run) return;
      event.preventDefault();
      run();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}

const noopSubscribe = () => () => {};

function isMac() {
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ||
    navigator.platform ||
    "";
  return /mac|iphone|ipad/i.test(platform);
}

/** Tooltip text and aria-keyshortcuts for a control bound to a shortcut. */
export function useShortcutHint() {
  const mac = useSyncExternalStore(noopSubscribe, isMac, () => false);
  return (label: string, action: DesktopShortcut) => ({
    title: `${label} (${desktopShortcutLabel(action, mac)})`,
    "aria-keyshortcuts": desktopShortcutAria(action),
  });
}
