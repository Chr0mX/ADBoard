"use client";

import { useEffect, useRef, useState } from "react";
import { devicesClient } from "@/lib/api/client";
import type { Device } from "@/lib/devices/types";
import { ConfirmDialog } from "@/components/phone-control/desk/bits";
import { useDeskOptional } from "@/components/phone-control/desk/desk-context";

const ITEMS = [
  { id: "reconnect", label: "Reconnect", run: true },
  { id: "restartAdb", label: "Restart ADB", run: true },
  { id: "reboot", label: "Reboot", confirm: "Reboot Device?" },
  { id: "shutdown", label: "Shutdown", confirm: "Shut down device?" },
  { id: "screenshot", label: "Screenshot", section: "manage" as const, tool: "screenshot" },
  { id: "record", label: "Record", section: "manage" as const, tool: "record" },
  { id: "install", label: "Install APK", section: "apps" as const, tool: "install" },
  { id: "uninstall", label: "Uninstall APK", section: "apps" as const, tool: "packages" },
  { id: "launch", label: "Launch App", section: "apps" as const, tool: "packages" },
  { id: "forceStop", label: "Force Stop App", section: "apps" as const, tool: "packages" },
  { id: "clearData", label: "Clear App Data", section: "apps" as const, tool: "packages" },
  { id: "shell", label: "Open Shell", section: "developer" as const, tool: "shell" },
  { id: "files", label: "File Manager", section: "files" as const },
  { id: "info", label: "Device Information", section: "manage" as const, tool: "info" },
];

export function DeviceMenu({
  device,
  onClose,
}: {
  device: Device;
  onClose: () => void;
}) {
  const desk = useDeskOptional();
  const ref = useRef<HTMLDivElement>(null);
  const [note, setNote] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"reboot" | "shutdown" | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
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
  }, [onClose]);

  async function run(op: "reconnect" | "restartAdb" | "reboot" | "shutdown") {
    setBusy(true);
    try {
      const response = await devicesClient.runCommand([device], op);
      const result = response.results[0];
      setNote(result?.ok ? result.output || "Done" : result?.error || "Failed");
    } catch (error) {
      setNote(error instanceof Error ? error.message : "Failed");
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }

  return (
    <div
      ref={ref}
      data-device-menu={device.id}
      role="menu"
      className="absolute right-2 top-10 z-20 w-52 rounded-xl border border-[var(--pc-line)] bg-[var(--pc-paper)] p-1 shadow-lg"
    >
      {ITEMS.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          disabled={busy}
          className="flex min-h-11 w-full items-center rounded-lg px-2 text-left text-sm text-[var(--pc-ink)] hover:bg-[var(--pc-accent-soft)]"
          onClick={() => {
            if (item.id === "reboot" || item.id === "shutdown") {
              setConfirm(item.id);
              return;
            }
            if ("run" in item && item.run) {
              void run(item.id as "reconnect" | "restartAdb");
              return;
            }
            if ("section" in item && item.section && desk) {
              desk.open(item.section, "tool" in item ? item.tool : undefined, device.id);
              onClose();
            }
          }}
        >
          {item.label}
        </button>
      ))}
      {note && <p className="px-2 py-1 font-mono text-[10px] text-[var(--pc-muted)]">{note}</p>}
      {confirm && (
        <ConfirmDialog
          title={confirm === "reboot" ? "Reboot Device?" : "Shut down device?"}
          body={<p>{device.name}</p>}
          confirmLabel={confirm === "reboot" ? "Reboot" : "Shutdown"}
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void run(confirm)}
        />
      )}
    </div>
  );
}
