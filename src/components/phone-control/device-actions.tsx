"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { devicesClient } from "@/lib/api/client";
import type { Device } from "@/lib/devices/types";
import { ConfirmDialog } from "@/components/phone-control/desk/bits";
import { useDeskOptional } from "@/components/phone-control/desk/desk-context";

/**
 * Device actions shared by the floating Tools panel, the desktop More tools
 * popover and taskbar pins, so each runs the same code: restart (confirmed),
 * device information, quick actions and opening the grid Arrangement.
 * Every action goes to the current control targets through the existing
 * device-command API; offline phones are left out by the agent.
 */

export type QuickOp = "reconnect" | "restartAdb" | "shutdown";

export const QUICK_ACTIONS: Array<{ op: QuickOp; label: string; hint: string; confirm?: boolean }> = [
  { op: "reconnect", label: "Reconnect video", hint: "Restart the live screen session" },
  { op: "restartAdb", label: "Restart ADB link", hint: "adb reconnect for the phone" },
  { op: "shutdown", label: "Power off", hint: "Shut the phone down", confirm: true },
];

/* ------------------------------------------------------------------ */
/* Arrangement: open the grid's Arrangement strip from anywhere.       */
/* ------------------------------------------------------------------ */

export const OPEN_ARRANGEMENT_EVENT = "pc-open-arrangement";
let pendingArrangement = false;

/** Ask the grid to open its Arrangement strip (now, or as soon as it mounts). */
export function requestArrangement() {
  pendingArrangement = true;
  window.dispatchEvent(new Event(OPEN_ARRANGEMENT_EVENT));
}

/** For the grid: true once if an Arrangement request is waiting. */
export function takeArrangementRequest() {
  const waiting = pendingArrangement;
  pendingArrangement = false;
  return waiting;
}

/* ------------------------------------------------------------------ */
/* Minimize: collapse every floating panel to its chip.                */
/* ------------------------------------------------------------------ */

export const MINIMIZE_FLOATS_EVENT = "pc-float-minimize";

export function minimizeFloatingPanels() {
  window.dispatchEvent(new Event(MINIMIZE_FLOATS_EVENT));
}

/* ------------------------------------------------------------------ */

function summarize(results: Array<{ deviceName: string; ok: boolean; output?: string | null; error?: string | null }>) {
  if (results.length === 0) return "No online phone to run on";
  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) return results.length === 1 ? `${results[0].deviceName}: done` : `Done on ${results.length} phones`;
  return failed.map((r) => `${r.deviceName}: ${r.error || "failed"}`).join(" · ");
}

export function useDeviceActions({
  targets,
  activeDevice,
  onShowGrid,
  gridView,
}: {
  /** Online control targets (Selected / Multi / All). */
  targets: Device[];
  activeDevice: Device | null;
  gridView: boolean;
  onShowGrid?: () => void;
}) {
  const desk = useDeskOptional();
  const [confirm, setConfirm] = useState<"reboot" | "shutdown" | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const online = targets.filter((d) => d.status === "online");

  const run = useCallback(
    async (op: "reboot" | QuickOp) => {
      if (online.length === 0) {
        setNote("No online phone to run on");
        return;
      }
      setBusy(true);
      try {
        const response = await devicesClient.runCommand(online, op);
        setNote(summarize(response.results));
      } catch (error) {
        setNote(error instanceof Error ? error.message : "Failed");
      } finally {
        setBusy(false);
        setConfirm(null);
      }
    },
    [online],
  );

  const restart = useCallback(() => {
    if (online.length === 0) {
      setNote("No online phone to restart");
      return;
    }
    setConfirm("reboot");
  }, [online.length]);

  const quick = useCallback(
    (op: QuickOp) => {
      if (op === "shutdown") {
        if (online.length === 0) setNote("No online phone to power off");
        else setConfirm("shutdown");
        return;
      }
      void run(op);
    },
    [online.length, run],
  );

  const rotate = useCallback(() => {
    if (online.length === 0) {
      setNote("No online phone to rotate");
      return;
    }
    void (async () => {
      setBusy(true);
      try {
        const response = await devicesClient.runCommand(online, "rotate");
        setNote(summarize(response.results));
      } catch (error) {
        setNote(error instanceof Error ? error.message : "Rotate failed");
      } finally {
        setBusy(false);
      }
    })();
  }, [online]);

  const openInfo = useCallback(() => {
    const device = activeDevice ?? online[0] ?? null;
    if (!device || !desk) {
      setNote("No phone selected");
      return;
    }
    desk.open("manage", "info", device.id);
  }, [activeDevice, desk, online]);

  const openArrangement = useCallback(() => {
    if (!gridView) onShowGrid?.();
    requestArrangement();
  }, [gridView, onShowGrid]);

  const names = online.map((d) => d.name).join(", ");
  const dialog = confirm ? (
    <ConfirmDialog
      title={confirm === "reboot" ? (online.length > 1 ? `Restart ${online.length} phones?` : "Restart device?") : online.length > 1 ? `Power off ${online.length} phones?` : "Power off device?"}
      body={<p className="[overflow-wrap:anywhere]">{names}</p>}
      confirmLabel={confirm === "reboot" ? "Restart" : "Power off"}
      busy={busy}
      requirePhrase={online.length > 1 ? (confirm === "reboot" ? "restart" : "power off") : undefined}
      onCancel={() => setConfirm(null)}
      onConfirm={() => void run(confirm)}
    />
  ) : null;

  return { restart, quick, rotate, openInfo, openArrangement, busy, note, clearNote: () => setNote(null), dialog, onlineCount: online.length, setNote };
}

/** Quick Actions menu anchored to a button (floating Tools / taskbar). */
export function QuickActionsMenu({
  anchor,
  busy,
  onPick,
  onClose,
}: {
  anchor: HTMLElement | null;
  busy: boolean;
  onPick: (op: QuickOp) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!ref.current?.contains(target) && !anchor?.contains(target)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [anchor, onClose]);

  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const margin = 8;
    const rect = anchor?.getBoundingClientRect();
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    let left = rect ? rect.left + rect.width / 2 - width / 2 : margin;
    let top = rect ? rect.top - height - 6 : margin;
    if (top < margin) top = rect ? rect.bottom + 6 : margin;
    left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
    top = Math.max(margin, Math.min(top, window.innerHeight - height - margin));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.visibility = "visible";
  }, [anchor]);

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label="Quick actions"
      data-quick-actions-menu
      style={{ visibility: "hidden" }}
      className="pc-float-shell fixed z-50 flex w-56 max-w-[calc(100vw-16px)] flex-col gap-1 p-1.5"
    >
      {QUICK_ACTIONS.map((item) => (
        <button
          key={item.op}
          type="button"
          role="menuitem"
          disabled={busy}
          data-quick-action={item.op}
          className="pc-toggle min-h-11 w-full justify-start px-3 py-1.5"
          onClick={() => {
            onPick(item.op);
            onClose();
          }}
        >
          <span className="flex min-w-0 flex-col items-start">
            <span>{item.label}</span>
            <span className="truncate text-[10px] text-[var(--pc-muted)]">{item.hint}</span>
          </span>
        </button>
      ))}
    </div>,
    document.body,
  );
}
