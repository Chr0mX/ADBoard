"use client"

import { Toggle as TogglePrimitive } from "@base-ui/react/toggle"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

/**
 * The one on/off button look (see `.pc-toggle` in globals.css): same border,
 * radius, type, hover, focus and pressed state everywhere. Sizes: sm 36px,
 * md 44px, lg 48px. Warn tone is for recording.
 */
const toggleVariants = cva("pc-toggle", {
  variants: {
    size: {
      sm: "pc-toggle-sm",
      md: "pc-toggle-md",
      lg: "pc-toggle-lg",
      /** Size and padding come from the caller (e.g. responsive tool rows). */
      none: "",
    },
    shape: {
      label: "",
      icon: "pc-toggle-icon",
    },
    tone: {
      accent: "",
      warn: "pc-toggle-warn",
    },
  },
  defaultVariants: {
    size: "md",
    shape: "label",
    tone: "accent",
  },
})

function Toggle({
  className,
  size,
  shape,
  tone,
  ...props
}: TogglePrimitive.Props & VariantProps<typeof toggleVariants>) {
  return (
    <TogglePrimitive
      data-slot="toggle"
      className={cn(toggleVariants({ size, shape, tone }), className)}
      {...props}
    />
  )
}

export { Toggle, toggleVariants }
