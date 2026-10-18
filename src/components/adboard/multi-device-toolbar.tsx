"use client";

import { useState } from "react";
import { CheckCheck, RotateCw, Users, X } from "lucide-react";
import { devicesClient } from "@/lib/api/client";
import { useLibrary } from "@/lib/desk/store";
import type { ControlMode, Device } from "@/lib/devices/types";

/**
 * Multi-device toolbar under the control modes:
 * - Select all / Clear tick every online phone (Multi) or none.
 * - Groups apply a saved device group (Automate → Groups) as the Multi set.
 * - Reconnect restarts the video session on the targets; offline ticked
 *   phones get `adb reconnect` instead. Offline phones are never sent input.
 */
export function MultiDeviceToolbar({
  devices,
  selectedIds,
  controlMode,
  targets,
  onSelectAll,
  onClear,
  onSelectGroup,
}: {
  devices: Device[];
  selectedIds: Set<string>;
  controlMode: ControlMode;
  /** Current control targets (online). */
  targets: Device[];
  onSelectAll: () => void;
  onClear: () => void;
  onSelectGroup: (deviceIds: string[]) => void;
}) {
  const library = useLibrary();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const online = devices.filter((d) => d.status === "online");
  const allTicked = online.length > 0 && online.every((d) => selectedIds.has(d.id)) && controlMode === "multi";
  // Ticked phones that dropped off: try to bring their ADB link back.
  const offlineTicked = devices.filter((d) => selectedIds.has(d.id) && d.status !== "online");

  async function reconnect() {
    setBusy(true);
    setNote(null);
    try {
      const results = [];
      if (targets.length > 0) results.push(...(await devicesClient.runCommand(targets, "reconnect")).results);
      if (offlineTicked.length > 0) results.push(...(await devicesClient.runCommand(offlineTicked, "restartAdb")).results);
      if (results.length === 0) {
        setNote("No phone to reconnect");
      } else {
        const failed = results.filter((r) => !r.ok);
        setNote(
          failed.length === 0
            ? `Reconnected ${results.length} phone${results.length === 1 ? "" : "s"}`
            : failed.map((r) => `${r.deviceName}: ${r.error || "failed"}`).join(" · "),
        );
      }
    } catch (error) {
      setNote(error instanceof Error ? error.message : "Reconnect failed");
    } finally {
      setBusy(false);
    }
  }

  const reconnectCount = targets.length + offlineTicked.length;

  return (
    <section data-multi-device-toolbar className="flex flex-col gap-2" aria-label="Multi-device">
      <div className="grid grid-cols-2 gap-1.5">
        <button
          type="button"
          className="pc-toggle pc-toggle-md"
          aria-pressed={allTicked}
          disabled={online.length === 0}
          onClick={onSelectAll}
          data-select-all
        >
          <CheckCheck className="size-4" />
          Select all
        </button>
        <button
          type="button"
          className="pc-toggle pc-toggle-md"
          disabled={selectedIds.size === 0 && controlMode === "selected"}
          onClick={onClear}
          data-select-clear
        >
          <X className="size-4" />
          Clear
        </button>
        <button
          type="button"
          className="pc-toggle pc-toggle-md col-span-2"
          disabled={busy || reconnectCount === 0}
          onClick={() => void reconnect()}
          data-reconnect-targets
          title="Restart the live screen on the target phones; offline ticked phones get adb reconnect"
        >
          <RotateCw className={busy ? "size-4 animate-spin" : "size-4"} />
          Reconnect {reconnectCount > 0 ? `${reconnectCount} phone${reconnectCount === 1 ? "" : "s"}` : ""}
        </button>
      </div>
      {library.groups.length > 0 && (
        <div className="flex flex-col gap-1" data-device-groups>
          <p className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-[var(--pc-muted)]">
            <Users className="size-3" aria-hidden />
            Group control
          </p>
          <div className="flex flex-wrap gap-1.5">
            {library.groups.map((group) => {
              const ids = group.deviceIds.filter((id) => devices.some((d) => d.id === id));
              const active =
                controlMode === "multi" && ids.length > 0 && ids.length === selectedIds.size && ids.every((id) => selectedIds.has(id));
              return (
                <button
                  key={group.id}
                  type="button"
                  className="pc-toggle pc-toggle-sm"
                  aria-pressed={active}
                  disabled={ids.length === 0}
                  onClick={() => onSelectGroup(group.deviceIds)}
                  data-device-group={group.name}
                  title={`Control ${group.name} (${ids.length} phone${ids.length === 1 ? "" : "s"})`}
                >
                  {group.name}
                  <span className="text-[10px] text-[var(--pc-muted)]">{ids.length}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
      {note && (
        <p role="status" data-multi-note className="font-mono text-[10px] text-[var(--pc-muted)] [overflow-wrap:anywhere]">
          {note}
        </p>
      )}
    </section>
  );
}
