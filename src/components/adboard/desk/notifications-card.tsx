"use client";

import { useEffect, useState } from "react";
import { Send } from "lucide-react";
import { SwitchRow } from "@/components/ui/switch";
import {
  CATEGORY_LABEL,
  NO_AGENT,
  fetchNotifications,
  hasAgent,
  saveNotifications,
  testNotification,
  type EventCategory,
  type NotificationSettings,
  type NotificationUpdate,
  type NotifyLevel,
} from "@/lib/events/client";
import { cn } from "@/lib/utils";

const LEVELS: Array<{ id: NotifyLevel; label: string }> = [
  { id: "off", label: "Off" },
  { id: "info", label: "Everything" },
  { id: "warning", label: "Warnings and errors" },
  { id: "error", label: "Errors only" },
  { id: "critical", label: "Critical only" },
];

/** What each category sends, in words. */
const CATEGORY_HINT: Partial<Record<EventCategory, string>> = {
  device: "Disconnected, back online, waiting for USB approval",
  macro: "Failed (error), finished or stopped (everything)",
  app: "APK installs, uninstalls, app launch failures",
  scrcpy: "Live screen stopped or recovered",
  adb: "ADB failures and restarts",
  system: "ADBoard started, crashed, history problems",
};

const fieldClass =
  "h-11 min-h-11 min-w-0 rounded-xl border border-[var(--pc-line)] bg-[var(--pc-paper)] px-2 text-xs text-[var(--pc-ink)] outline-none focus-visible:border-[var(--pc-accent)]";
const when = (ms?: number) => (ms ? new Date(ms).toLocaleString([], { dateStyle: "short", timeStyle: "short" }) : "never");

/**
 * Discord notifications. The webhook URL goes to ADBoard and stays there:
 * this card only learns whether one is set.
 */
