"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Device } from "@/lib/devices/types";
import { agentBaseUrl, agentWsProtocols, agentWsUrl } from "@/lib/api/auth";
import { saveBlob } from "@/lib/api/download";
import {
  LOG_LEVELS,
  appendLines,
  filterLines,
  parseFrame,
  parseLogLine,
  type LogLevel,
  type LogLine,
} from "@/lib/devices/logcat";
import { cn } from "@/lib/utils";

const fieldClass =
  "h-11 min-h-11 min-w-0 rounded-xl border border-[var(--pc-line)] bg-[var(--pc-paper)] px-2 text-xs text-[var(--pc-ink)] outline-none focus-visible:border-[var(--pc-accent)]";
const button = "h-11 rounded-lg border border-[var(--pc-line)] px-3 text-sm disabled:opacity-50";

const LEVEL_CLASS: Record<LogLevel, string> = {
  V: "text-[var(--pc-muted)]",
  D: "text-[var(--pc-ink)]",
  I: "text-[var(--pc-signal)]",
  W: "text-[var(--pc-warn)]",
  E: "text-red-500",
  F: "font-semibold text-red-600",
};

interface Stream {
  serial: string;
  package: string;
  level: LogLevel;
}

/** Developer → Logcat: one phone's live log, optionally one app and a minimum level. */
export function LogcatView({ devices, preferred }: { devices: Device[]; preferred: Device | null }) {
  const online = devices.filter((d) => d.status === "online");
  const [picked, setSerial] = useState(() => (preferred?.status === "online" ? preferred.serial : ""));
  // The picked phone, or the first online one (the list can arrive after the first render).
  const serial = online.some((d) => d.serial === picked) ? picked : (online[0]?.serial ?? "");
  const [pkg, setPkg] = useState("");
  const [level, setLevel] = useState<LogLevel>("I");
  const [search, setSearch] = useState("");
  const [stream, setStream] = useState<Stream | null>(null);
  const [lines, setLines] = useState<LogLine[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [skipped, setSkipped] = useState(0);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const nextId = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const configured = agentBaseUrl() !== null;

  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  useEffect(() => {
    if (!stream) return;
    let socket: WebSocket | null = null;
    let closed = false;
    void agentWsUrl(`/ws/devices/${encodeURIComponent(stream.serial)}/logcat`)
      .then((url) => {
        if (closed) return;
        socket = new WebSocket(url, agentWsProtocols());
        socket.onopen = () => socket?.send(JSON.stringify({ package: stream.package, level: stream.level }));
        socket.onmessage = (event) => {
          if (typeof event.data !== "string") return;
          const frame = parseFrame(event.data);
          if (!frame) return;
          if ("note" in frame) setNote(frame.note);
          else if ("skipped" in frame) setSkipped((n) => n + frame.skipped);
          else if (!pausedRef.current) {
            const parsed = frame.lines.map((raw) => parseLogLine(raw, nextId.current++));
            setLines((current) => appendLines(current, parsed));
          }
        };
        socket.onclose = () => {
          if (!closed) setNote((n) => n ?? "Logcat connection closed");
        };
      })
      .catch((error: unknown) => setNote(error instanceof Error ? error.message : "Could not connect"));
    return () => {
      closed = true;
      socket?.close();
    };
  }, [stream]);

  // Follow the end unless the user scrolled up.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    if (list.scrollHeight - list.scrollTop - list.clientHeight < 120) list.scrollTop = list.scrollHeight;
  }, [lines]);

  const shown = useMemo(() => filterLines(lines, search), [lines, search]);

  function start() {
    if (!serial) return;
    setLines([]);
    setNote(null);
    setSkipped(0);
    setPaused(false);
    setStream({ serial, package: pkg.trim(), level });
  }

  function save() {
    const name = devices.find((d) => d.serial === stream?.serial)?.name ?? "phone";
    saveBlob(new Blob([lines.map((l) => l.raw).join("\n")], { type: "text/plain" }), `logcat-${name.replace(/[^\w-]+/g, "_")}.txt`);
  }

  if (!configured) {
    return <p className="text-sm text-[var(--pc-muted)]">Logcat needs the ADBoard agent (it is not available in the in-browser demo).</p>;
  }

  return (
    <div className="flex min-h-0 flex-col gap-3 rounded-xl border border-[var(--pc-line)] bg-[var(--pc-panel)] p-4" data-logcat>
      <div className="grid gap-2 md:grid-cols-[1fr_1fr_auto_auto]">
        <label className="flex min-w-0 flex-col gap-1 text-xs text-[var(--pc-muted)]">
          Phone
          <select value={serial} onChange={(event) => setSerial(event.target.value)} className={fieldClass} data-logcat-phone>
            {online.length === 0 && <option value="">No phone online</option>}
            {online.map((d) => (
              <option key={d.id} value={d.serial}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-xs text-[var(--pc-muted)]">
          App (optional)
          <input value={pkg} spellCheck={false} placeholder="com.example.game" onChange={(event) => setPkg(event.target.value)} className={cn(fieldClass, "font-mono")} data-logcat-package />
        </label>
        <label className="flex min-w-0 flex-col gap-1 text-xs text-[var(--pc-muted)]">
          Level
          <select value={level} onChange={(event) => setLevel(event.target.value as LogLevel)} className={fieldClass} data-logcat-level>
            {LOG_LEVELS.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-end gap-2">
          <button type="button" className={cn(button, "bg-[var(--pc-accent-fill)] text-white")} disabled={!serial} onClick={start} data-logcat-start>
            {stream ? "Restart" : "Start"}
          </button>
          {stream && (
            <button type="button" className={button} onClick={() => setStream(null)} data-logcat-stop>
              Stop
            </button>
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search lines" className={cn(fieldClass, "flex-1")} aria-label="Search lines" data-logcat-search />
        <button type="button" className={button} aria-pressed={paused} disabled={!stream} onClick={() => setPaused((p) => !p)}>
          {paused ? "Resume" : "Pause"}
        </button>
        <button type="button" className={button} onClick={() => setLines([])}>
          Clear
        </button>
        <button type="button" className={button} disabled={lines.length === 0} onClick={save}>
          Save .txt
        </button>
      </div>
      <p className="text-[11px] text-[var(--pc-muted)]">
        {shown.length} line{shown.length === 1 ? "" : "s"}
        {search && ` of ${lines.length}`}
        {skipped > 0 && ` · ${skipped} skipped (too fast)`}
        {note && ` · ${note}`}
        {" · "}App crashes on any phone are also recorded in Events.
      </p>
      <div ref={listRef} className="h-[28rem] overflow-auto rounded-xl border border-[var(--pc-line)] bg-[var(--pc-frame)] p-2 font-mono text-[11px] leading-4" data-logcat-lines>
        {shown.map((line) => (
          <div key={line.id} className={cn("whitespace-pre", line.level ? LEVEL_CLASS[line.level] : "text-[var(--pc-muted)]")} data-level={line.level ?? ""}>
            {line.raw}
          </div>
        ))}
        {!stream && lines.length === 0 && <p className="text-[var(--pc-muted)]">Pick a phone and press Start.</p>}
      </div>
    </div>
  );
}
