"use client";

import { sameSession } from "@/lib/ui/tile-flags";
import { reuseUnchanged } from "@/lib/devices/fleet";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { devicesClient, isAgentConfigured } from "@/lib/api/client";
import { createBackoff } from "@/lib/api/reconnect-core";
import {
  applyFailure,
  applySnapshot,
  createSnapshotGate,
  initialFleet,
  unreachableMessage,
  isUnconfirmed,
  withFreshness,
  type FleetState,
} from "@/lib/devices/fleet-state";
import { MOCK_DEVICES } from "@/lib/devices/mock-data";
import { isAuthRefusal } from "@/lib/api/http-error";
import type {
  ControlMode,
  Device,
  NavAction,
  NormalizedPoint,
  PointerPhase,
  PointerTool,
  SessionStatus,
  TapBroadcast,
} from "@/lib/devices/types";
import { useStoredFlag, useStoredString } from "@/hooks/use-stored-flag";
import {
  isTypingTarget,
  keyDownInject,
  keyUpInject,
  type KeyInject,
} from "@/lib/scrcpy/keyboard";

const DEVICE_KEY = "adboard-active-device";

function readSavedDevice(): string | null {
  try {
    return localStorage.getItem(DEVICE_KEY);
  } catch {
    return null;
  }
}

function writeSavedDevice(id: string) {
  try {
    localStorage.setItem(DEVICE_KEY, id);
  } catch {
    // private mode
  }
}

function storedMode(value: string | null): ControlMode {
  if (value === "all" || value === "multi" || value === "selected") return value;
  return "selected";
}

function readControlMode(): string | null {
  try {
    return localStorage.getItem("adboard-control-mode");
  } catch {
    return null;
  }
}

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

export interface ADBoardOptions {
  /**
   * Whether typing on this computer goes to the phones right now. Pass false on
   * screens without a phone (Manage, Settings, …) so Tab, Enter and letters stay
   * in the page. Default true.
   */
  keyboardScope?: boolean;
}

