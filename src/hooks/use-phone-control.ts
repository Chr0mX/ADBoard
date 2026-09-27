"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { devicesClient } from "@/lib/api/client";
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

export function usePhoneControl() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [controlMode, setControlMode] = useState<ControlMode>("all");
  const [keyboardOn, setKeyboardOn] = useState(false);
  const [mouseOn, setMouseOn] = useState(true);
  const [lastTap, setLastTap] = useState<TapBroadcast | null>(null);
  const [tapLog, setTapLog] = useState<TapBroadcast[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const list = await devicesClient.listDevices();
        if (cancelled) return;
        setDevices(list);
        const firstOnline = list.find((d) => d.status === "online");
        if (firstOnline) {
          setActiveId(firstOnline.id);
          setSelectedIds(new Set([firstOnline.id]));
        }
        setError(null);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load devices");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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

    setDevices((current) => {
      const target = current.find((d) => d.id === deviceId);
      if (!target) return current;

      // Switching active never "restarts" sessions — only swaps the panel.
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
      return current;
    });
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
  };
}
