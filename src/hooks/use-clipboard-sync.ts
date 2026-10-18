"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { agentWsProtocols } from "@/lib/api/auth";
import { devicesClient } from "@/lib/api/client";
import type { ControlMode, Device } from "@/lib/devices/types";
import { eventsWsUrlAsync, postClipboard } from "@/lib/scrcpy/client";
import { isTypingTarget, keyDownInject, keyUpInject } from "@/lib/scrcpy/keyboard";
import { useStoredFlag } from "@/hooks/use-stored-flag";

export const CLIPBOARD_SYNC_KEY = "adboard-clipboard-sync";

/* Last sync status, shown next to the "Sync clipboard" switch. */
const listeners = new Set<() => void>();
let status: string | null = null;
function setStatus(next: string | null) {
  if (status === next) return;
  status = next;
  listeners.forEach((listener) => listener());
}
export function useClipboardSyncStatus() {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => status,
    () => null,
  );
}

function isPasteShortcut(event: KeyboardEvent) {
  return (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "v";
}

async function sendText(targets: Device[], text: string) {
  if (!text) {
    setStatus("PC clipboard is empty");
    return;
  }
  try {
    const result = await postClipboard(
      targets.map((d) => d.id),
      text,
      true,
    );
    const failed = result.results.filter((r) => !r.ok);
    setStatus(
      failed.length === 0
        ? `Pasted on ${targets.length} phone${targets.length === 1 ? "" : "s"}`
        : failed.map((r) => r.error || "failed").join(" · "),
    );
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Clipboard send failed");
  }
}

/**
 * "Sync clipboard" (off by default). Mounted once beside the control targets:
 * - Phone → PC: a clipboard change pushed by scrcpy (`/ws` "clipboard") on a
 *   target phone is written to the PC clipboard.
 * - PC → phone: Ctrl/Cmd+V pastes the PC clipboard on the target phones
 *   (scrcpy SET_CLIPBOARD with paste). With keyboard injection on, the key is
 *   taken before it is forwarded; if the browser will not let the page read
 *   the clipboard, the key is forwarded as before.
 * Typing in a page field is never intercepted.
 */
export function useClipboardSync({ targets, mode }: { targets: Device[]; mode: ControlMode }) {
  const [enabled] = useStoredFlag(CLIPBOARD_SYNC_KEY, false);
  const [keyboardOn] = useStoredFlag("adboard-keyboard", true);
  const targetsRef = useRef(targets);
  const modeRef = useRef(mode);
  useEffect(() => {
    targetsRef.current = targets;
    modeRef.current = mode;
  }, [targets, mode]);

  // Phone → PC.
  useEffect(() => {
    if (!enabled) return;
    let closed = false;
    let socket: WebSocket | null = null;
    let lastText = "";
    const connect = () => {
      if (closed) return;
      void eventsWsUrlAsync()
        .then((url) => {
          if (closed) return;
          socket = new WebSocket(url, agentWsProtocols());
          socket.onmessage = (event) => {
            try {
              const msg = JSON.parse(String(event.data)) as { type?: string; serial?: string; text?: string };
              if (msg.type !== "clipboard" || typeof msg.text !== "string" || !msg.text) return;
              if (!targetsRef.current.some((d) => d.serial === msg.serial)) return;
              if (msg.text === lastText) return;
              lastText = msg.text;
              if (!navigator.clipboard?.writeText) {
                setStatus("Browser blocked clipboard access (needs HTTPS or localhost)");
                return;
              }
              navigator.clipboard.writeText(msg.text).then(
                () => setStatus("Copied from the phone"),
                () => setStatus("Browser blocked clipboard access (focus the page, HTTPS or localhost)"),
              );
            } catch {
              // ignore
            }
          };
          socket.onclose = () => {
            if (!closed) setTimeout(connect, 2000);
          };
        })
        .catch(() => {
          if (!closed) setTimeout(connect, 2000);
        });
    };
    connect();
    return () => {
      closed = true;
      socket?.close();
    };
  }, [enabled]);

  // PC → phone.
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!keyboardOn || event.isComposing || isTypingTarget(event.target) || !isPasteShortcut(event)) return;
      const targets = targetsRef.current;
      if (targets.length === 0) return;
      // Take the key before keyboard injection forwards Ctrl+V to the phone.
      event.preventDefault();
      event.stopImmediatePropagation();
      const forwardKey = async () => {
        const down = keyDownInject(event);
        const up = keyUpInject(event);
        if (down?.kind === "key") {
          await devicesClient.sendKey(modeRef.current, targets, {
            action: "down",
            keycode: down.keycode,
            repeat: 0,
            metastate: down.metastate,
          });
        }
        if (up?.kind === "key") {
          await devicesClient.sendKey(modeRef.current, targets, {
            action: "up",
            keycode: up.keycode,
            repeat: 0,
            metastate: up.metastate,
          });
        }
      };
      if (!navigator.clipboard?.readText) {
        setStatus("Browser cannot read the clipboard here; Ctrl+V sent as a key");
        void forwardKey().catch(() => {});
        return;
      }
      navigator.clipboard.readText().then(
        (text) => void sendText(targets, text),
        () => {
          setStatus("Clipboard read was blocked; Ctrl+V sent as a key");
          void forwardKey().catch(() => {});
        },
      );
    };
    const onKeyUp = (event: KeyboardEvent) => {
      // The matching key-up of an intercepted Ctrl+V must not reach the phone either.
      if (!keyboardOn || isTypingTarget(event.target) || !isPasteShortcut(event)) return;
      if (targetsRef.current.length === 0) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    // Keyboard injection off: the browser's own paste event carries the text.
    const onPaste = (event: ClipboardEvent) => {
      if (keyboardOn || isTypingTarget(event.target)) return;
      const targets = targetsRef.current;
      if (targets.length === 0) return;
      event.preventDefault();
      void sendText(targets, event.clipboardData?.getData("text/plain") ?? "");
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("paste", onPaste);
    };
  }, [enabled, keyboardOn]);
}
