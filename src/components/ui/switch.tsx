"use client";

import type { InputHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

type SwitchProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "role">;

/**
 * On/off setting. A native checkbox with `role="switch"`, so `checked`,
 * `onChange`, forms and tests behave exactly like a checkbox.
 */
export function Switch({ className, ...props }: SwitchProps) {
  return <input type="checkbox" role="switch" className={cn("pc-switch", className)} {...props} />;
}

/** Label on the left, switch on the right, optional description under the label. */
export function SwitchRow({
  label,
  description,
  className,
  ...props
}: SwitchProps & { label: ReactNode; description?: ReactNode }) {
  return (
    <label className={cn("pc-choice-row justify-between", className)} aria-disabled={props.disabled || undefined}>
      <span className="flex min-w-0 flex-col">
        <span className="text-sm text-[var(--pc-ink)]">{label}</span>
        {description && <span className="text-[11px] leading-snug text-[var(--pc-muted)]">{description}</span>}
      </span>
      <Switch {...props} />
    </label>
  );
}
