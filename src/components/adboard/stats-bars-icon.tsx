import type { SVGProps } from "react";

/** Stats button glyph: three solid rounded bars (short, tall, medium). */
export function StatsBarsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden focusable="false" {...props}>
      <rect x="3.25" y="10.5" width="4.5" height="9.5" rx="1.6" />
      <rect x="9.75" y="4" width="4.5" height="16" rx="1.6" />
      <rect x="16.25" y="7.5" width="4.5" height="12.5" rx="1.6" />
    </svg>
  );
}
