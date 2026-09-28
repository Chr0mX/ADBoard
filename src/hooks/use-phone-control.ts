"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { devicesClient } from "@/lib/api/client";
import { MOCK_DEVICES } from "@/lib/devices/mock-data";
import type {
  ControlMode,
  Device,
  NavAction,
  NormalizedPoint,
  PointerPhase,
  SessionStatus,
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
  const [sessions, setSessions] = useState<Map<string, SessionStatus>>(
    () => new Map(),
  );

  const applyFleet = useCallback((next: Device[]) => {
    setDevices(next);
    setActiveId((prev) => {
      if (prev && next.some((d) => d.id === prev)) return prev;
      return initialActiveId(next);
    });
    setSelectedIds((prev) => {
      const still = [...prev].filter((id) => next.some((d) => d.id === id));
      if (still.length > 0) return new Set(still);
      const id = initialActiveId(next);
      return id ? new Set([id]) : new Set();
    });
  }, []);

  const applySession = useCallback((session: SessionStatus) => {
    setSessions((prev) => {
      const next = new Map(prev);
      next.set(session.serial, session);
      return next;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoading(true);
      try {
        const list = await devicesClient.listDevices();
        if (cancelled) return;
        applyFleet(list);
        setError(null);
        if (devicesClient.listSessions) {
          try {
            const sess = await devicesClient.listSessions();
            if (!cancelled) {
              setSessions(new Map(sess.map((s) => [s.serial, s])));
            }
          } catch {
            // sessions optional
          }
        }
      } catch (err) {
        if (cancelled) return;
        console.error("[phone-control] listDevices failed", err);
        // Keep the desk usable if the agent is down.
        applyFleet(MOCK_DEVICES.map((d) => ({ ...d })));
        setError(
          err instanceof Error
            ? err.message
            : "Failed to reach control agent — showing mock fleet",
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    const unsubscribe = devicesClient.subscribeDevices?.(
      (next) => {
        if (!cancelled) {
          applyFleet(next);
          setError(null);
        }
      },
      (session) => {
        if (!cancelled) applySession(session);
      },
    );

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [applyFleet, applySession]);

  const onlineCount = useMemo(
    () => devices.filter((d) => d.status === "online").length,
    [devices],
  );

  const activeDevice = useMemo(
    () => devices.find((d) => d.id === activeId) ?? null,
    [devices, activeId],
  );

  const activeSession = useMemo(() => {
    if (!activeDevice) return null;
    return sessions.get(activeDevice.serial) ?? null;
  }, [activeDevice, sessions]);

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

  const pointerQueue = useRef<Promise<unknown>>(Promise.resolve());

  const handlePointer = useCallback(
    (phase: PointerPhase, point: NormalizedPoint, frameWidth: number, frameHeight: number) => {
      if (!mouseOn || broadcastTargets.length === 0) return Promise.resolve(null);
      const run = async () => {
        try {
          const result = await devicesClient.sendPointer(
            controlMode,
            broadcastTargets,
            phase,
            point,
            frameWidth,
            frameHeight,
          );
          const failed = result.targets.find((t) => t.inject === "error");
          if (phase === "move") {
            if (failed) setLastTap(result);
            return result;
          }
          setLastTap(result);
          setTapLog((prev) => [result, ...prev].slice(0, 12));
          return result;
        } catch (err) {
          console.error("[phone-control] sendPointer failed", err);
          setError(err instanceof Error ? err.message : "Touch failed");
          return null;
        }
      };
      const next = pointerQueue.current.then(run, run);
      pointerQueue.current = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
    [mouseOn, broadcastTargets, controlMode],
  );

  const handleInstall = useCallback(
    async (file: File) => {
      if (!file.name.toLowerCase().endsWith(".apk")) {
        return "Only .apk files can be installed";
      }
      if (broadcastTargets.length === 0) return "No online targets";
      try {
        const result = await devicesClient.installApk(
          controlMode,
          broadcastTargets,
          file,
        );
        const failed = result.targets.filter((t) => t.inject === "error");
        if (failed.length === 0) {
          const names = result.targets.map((t) => t.deviceName).join(", ");
          return names ? `Installed on ${names}` : "Installed";
        }
        return failed
          .map((t) => t.detail || `${t.deviceName} failed`)
          .join(" · ");
      } catch (err) {
        return err instanceof Error ? err.message : "Install failed";
      }
    },
    [broadcastTargets, controlMode],
  );

  const handleNav = useCallback(
    async (action: NavAction["type"]) => {
      if (broadcastTargets.length === 0) return;
      try {
        const result = await devicesClient.sendNav(controlMode, broadcastTargets, {
          type: action,
        });
        const targets =
          result && "targets" in result && result.targets
            ? result.targets.map((t) => ({
                deviceId: t.deviceId,
                deviceName: `${t.deviceName} · ${action.toUpperCase()}`,
                x: 0,
                y: 0,
                width: 0,
                height: 0,
                inject: t.inject,
                injectDetail: t.detail,
              }))
            : broadcastTargets.map((d) => ({
                deviceId: d.id,
                deviceName: `${d.name} · ${action.toUpperCase()}`,
                x: 0,
                y: 0,
                width: d.resolution.width,
                height: d.resolution.height,
                inject: "stub" as const,
              }));
        setTapLog((prev) =>
          [
            {
              id: result && "id" in result ? result.id : `nav-${Date.now()}`,
              at: result && "at" in result ? result.at : Date.now(),
              normalized: { x: 0.5, y: 0.5 },
              mode: controlMode,
              targets,
            },
            ...prev,
          ].slice(0, 12),
        );
      } catch (err) {
        console.error("[phone-control] sendNav failed", err);
        setError(err instanceof Error ? err.message : "Nav failed");
      }
    },
    [broadcastTargets, controlMode],
  );

  return {
    devices,
    loading,
    error,
    onlineCount,
    activeDevice,
    activeSession,
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
    handlePointer,
    handleNav,
    handleInstall,
    lastTap,
    tapLog,
  };
}