export function NotificationsCard() {
  const [settings, setSettings] = useState<NotificationSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const agent = hasAgent();

  useEffect(() => {
    if (!agent) return;
    let live = true;
    const load = () =>
      fetchNotifications().then(
        (s) => live && setSettings(s),
        (e: unknown) => live && setError(e instanceof Error ? e.message : "ADBoard is not reachable"),
      );
    void load();
    // Delivery status changes as events are sent.
    const timer = setInterval(() => void load(), 15_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [agent]);

  const save = async (update: NotificationUpdate, done?: string) => {
    setBusy(true);
    setNote(null);
    try {
      setSettings(await saveNotifications(update));
      if (done) setNote({ ok: true, text: done });
      return true;
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : "Could not save" });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setBusy(true);
    setNote(null);
    try {
      setNote({ ok: true, text: await testNotification(url.trim() || undefined) });
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : "The test failed" });
    } finally {
      setBusy(false);
      fetchNotifications().then(setSettings, () => {});
    }
  };

  return (
    <section className="flex min-w-0 flex-col gap-2 rounded-xl border border-[var(--pc-line)] bg-[var(--pc-panel)] p-4" data-settings-notifications>
      <h3 className="font-display text-sm font-semibold text-[var(--pc-ink)]">Discord notifications</h3>
      {!agent && <p className="text-xs text-[var(--pc-muted)]">{NO_AGENT}.</p>}
      {agent && !settings && <p className="text-xs text-[var(--pc-muted)]">{error ?? "Loading…"}</p>}
      {settings && (
        <>
          <p className="text-xs text-[var(--pc-muted)]">
            ADBoard posts the events you choose to a Discord channel. In Discord: channel settings → Integrations → Webhooks → New Webhook → Copy Webhook URL.
          </p>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-[var(--pc-muted)]" htmlFor="discord-webhook">
              Webhook URL{" "}
              {settings.webhookSet && (
                <span className="text-[var(--pc-signal)]" data-webhook-set>
                  · set ({settings.webhookHint ?? "hidden"}); paste a new one to replace it
                </span>
              )}
            </label>
            <div className="flex flex-wrap gap-2">
              <input
                id="discord-webhook"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={url}
                placeholder={settings.webhookSet ? "Saved on ADBoard (not shown)" : "https://discord.com/api/webhooks/…"}
                onChange={(e) => setUrl(e.target.value)}
                className={cn(fieldClass, "min-w-48 flex-1 font-mono")}
                data-webhook-input
              />
              <button
                type="button"
                className="pc-toggle pc-toggle-md"
                disabled={busy || !url.trim()}
                onClick={() => void save({ webhookUrl: url.trim() }, "Webhook saved.").then((ok) => ok && setUrl(""))}
                data-webhook-save
              >
                Save
              </button>
              <button
                type="button"
                className="pc-toggle pc-toggle-md gap-1.5"
                disabled={busy || (!url.trim() && !settings.webhookSet)}
                onClick={() => void test()}
                title={url.trim() ? "Send a test to the URL typed here (not saved yet)" : "Send a test to the saved webhook"}
                data-webhook-test
              >
                <Send className="size-3.5" aria-hidden /> {busy ? "Working…" : "Send test"}
              </button>
              {settings.webhookSet && (
                <button type="button" className="pc-toggle pc-toggle-md" disabled={busy} onClick={() => void save({ webhookUrl: "" }, "Webhook removed.")} data-webhook-remove>
                  Remove
                </button>
              )}
            </div>
          </div>
          {note && (
            <p className={cn("text-xs", note.ok ? "text-[var(--pc-signal)]" : "text-[var(--pc-warn)]")} role="status" data-webhook-note>
              {note.text}
            </p>
          )}
          <SwitchRow
            label="Send notifications"
            description={settings.webhookSet ? "Turn off to pause Discord; events are still recorded" : "Add a webhook first"}
            checked={settings.enabled}
            disabled={busy}
            onChange={(e) => void save({ enabled: e.target.checked })}
            data-notifications-enabled
          />
          <div className="flex flex-col gap-1" data-notifications-categories>
            <h4 className="text-xs font-semibold text-[var(--pc-ink)]">What to send</h4>
            {(Object.keys(CATEGORY_HINT) as EventCategory[]).map((category) => (
              <label key={category} className="flex flex-wrap items-center justify-between gap-2 py-1">
                <span className="flex min-w-0 flex-col">
                  <span className="text-sm text-[var(--pc-ink)]">{CATEGORY_LABEL[category]}</span>
                  <span className="text-[11px] text-[var(--pc-muted)]">{CATEGORY_HINT[category]}</span>
                </span>
                <select
                  value={settings.categories[category] ?? "off"}
                  disabled={busy}
                  onChange={(e) => void save({ categories: { [category]: e.target.value as NotifyLevel } })}
                  className={cn(fieldClass, "w-48")}
                  data-notify-level={category}
                >
                  {LEVELS.map((level) => (
                    <option key={level.id} value={level.id}>
                      {level.label}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-xs text-[var(--pc-muted)]">
              Message detail
              <select value={settings.detail} disabled={busy} onChange={(e) => void save({ detail: e.target.value as "brief" | "full" })} className={cn(fieldClass, "w-48")} data-notify-detail>
                <option value="full">Full (reason, run, duration)</option>
                <option value="brief">Brief (title and phone)</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-[var(--pc-muted)]">
              Cooldown
              <select
                value={String(settings.cooldownSecs)}
                disabled={busy}
                onChange={(e) => void save({ cooldownSecs: Number(e.target.value) })}
                className={cn(fieldClass, "w-48")}
                title="The same kind of event for the same phone is sent at most once per cooldown"
                data-notify-cooldown
              >
                {[0, 30, 120, 300, 900, 3600].map((s) => (
                  <option key={s} value={s}>
                    {s === 0 ? "None" : s < 60 ? `${s} s` : `${s / 60} min`} per phone and event
                  </option>
                ))}
                {![0, 30, 120, 300, 900, 3600].includes(settings.cooldownSecs) && <option value={settings.cooldownSecs}>{settings.cooldownSecs} s</option>}
              </select>
            </label>
          </div>
          {settings.webhookSet && (
            <p className="font-mono text-[11px] text-[var(--pc-muted)]" data-notify-status>
              Last delivered {when(settings.status.lastOkAt)} · {settings.status.sent} sent
              {settings.status.failed ? ` · ${settings.status.failed} failed` : ""}
              {settings.status.suppressed ? ` · ${settings.status.suppressed} held back by the cooldown` : ""}
              {settings.status.dropped ? ` · ${settings.status.dropped} dropped` : ""}
              {settings.status.queued ? ` · ${settings.status.queued} waiting` : ""}
              {settings.status.lastError && (settings.status.lastErrorAt ?? 0) > (settings.status.lastOkAt ?? 0) && (
                <span className="block text-[var(--pc-warn)]">
                  Last error ({when(settings.status.lastErrorAt)}): {settings.status.lastError}
                </span>
              )}
            </p>
          )}
        </>
      )}
    </section>
  );
}
