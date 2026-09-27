"use client";

import { useCallback, useMemo, useState } from "react";
import { devicesClient } from "@/lib/api/client";
import { MOCK_DEVICES } from "@/lib/devices/mock-data";
import type {
  ControlMode,
  Device,
  NavAction,
  NormalizedPoint,
  TapBroadcast,
} from "@/lib/devices/types";

export type SelectionEvent = {
  deviceId: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
};

function controllable(devices: Device[]): Device[] {
  return devices.filter((d) => d.status === "online");
}

function initialActiveId(devices: Device[]): string | null {
  return devices.find((d) => d.status === "online")?.id ?? null;
}

export function usePhoneControl() {
  const [devices] = useState<Device[]>(() => MOCK_DEVICES.map((d) => ({ ...d })));
  const [error] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(() =>
    initialActiveId(MOCK_DEVICES),
  );
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => {
    const id = initialActiveId(MOCK_DEVICES);
    return id ? new Set([id]) : new Set();
  });
  const [controlMode, setControlMode] = useState<ControlMode>("all");
  const [keyboardOn, setKeyboardOn] = useState(false);
  const [mouseOn, setMouseOn] = useState(true);
  const [lastTap, setLastTap] = useState<TapBroadcast | null>(null);
  const [tapLog, setTapLog] = useState<TapBroadcast[]>([]);

  const onlineCount = useMemo(
    () => devices.filter((d) => d.status === "online").length,
    [devices],
  );

  const activeDevice = useMemo(
    () => devices.find((d) => d.id === activeId) ?? null,
    [devices, activeId],
  );

  const selectDevice = useCallback((event: SelectionEvent) => {
    const { deviceId, ctrlKey, shiftKey, metaKey } = event;
    const multi = ctrlKey || metaKey || shiftKey;

    setActiveId(deviceId);

    if (multi) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(deviceId)) {
          if (next.size > 1) next.delete(deviceId);
        } else {
          next.add(deviceId);
        }
        return next;
      });
      setControlMode((mode) => (mode === "selected" ? "multi" : mode));
    } else {
      setSelectedIds(new Set([deviceId]));
      setControlMode((mode) => (mode === "multi" ? "selected" : mode));
    }
  }, []);

  const broadcastTargets = useMemo(() => {
    const online = controllable(devices);
    switch (controlMode) {
      case "all":
        return online;
      case "multi":
        return online.filter((d) => selectedIds.has(d.id));
      case "selected":
      default: {
        const active = online.find((d) => d.id === activeId);
        return active ? [active] : [];
      }
    }
  }, [devices, controlMode, selectedIds, activeId]);

  const handleScreenTap = useCallback(
    async (point: NormalizedPoint) => {
      if (!mouseOn || broadcastTargets.length === 0) return;
      const result = await devicesClient.sendTap(
        controlMode,
        broadcastTargets,
        point,
      );
      setLastTap(result);
      setTapLog((prev) => [result, ...prev].slice(0, 12));
    },
    [mouseOn, broadcastTargets, controlMode],
  );

  const handleNav = useCallback(
    async (action: NavAction["type"]) => {
      if (broadcastTargets.length === 0) return;
      await devicesClient.sendNav(controlMode, broadcastTargets, { type: action });
      setTapLog((prev) =>
        [
          {
            id: `nav-${Date.now()}`,
            at: Date.now(),
            normalized: { x: 0.5, y: 0.5 },
            mode: controlMode,
            targets: broadcastTargets.map((d) => ({
              deviceId: d.id,
              deviceName: `${d.name} · ${action.toUpperCase()}`,
              x: 0,
              y: 0,
              width: d.resolution.width,
              height: d.resolution.height,
            })),
          },
          ...prev,
        ].slice(0, 12),
      );
    },
    [broadcastTargets, controlMode],
  );

  return {
    devices,
    loading: false,
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
  };
}
