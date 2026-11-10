"use client";

import { useEffect } from "react";
import { useStoredString } from "@/hooks/use-stored-flag";
import { TEXT_SIZE_KEY, parseTextSize, viewportFor, type TextSize } from "@/components/adboard-m/text-size-core";

/** More → Text size. Sets html[data-m-text] (the CSS scale) and the viewport zoom limit. */
export function useTextSize() {
  const [raw, setRaw] = useStoredString(TEXT_SIZE_KEY);
  const size = parseTextSize(raw);
  useEffect(() => {
    const root = document.documentElement;
    if (size === "standard") root.dataset.mText = "standard";
    else delete root.dataset.mText;
    // Next puts its own viewport tag back when the route changes, so keep ours.
    const apply = () => {
      const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
      if (!meta) return;
      const next = viewportFor(size, meta.content);
      if (meta.content !== next) meta.content = next;
    };
    apply();
    const watch = new MutationObserver(apply);
    watch.observe(document.head, { childList: true, subtree: true, attributes: true, attributeFilter: ["content"] });
    return () => watch.disconnect();
  }, [size]);
  return [size, (next: TextSize) => setRaw(next)] as const;
}
