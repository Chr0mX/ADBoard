"use client";

import { useCallback, useEffect, useState } from "react";
import { devicesClient } from "@/lib/api/client";
import type { Device } from "@/lib/devices/types";
import { Switch } from "@/components/ui/switch";
import { parseTweaks, TWEAKS, type PhoneTweaks, type TweakName } from "@/lib/devices/app-controls";

interface PhoneState {
  tweaks: PhoneTweaks | null;
  shizuku: string;
  error?: string;
}

const smallButton = "h-9 rounded-lg border border-[var(--pc-line)] px-3 text-xs disabled:opacity-50";

/** Tweaks and Shizuku status of each phone, read in two calls. */
async function readStatus(phones: Device[]): Promise<Record<string, PhoneState>> {
  if (phones.length === 0) return {};
  const [tweaks, shizuku] = await Promise.all([
    devicesClient.runCommand(phones, "tweak", undefined, "status"),
    devicesClient.runCommand(phones, "shizuku", "status"),
  ]);
  const out: Record<string, PhoneState> = {};
  for (const phone of phones) {
    const t = tweaks.results.find((r) => r.deviceId === phone.id);
    const s = shizuku.results.find((r) => r.deviceId === phone.id);
    out[phone.id] = {
      tweaks: t?.ok ? parseTweaks(t.output) : null,
      shizuku: s?.ok ? s.output || "" : s?.error || "unknown",
      error: t?.ok ? undefined : t?.error,
    };
  }
  return out;
}

/**
 * Device management → Tweaks: phone-wide settings as one switch per phone,
 * and Shizuku status / start. Each switch reads back what the phone took.
 */
export function PhoneTweaksPanel({ devices }: { devices: Device[] }) {
  const [state, setState] = useState<Record<string, PhoneState>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const online = devices.filter((d) => d.status === "online");
  const key = online.map((d) => d.id).join(",");

  const read = useCallback(async (phones: Device[]) => {
    const next = await readStatus(phones);
    setState((prev) => ({ ...prev, ...next }));
  }, []);

  useEffect(() => {
    const phones = devices.filter((d) => d.status === "online" && key.split(",").includes(d.id));
    let live = true;
    void readStatus(phones).then((next) => {
      if (live) setState((prev) => ({ ...prev, ...next }));
    });
    return () => {
      live = false;
    };
    // `key` names the online phones; `devices` itself changes on every battery tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  async function setTweak(phone: Device, name: TweakName, on: boolean) {
    setBusy(`${phone.id}:${name}`);
    try {
      const response = await devicesClient.runCommand([phone], "tweak", name, on ? "on" : "off");
      const result = response.results[0];
      setState((prev) => ({
        ...prev,
        [phone.id]: {
          ...(prev[phone.id] ?? { shizuku: "" }),
          tweaks: result?.ok ? parseTweaks(result.output) : prev[phone.id]?.tweaks ?? null,
          error: result?.ok ? undefined : result?.error || "Failed",
        },
      }));
    } finally {
      setBusy(null);
    }
  }

  async function startShizuku(phones: Device[]) {
    setBusy("shizuku");
    try {
      const response = await devicesClient.runCommand(phones, "shizuku", "start");
      setState((prev) => {
        const next = { ...prev };
        for (const result of response.results) {
          next[result.deviceId] = { ...(next[result.deviceId] ?? { tweaks: null }), shizuku: result.ok ? result.output || "" : result.error || "Failed" };
        }
        return next;
      });
    } finally {
      setBusy(null);
    }
  }

  if (online.length === 0) {
    return <p className="text-sm text-[var(--pc-muted)]">Check at least one online phone above.</p>;
  }

  return (
    <div className="flex flex-col gap-3" data-phone-tweaks>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-[var(--pc-muted)]">Phone-wide settings, one switch per phone. Each switch shows what the phone reports.</p>
        <span className="flex gap-2">
          <button type="button" className={smallButton} disabled={busy != null} onClick={() => void read(online)}>
            Refresh
          </button>
          <button type="button" className={smallButton} disabled={busy != null} onClick={() => void startShizuku(online)} data-shizuku-start-all>
            Start Shizuku on all
          </button>
        </span>
      </div>
      <ul className="flex flex-col gap-3">
        {online.map((phone) => {
          const current = state[phone.id];
          const running = current?.shizuku.startsWith("running");
          return (
            <li key={phone.id} className="rounded-xl border border-[var(--pc-line)] bg-[var(--pc-panel)] p-4" data-tweaks-phone={phone.id}>
              <div className="mb-1 flex items-center justify-between gap-2">
                <h3 className="font-display text-sm font-semibold">{phone.name}</h3>
                <span className="flex items-center gap-2 text-xs text-[var(--pc-muted)]" data-shizuku-status={phone.id}>
                  Shizuku: {current ? current.shizuku || "unknown" : "…"}
                  {current && !running && current.shizuku !== "not installed" && (
                    <button type="button" className={smallButton} disabled={busy != null} onClick={() => void startShizuku([phone])} data-shizuku-start={phone.id}>
                      Start
                    </button>
                  )}
                </span>
              </div>
              {TWEAKS.map((tweak) => (
                <label key={tweak.name} className="pc-choice-row -mx-2 justify-between" data-tweak={tweak.name}>
                  <span className="flex min-w-0 flex-col">
                    <span className="text-sm text-[var(--pc-ink)]">{tweak.label}</span>
                    <span className="text-[11px] leading-snug text-[var(--pc-muted)]">{tweak.description}</span>
                  </span>
                  <Switch
                    checked={current?.tweaks?.[tweak.name] ?? false}
                    disabled={!current?.tweaks || busy != null}
                    onChange={(event) => void setTweak(phone, tweak.name, event.target.checked)}
                  />
                </label>
              ))}
              {current?.error && <p className="mt-1 text-xs text-[var(--pc-warn)]">{current.error}</p>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
