"use client";

import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { CircleCheckIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import {
  ALERT_TEXT,
  alertDetail,
  diffConnections,
  type ConnectionAlert,
  type SeenMap,
} from "@/lib/devices/connection-alerts-core";
import type { Device } from "@/lib/devices/types";

/** The compact alert (about 300 × 52): icon, title, one-line detail, close. Colours are the theme's. */
function ConnectionAlertCard({ alert, onClose }: { alert: ConnectionAlert; onClose: () => void }) {
  const text = ALERT_TEXT[alert.kind];
  const Icon = alert.kind === "disconnected" ? TriangleAlertIcon : CircleCheckIcon;
  return (
    <div className="pc-alert" data-connection-alert={alert.kind} data-alert-device={alert.id} role="status">
      <Icon className="pc-alert-icon" aria-hidden />
      <div className="pc-alert-content">
        <div className="pc-alert-title">{text.title}</div>
        <div className="pc-alert-message" title={alertDetail(alert)}>
          {alertDetail(alert)}
        </div>
      </div>
      <button type="button" className="pc-alert-close" aria-label="Dismiss" onClick={onClose}>
        <XIcon className="size-4" aria-hidden />
      </button>
    </div>
  );
}

export function showConnectionAlert(alert: ConnectionAlert) {
  // One toast id per phone: a newer alert for the same phone replaces the older one.
  const id = `connection-${alert.id}`;
  toast.custom(() => <ConnectionAlertCard alert={alert} onClose={() => toast.dismiss(id)} />, {
    id,
    duration: alert.kind === "disconnected" ? 8000 : 5000,
    className: "pc-alert-toast",
  });
}

/** Show an alert when a phone loses or regains its ADB connection (changes only). */
export function useConnectionAlerts(devices: ReadonlyArray<Device>) {
  const seen = useRef<SeenMap | null>(null);
  useEffect(() => {
    const { alerts, next } = diffConnections(seen.current, devices);
    seen.current = next;
    for (const alert of alerts) showConnectionAlert(alert);
  }, [devices]);
}
