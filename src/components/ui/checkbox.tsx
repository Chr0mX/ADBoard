"use client";

import type { InputHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

type CheckboxProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type">;

/** Pick items from a list. Native checkbox, themed (see `.pc-checkbox`). */
export function Checkbox({ className, ...props }: CheckboxProps) {
  return <input type="checkbox" className={cn("pc-checkbox", className)} {...props} />;
}

/** Checkbox, label, optional trailing meta — one row height and hover everywhere. */
export function CheckRow({
  label,
  meta,
  className,
  children,
  ...props
}: CheckboxProps & { label: ReactNode; meta?: ReactNode; children?: ReactNode }) {
  return (
    <label className={cn("pc-choice-row", className)} aria-disabled={props.disabled || undefined}>
      <Checkbox {...props} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {children}
      {meta && <span className="ml-auto shrink-0">{meta}</span>}
    </label>
  );
}

/** The checkbox look on a span, for buttons that act like a checkbox. */
export function CheckboxVisual({ checked, className }: { checked: boolean; className?: string }) {
  return <span aria-hidden data-checked={checked ? "true" : "false"} className={cn("pc-checkbox-visual", className)} />;
}
