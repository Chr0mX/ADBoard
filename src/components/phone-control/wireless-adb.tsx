"use client";

import { useEffect, useState } from "react";
import { devicesClient } from "@/lib/api/client";
import { cn } from "@/lib/utils";

const fieldClass =
  "mt-1 h-11 w-full min-w-0 rounded-lg border border-[var(--pc-line)] bg-[var(--pc-panel)] px-2 font-mono text-xs text-[var(--pc-ink)]";

export function WirelessAdb({ initialOpen = false }: { initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  const [address, setAddress] = useState("");
  const [pairingPort, setPairingPort] = useState("");
  const [pairingCode, setPairingCode] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    let cancel = false;
    devicesClient
      .listWireless()
      .then((endpoints) => {
        if (!cancel) setSaved(endpoints);
      })
      .catch(() => {});
    return () => {
      cancel = true;
    };
  }, [open]);

  async function refreshSaved() {
    try {
      setSaved(await devicesClient.listWireless());
    } catch {
      setSaved([]);
    }
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = address.trim();
    if (!trimmed) {
      setFailed(true);
      setNote("Enter the phone's IP address.");
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      const portText = pairingPort.trim();
      const result = await devicesClient.connectWireless({
        address: trimmed,
        pairingPort: portText ? Number(portText) : undefined,
        pairingCode: pairingCode.trim() || undefined,
      });
      setFailed(false);
      setNote(result.message);
      setPairingCode("");
      await refreshSaved();
    } catch (error) {
      setFailed(true);
      setNote(error instanceof Error ? error.message : "Could not add the device");
    } finally {
      setBusy(false);
    }
  }

  async function onRemove(endpoint: string) {
    setBusy(true);
    try {
      const result = await devicesClient.disconnectWireless(endpoint);
      setFailed(false);
      setNote(result.message);
      await refreshSaved();
    } catch (error) {
      setFailed(true);
      setNote(error instanceof Error ? error.message : "Could not remove the device");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-wireless-adb className="flex flex-col gap-2">
      <button
        type="button"
        data-wireless-toggle
        aria-expanded={open}
        className="h-11 rounded-lg border border-[var(--pc-line)] px-3 text-sm text-[var(--pc-ink)]"
        onClick={() => setOpen((value) => !value)}
      >
        Add wireless
      </button>
      {open && (
        <form
          data-wireless-form
          className="flex flex-col gap-2 rounded-lg border border-[var(--pc-line)] bg-[var(--pc-panel)]/40 p-3"
          onSubmit={(event) => void onSubmit(event)}
        >
          <p className="text-xs leading-snug text-[var(--pc-muted)]">
            On the phone, open Developer options and turn on Wireless debugging. Enter the IP
            address and port shown there. For a pairing code, enter the pairing port and the code
            as well.
          </p>
          <label className="text-sm text-[var(--pc-ink)]">
            Address
            <input
              data-wireless-address
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              placeholder="192.168.1.20:5555"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className={fieldClass}
            />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="min-w-0 text-sm text-[var(--pc-ink)]">
              Pairing port
              <input
                data-wireless-pair-port
                inputMode="numeric"
                value={pairingPort}
                onChange={(event) => setPairingPort(event.target.value)}
                placeholder="37123"
                className={fieldClass}
              />
            </label>
            <label className="min-w-0 text-sm text-[var(--pc-ink)]">
              Pairing code
              <input
                data-wireless-pair-code
                inputMode="numeric"
                value={pairingCode}
                onChange={(event) => setPairingCode(event.target.value)}
                placeholder="123456"
                className={fieldClass}
              />
            </label>
          </div>
          <button
            type="submit"
            data-wireless-submit
            disabled={busy}
            className="h-11 rounded-lg bg-[var(--pc-accent-fill)] px-3 text-sm text-white disabled:opacity-50"
          >
            {busy ? "Connecting…" : "Add device"}
          </button>
          {note && (
            <p
              data-wireless-note
              className={cn(
                "font-mono text-[10px] leading-snug",
                failed ? "text-[var(--pc-warn)]" : "text-[var(--pc-muted)]",
              )}
            >
              {note}
            </p>
          )}
          {saved.length > 0 && (
            <ul data-wireless-saved className="flex flex-col gap-1">
              {saved.map((endpoint) => (
                <li key={endpoint} className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate font-mono text-xs text-[var(--pc-ink)]">
                    {endpoint}
                  </span>
                  <button
                    type="button"
                    data-wireless-remove={endpoint}
                    disabled={busy}
                    className="h-9 shrink-0 rounded-lg border border-[var(--pc-line)] px-2 text-xs text-[var(--pc-ink)] disabled:opacity-50"
                    onClick={() => void onRemove(endpoint)}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </form>
      )}
    </div>
  );
}
