"use client";

import { useEffect, useState } from "react";
import { badgeColor, loadAppIcon, typedIcon } from "@/lib/api/app-icon";
import { cn } from "@/lib/utils";

/**
 * An app's icon: what the user typed, else the app's own icon read from the
 * phone, else a coloured badge with its first letter.
 */
export function AppIcon({
  icon,
  name,
  packageName,
  serial,
  className,
}: {
  icon?: string;
  name: string;
  packageName: string;
  serial: string | null;
  className?: string;
}) {
  const typed = typedIcon(icon);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (typed || !serial) return;
    let live = true;
    void loadAppIcon(serial, packageName).then((found) => live && setUrl(found));
    return () => {
      live = false;
    };
  }, [typed, serial, packageName]);

  if (typed) {
    return (
      <span aria-hidden className={cn("inline-flex size-6 shrink-0 items-center justify-center text-base leading-none", className)}>
        {typed}
      </span>
    );
  }
  if (url) {
    // eslint-disable-next-line @next/next/no-img-element -- a blob URL from the agent, not a static asset
    return <img src={url} alt="" aria-hidden data-app-icon-image className={cn("size-6 shrink-0 rounded-md object-contain", className)} />;
  }
  return (
    <span
      aria-hidden
      data-app-icon-badge
      style={{ background: badgeColor(packageName) }}
      className={cn("inline-flex size-6 shrink-0 items-center justify-center rounded-md text-xs font-semibold uppercase leading-none text-white", className)}
    >
      {(name.trim()[0] ?? packageName[0] ?? "?").toUpperCase()}
    </span>
  );
}
