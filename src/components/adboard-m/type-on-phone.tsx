"use client";

import { useRef, useState } from "react";
import { CornerDownLeft, Delete } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Android key codes for the two keys a text field alone cannot send. */
const KEY_ENTER = 66;
const KEY_DEL = 67;

/**
 * Typing on the phone app. A touch screen has no hardware keyboard for ADBoard to forward, so the
 * Keyboard tool had nothing to type with: this field sends what is typed to the phones the stage controls.
 */
export function TypeOnPhone({
  onType,
  disabled,
}: {
  onType: (input: { text: string } | { keycode: number }) => Promise<string | null>;
  disabled: boolean;
}) {
  const [text, setText] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLInputElement>(null);

  const send = async (input: { text: string } | { keycode: number }) => {
    setBusy(true);
    const problem = await onType(input);
    setBusy(false);
    setNote(problem);
    if (!problem && "text" in input) setText("");
    field.current?.focus();
  };

  return (
    <form
      data-type-on-phone
      className="flex shrink-0 flex-col gap-1 border-t border-[var(--pc-line)] px-3 py-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (text) void send({ text });
        else void send({ keycode: KEY_ENTER });
      }}
    >
      <div className="flex items-center gap-2">
        <input
          ref={field}
          value={text}
          onChange={(event) => setText(event.target.value)}
          disabled={disabled}
          enterKeyHint="send"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder={disabled ? "No phone is ready to type on" : "Type on the phone"}
          aria-label="Type on the phone"
          data-type-field
          className="h-11 min-w-0 flex-1 rounded-lg border border-[var(--pc-line)] bg-[var(--pc-panel)]/70 px-3 text-base text-[var(--pc-ink)] outline-none disabled:opacity-50"
        />
        <Button type="submit" disabled={disabled || busy || !text} className="h-11 min-w-11 px-3" data-type-send>
          Send
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={disabled || busy}
          onClick={() => void send({ keycode: KEY_DEL })}
          aria-label="Backspace on the phone"
          className="h-11 min-w-11 px-3"
          data-type-backspace
        >
          <Delete className="size-4" />
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={disabled || busy}
          onClick={() => void send({ keycode: KEY_ENTER })}
          aria-label="Enter on the phone"
          className="h-11 min-w-11 px-3"
          data-type-enter
        >
          <CornerDownLeft className="size-4" />
        </Button>
      </div>
      {note && (
        <p role="alert" className="text-meta text-[var(--pc-warn)]" data-type-note>
          {note}
        </p>
      )}
    </form>
  );
}