export function useADBoard({ keyboardScope = true }: ADBoardOptions = {}) {
  // Sample phones only in explicit demo mode (no agent configured); a real fleet is never replaced by them.
  const demo = !isAgentConfigured();
  const [fleet, setFleet] = useState<FleetState>(() =>
    initialFleet(demo, demo ? MOCK_DEVICES.map((d) => ({ ...d })) : []),
  );
  const lastOkRef = useRef<number | null>(null);
  const gateRef = useRef(createSnapshotGate());
  // While the agent cannot be reached an online phone is shown as stale, so nothing treats it as ready.
  const devices = useMemo(() => withFreshness(fleet.devices, fleet.connection), [fleet]);
  const [loading, setLoading] = useState(true);
  const [actionError, setError] = useState<string | null>(null);
  const error = unreachableMessage(fleet) ?? actionError;
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [storedControlMode, writeControlMode] = useStoredString("adboard-control-mode");
  const controlMode = storedMode(storedControlMode);
  const setControlMode = useCallback(
    (mode: ControlMode) => writeControlMode(mode),
    [writeControlMode],
  );
  const [keyboardOn, setKeyboardOn] = useStoredFlag("adboard-keyboard", true);
  const [mouseOn, setMouseOn] = useState(true);
  /** Cursor mode: every pointer is sent as a mouse (Android shows a cursor), even from touch. */
  const [cursorMode, setCursorMode] = useStoredFlag("adboard-cursor-mode", false);
  const [lastTap, setLastTap] = useState<TapBroadcast | null>(null);
  const [tapLog, setTapLog] = useState<TapBroadcast[]>([]);
  const [sessions, setSessions] = useState<Map<string, SessionStatus>>(
    () => new Map(),
  );

  const applyFleet = useCallback((next: Device[]) => {
    // Keep the previous objects for phones that did not change, so a fleet
    // update that changed nothing visible does not re-render the whole UI.
    const now = Date.now();
    lastOkRef.current = now;
    setFleet((prev) => {
      const merged = reuseUnchanged(prev.devices, next);
      if (prev.connection === "live" && merged === prev.devices && prev.lastError === null) return prev;
      return applySnapshot(prev, merged, now);
    });
    setActiveId((prev) => {
      if (prev && next.some((d) => d.id === prev)) return prev;
      const saved = readSavedDevice();
      if (saved && next.some((d) => d.id === saved)) return saved;
      return initialActiveId(next);
    });
    setSelectedIds((prev) => {
      const alive = new Set(next.map((device) => device.id));
      const still = [...prev].filter((id) => alive.has(id));
      if (still.length > 0) {
        if (still.length === prev.size) return prev;
        return new Set(still);
      }
      const saved = readSavedDevice();
      if (saved && alive.has(saved)) return new Set([saved]);
      const id = initialActiveId(next);
      return id ? new Set([id]) : new Set();
    });
  }, []);

  const applySession = useCallback((session: SessionStatus) => {
    setSessions((prev) => {
      // The agent repeats session reports; an identical one changes nothing.
      if (sameSession(prev.get(session.serial), session)) return prev;
      const next = new Map(prev);
      next.set(session.serial, session);
      return next;
    });
  }, []);

  // One place that asks the agent for the list. A response only counts if no newer answer arrived
  // meanwhile; a failure keeps the last known phones and marks them stale until the agent answers.
  const fetchFleet = useCallback(async (): Promise<boolean> => {
    const gate = gateRef.current;
    const token = gate.begin();
    try {
      const list = await devicesClient.listDevices();
      if (gate.accept(token)) applyFleet(list);
      return true;
    } catch (err) {
      const reason = err instanceof Error ? err.message : "request failed";
      if (demo) return false;
      console.error("[adboard] listDevices failed", err);
      setFleet((prev) => applyFailure({ ...prev, lastOkAt: lastOkRef.current ?? prev.lastOkAt }, reason, isAuthRefusal(err)));
      return false;
    }
  }, [applyFleet, demo]);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoading(true);
      const ok = await fetchFleet();
      if (cancelled) return;
      if (ok && devicesClient.listSessions) {
        try {
          const sess = await devicesClient.listSessions();
          if (!cancelled) setSessions(new Map(sess.map((s) => [s.serial, s])));
        } catch {
          // sessions optional
        }
      }
      if (!cancelled) setLoading(false);
    })();

    const unsubscribe = devicesClient.subscribeDevices?.(
      (next) => {
        if (cancelled) return;
        // The agent pushed its list: anything still on its way is older.
        gateRef.current.markPush();
        applyFleet(next);
      },
      (session) => {
        if (!cancelled) applySession(session);
      },
      (up) => {
        // The live socket was lost: confirm over HTTP (it fails, and the phones turn stale, only if
        // the agent really is unreachable). When it opens again the agent sends a fresh list.
        if (!up && !cancelled) void fetchFleet();
      },
    );

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [applyFleet, applySession, fetchFleet]);

  // While the agent is unreachable keep asking, slowly and with jitter, so the page recovers on its own.
  useEffect(() => {
    if (demo || !isUnconfirmed(fleet.connection)) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const backoff = createBackoff({ baseMs: 1000, maxMs: 10000 });
    const tick = async () => {
      if (stop) return;
      const ok = await fetchFleet();
      if (!stop && !ok) timer = setTimeout(tick, backoff.next());
    };
    timer = setTimeout(tick, backoff.next());
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
    };
  }, [demo, fleet.connection, fetchFleet]);

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
    setActiveId(deviceId);
    writeSavedDevice(deviceId);
    if (!(ctrlKey || metaKey || shiftKey)) return;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(deviceId)) next.delete(deviceId);
      else next.add(deviceId);
      return next;
    });
    if (storedMode(readControlMode()) === "selected") setControlMode("multi");
  }, [setControlMode]);

  const toggleSelected = useCallback((deviceId: string, selected: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (selected) next.add(deviceId);
      else next.delete(deviceId);
      return next;
    });
    if (storedMode(readControlMode()) === "selected") setControlMode("multi");
  }, [setControlMode]);

  /** Tick every online device and control them together (Multi). */
  const selectAll = useCallback(() => {
    setSelectedIds(new Set(controllable(devices).map((d) => d.id)));
    setControlMode("multi");
  }, [devices, setControlMode]);

  /** Untick everything; Multi/All fall back to the focused phone. */
  const clearSelected = useCallback(() => {
    setSelectedIds(new Set());
    if (storedMode(readControlMode()) !== "selected") setControlMode("selected");
  }, [setControlMode]);

  /** Control exactly a saved group's devices (Multi). Unknown ids are ignored. */
  const selectGroup = useCallback(
    (deviceIds: string[]) => {
      const known = new Set(devices.map((d) => d.id));
      setSelectedIds(new Set(deviceIds.filter((id) => known.has(id))));
      setControlMode("multi");
    },
    [devices, setControlMode],
  );

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
    (
      phase: PointerPhase,
      point: NormalizedPoint,
      frameWidth: number,
      frameHeight: number,
      tool: PointerTool = "finger",
      replay = false,
    ) => {
      if ((!mouseOn && !replay) || broadcastTargets.length === 0) return Promise.resolve(null);
      const quiet = phase === "move" || phase === "hover" || phase === "leave";
      const run = async () => {
        try {
          const result = await devicesClient.sendPointer(
            controlMode,
            broadcastTargets,
            phase,
            point,
            frameWidth,
            frameHeight,
            tool,
          );
          const failed = result.targets.find((t) => t.inject === "error");
          if (quiet) {
            if (failed && phase === "move") setLastTap(result);
            return result;
          }
          setLastTap(result);
          setTapLog((prev) => [result, ...prev].slice(0, 12));
          return result;
        } catch (err) {
          console.error("[adboard] sendPointer failed", err);
          if (!quiet) setError(err instanceof Error ? err.message : "Touch failed");
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
        return [...new Set(failed.map((t) => t.detail || `${t.deviceName} failed`))].join(
          " · ",
        );
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
        // A key that no phone accepted must not look like it worked.
        const failedNav = targets.filter((t) => t.inject === "error");
        if (failedNav.length > 0) {
          setError(`${action.toUpperCase()} failed on ${failedNav.map((t) => t.deviceName.split(" · ")[0]).join(", ")}${"injectDetail" in failedNav[0] && failedNav[0].injectDetail ? `: ${failedNav[0].injectDetail}` : ""}`);
        }
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
        console.error("[adboard] sendNav failed", err);
        setError(err instanceof Error ? err.message : "Nav failed");
      }
    },
    [broadcastTargets, controlMode],
  );

  const keyQueue = useRef<Promise<unknown>>(Promise.resolve());
  const targetsRef = useRef(broadcastTargets);
  const modeRef = useRef(controlMode);
  useEffect(() => {
    targetsRef.current = broadcastTargets;
    modeRef.current = controlMode;
  }, [broadcastTargets, controlMode]);

  useEffect(() => {
    if (!keyboardOn || !keyboardScope) return;

    const post = (inject: KeyInject) => {
      const targets = targetsRef.current;
      const mode = modeRef.current;
      if (targets.length === 0) return;
      const run = async () => {
        try {
          const result =
            inject.kind === "text"
              ? await devicesClient.sendText(mode, targets, inject.text)
              : await devicesClient.sendKey(mode, targets, {
                  action: "down",
                  keycode: inject.keycode,
                  repeat: inject.repeat,
                  metastate: inject.metastate,
                });
          const failed = result.results.find((row) => !row.ok);
          if (failed?.error) {
            setError((prev) => (prev === failed.error ? prev : failed.error ?? prev));
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : "Key failed";
          setError((prev) => (prev === message ? prev : message));
        }
      };
      const next = keyQueue.current.then(run, run);
      keyQueue.current = next.then(
        () => undefined,
        () => undefined,
      );
    };

    const onDown = (event: KeyboardEvent) => {
      if (event.isComposing || isTypingTarget(event.target)) return;
      const inject = keyDownInject(event);
      if (!inject) return;
      event.preventDefault();
      post(inject);
    };
    const onUp = (event: KeyboardEvent) => {
      if (event.isComposing || isTypingTarget(event.target)) return;
      const inject = keyUpInject(event);
      if (!inject || inject.kind !== "key") return;
      event.preventDefault();
      const targets = targetsRef.current;
      const mode = modeRef.current;
      if (targets.length === 0) return;
      const run = async () => {
        try {
          const result = await devicesClient.sendKey(mode, targets, {
            action: "up",
            keycode: inject.keycode,
            repeat: 0,
            metastate: inject.metastate,
          });
          const failed = result.results.find((row) => !row.ok);
          if (failed?.error) {
            setError((prev) => (prev === failed.error ? prev : failed.error ?? prev));
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : "Key failed";
          setError((prev) => (prev === message ? prev : message));
        }
      };
      const next = keyQueue.current.then(run, run);
      keyQueue.current = next.then(
        () => undefined,
        () => undefined,
      );
    };

    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
    };
  }, [keyboardOn, keyboardScope]);

  /**
   * Type on the phones the stage controls (the phone app has no hardware keyboard to forward). Resolves to
   * a sentence when nothing was typed, so the caller can show it next to the field; null when it went through.
   */
  const typeOnPhone = useCallback(
    async (input: { text: string } | { keycode: number }): Promise<string | null> => {
      const targets = targetsRef.current;
      if (targets.length === 0) return "No phone is ready to type on.";
      const mode = modeRef.current;
      const run = async (): Promise<string | null> => {
        try {
          let result;
          if ("text" in input) {
            result = await devicesClient.sendText(mode, targets, input.text);
          } else {
            result = await devicesClient.sendKey(mode, targets, { action: "down", keycode: input.keycode, repeat: 0, metastate: 0 });
            await devicesClient.sendKey(mode, targets, { action: "up", keycode: input.keycode, repeat: 0, metastate: 0 });
          }
          const failed = result.results.filter((row) => !row.ok);
          if (failed.length === 0) return null;
          const detail = failed[0]?.error;
          return failed.length === result.results.length
            ? (detail ?? "The phone did not take it.")
            : `${failed.length} of ${result.results.length} phones did not take it${detail ? `: ${detail}` : ""}.`;
        } catch (err) {
          return err instanceof Error ? err.message : "Typing failed.";
        }
      };
      // Same order as keys from a hardware keyboard.
      const next = keyQueue.current.then(run, run);
      keyQueue.current = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
    [],
  );

  return {
    typeOnPhone,
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
    cursorMode,
    setCursorMode,
    selectDevice,
    toggleSelected,
    selectAll,
    clearSelected,
    selectGroup,
    broadcastTargets,
    handlePointer,
    handleNav,
    handleInstall,
    lastTap,
    tapLog,
    sessions,
  };
}
