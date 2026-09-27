"use client";

import { toast } from "sonner";
import { ControlHeader } from "@/components/phone-control/control-header";
import { ControlModes } from "@/components/phone-control/control-modes";
import { DeviceGrid } from "@/components/phone-control/device-grid";
import { PhoneScreen } from "@/components/phone-control/phone-screen";
import { StatusBar } from "@/components/phone-control/status-bar";
import { usePhoneControl } from "@/hooks/use-phone-control";

export function PhoneControlApp() {
  const {
    devices,
    loading,
    error,
    onlineCount,
    activeDevice,
    activeId,
    selectedIds,
    controlMode,
    setControlMode,
    keyboardOn,
    setKeyboardOn,
    mouseOn,
    setMouseOn,
    selectDevice,
    broadcastTargets,
    handleScreenTap,
    handleNav,
    lastTap,
    tapLog,
  } = usePhoneControl();

  const onTap = async (point: { x: number; y: number }) => {
    await handleScreenTap(point);
    const names = broadcastTargets.map((d) => d.name).join(", ");
    toast.message("Tap broadcast", {
      description: `${controlMode.toUpperCase()} → ${names || "none"} @ (${point.x.toFixed(3)}, ${point.y.toFixed(3)})`,
    });
  };

  return (
    <div className="pc-shell relative flex h-dvh max-h-dvh flex-col overflow-hidden">
      <div className="pc-atmosphere" aria-hidden />
      <ControlHeader onlineCount={onlineCount} totalCount={devices.length} />

      <main className="relative z-10 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4 lg:flex-row lg:overflow-hidden lg:gap-6 lg:px-6 lg:py-5">
        {loading && (
          <div className="flex flex-1 items-center justify-center font-mono text-sm text-[var(--pc-muted)]">
            Loading mock fleet…
          </div>
        )}

        {error && (
          <div className="flex flex-1 items-center justify-center text-sm text-[var(--pc-warn)]">
            {error}
          </div>
        )}

        {!loading && !error && (
          <>
            <div className="flex min-h-[560px] min-w-0 flex-1 flex-col lg:min-h-0">
              <PhoneScreen
                device={activeDevice}
                keyboardOn={keyboardOn}
                mouseOn={mouseOn}
                onKeyboardChange={setKeyboardOn}
                onMouseChange={setMouseOn}
                onTap={onTap}
                onNav={handleNav}
                lastTap={lastTap}
                broadcastLabel={`${broadcastTargets.length} target${broadcastTargets.length === 1 ? "" : "s"}`}
              />
            </div>

            <aside className="flex w-full shrink-0 flex-col gap-5 pb-2 lg:h-full lg:w-[380px] lg:overflow-y-auto xl:w-[420px]">
              <DeviceGrid
                devices={devices}
                activeId={activeId}
                selectedIds={selectedIds}
                onSelect={selectDevice}
              />
              <ControlModes
                mode={controlMode}
                onChange={setControlMode}
                selectedCount={activeId ? 1 : 0}
                multiCount={selectedIds.size}
                onlineCount={onlineCount}
              />

              {tapLog.length > 0 && (
                <div className="rounded-xl border border-[var(--pc-line)] bg-[var(--pc-panel)]/60 p-3">
                  <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-[var(--pc-muted)]">
                    Event log
                  </p>
                  <ul className="max-h-28 space-y-1 overflow-y-auto font-mono text-[10px] text-[var(--pc-ink)]">
                    {tapLog.map((entry) => (
                      <li key={entry.id} className="truncate opacity-80">
                        {new Date(entry.at).toLocaleTimeString()} · {entry.mode} ·{" "}
                        {entry.targets.map((t) => t.deviceName).join(", ")}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </aside>
          </>
        )}
      </main>

      <StatusBar device={activeDevice} />
    </div>
  );
}
