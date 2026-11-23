# Typography

One system for the desktop (`/`) and the phone app (`/m/`). The layouts differ; the rules and the fonts' roles do not.

## Roles

| Font | Role | Used for |
|---|---|---|
| **Geist** (`--font-display`) | Hierarchy | Page titles, section headings, panel headings, prominent numbers |
| **Figtree** (`--font-body`, the page default) | The interface | Navigation, tabs, buttons, menu items, fields, labels, device names, descriptions, empty states, status words, counts |
| **JetBrains Mono** by default, or the font chosen in Settings → Appearance (`--font-mono`) | Technical values only | Serials and ids, IP addresses and ports, ADB commands and output, logs, timestamps, file paths, package names, resolution and DPI, fps, bitrate, latency, version numbers |

The mono font is a setting (see [The technical-value font](#the-technical-value-font)). Only this role changes with it; Geist and Figtree are fixed.

Never mono for a button, a tab, a heading or a description. A value is not mono just because it contains digits: "12 steps", "3/4 online" and "78%" are Figtree with tabular numerals.

## Tokens (`src/app/globals.css`, `:root`)

| Token | Desktop | Phone, Compact | Phone, Standard | Font and weight |
|---|---:|---:|---:|---|
| `--t-title` | 24 | 19 | 20 | Geist 600 |
| `--t-subtitle` | 18 | 17 | 18 | Geist 600 |
| `--t-heading` | 16 | 15 | 16 | Geist 600 |
| `--t-device` | 15 | 15 | 16 | Figtree 600 |
| `--t-body` | 14 | 14 | 15 | Figtree 400 |
| `--t-control` | 13 | 14 | 15 | Figtree 500 (buttons, tabs, nav) |
| `--t-field` | 13 | 13 (16 on touch) | 16 | Figtree 400 |
| `--t-label` | 12.5 | 13 | 14 | Figtree 500 |
| `--t-secondary` | 12 | 12.5 | 13 | Figtree 400 |
| `--t-tech` | 12.5 | 12.5 | 13 | mono font, 400/500 |
| `--t-meta` | 12 | 12 | 12.5 | Figtree 400 |
| `--t-tab` | 13 | 11 | 12 | bottom tab labels |

The phone app overrides the tokens on `[data-m-app]` and on `[data-m-sheet]` (sheets are rendered outside the app element); the More tab's Compact/Standard text size switches to the Standard column. The phone Control screen keeps the desktop values (its chrome is dense and has its own layout). Phone values are not the desktop values scaled down: body is 14 (not 13), and nothing below 12 except the bottom tab labels.

## How it is applied

- **Tailwind sizes follow the tokens** (`@theme` in `globals.css`): `text-xs` is secondary, `text-sm` body, `text-base` heading, `text-lg` subtitle, `text-xl` title, `text-meta` meta. Existing classes scale with the system on both interfaces.
- **Base rules** (`@layer base`): `h1`/`h2` and `h3`/`h4` are Geist; `button`, `summary` and fields inherit Figtree and take the control/field size. Nothing forces mono on controls.
- **Semantic classes** (`@layer components`): `.t-title .t-subtitle .t-heading .t-device .t-body .t-control .t-label .t-secondary .t-meta .t-tech`, and `.tabular`.
- **Mono** is opt-in: `font-mono` or `.t-tech` on the element that shows the technical value, `data-mono-field` on a field that holds one. `font-variant-numeric: tabular-nums` is on all of them.
- **`cn`** (`src/lib/utils.ts`) knows `text-meta` is a size, so it is not dropped next to a text colour.

## Tabs and navigation

| Kind | Desktop | Phone (Compact / Standard) |
|---|---:|---:|
| Header tabs, section tabs (Macros), Settings categories, list rows | 14, weight 500 (current tab 600) | 14 / 15 |
| Pill buttons and segmented controls (Manage and Apps sub-tabs, Selected / Multi / All) | 13, weight 500 | 14 / 15 |
| Bottom tab bar labels (phone) | n/a | 11 / 12 |

All of them are Figtree. Tabs read as navigation (body size); pill buttons read as controls.

## The technical-value font

**Settings → Appearance → Font for technical values** changes the font of the mono role, on the desktop and the phone app. The default is **JetBrains Mono**. The choice is saved with the other settings (`adboard-mono-font`, in the data folder, shared by every browser) and is applied as `data-mono-font` on `<html>`. A small script in `layout.tsx` sets it before the first paint, and `MonoFontSync` keeps it current when the setting changes. Each option has one rule in `globals.css` that sets `--font-mono`; the default is the `:root` value, so a missing or unknown choice is JetBrains Mono.

| Option | Kind |
|---|---|
| JetBrains Mono (default) | Bundled |
| System Monospace | System: `ui-monospace`, SF Mono, Menlo, Consolas, Liberation Mono |
| Fira Code, Source Code Pro, IBM Plex Mono, Roboto Mono, Ubuntu Mono, Space Mono, Inconsolata, Anonymous Pro, DM Mono, Red Hat Mono | Bundled (Google Fonts through `next/font`) |
| Cascadia Code, Menlo, Consolas, SF Mono | System: used when the device has it, otherwise the device's monospace font |

- **Bundled fonts** are declared in `src/app/layout.tsx` with `preload: false`, so a browser downloads a font only when it is chosen (latin subset, weights 400 and 500; 400 only for Ubuntu Mono, Space Mono and Anonymous Pro, which have no 500). Only JetBrains Mono is preloaded.
- **System fonts** cost nothing to load, but look different from device to device: Menlo and SF Mono exist on Apple devices, Consolas and Cascadia Code on Windows. The Settings page says so when one is chosen.
- The list and the saved-value check live in `src/lib/ui/mono-fonts.ts`. To add a font: add it there, add its rule in `globals.css`, and, if it is bundled, declare it in `layout.tsx`. `src/lib/ui/mono-fonts.test.ts` fails when the three disagree.
- Because every option's stack ends in `monospace`, `scripts/audit-typography.mjs` still counts it as the mono family.

## Checking it

- `npm test` includes `src/lib/ui/mono-fonts.test.ts` (the sixteen options, a CSS rule for each, bundled fonts declared and not preloaded), `src/lib/ui/typography.test.ts` (no mono rule on controls, tokens present, loaded weights, no fixed 10/11 px text, no uppercase or wide tracking) and `src/components/adboard-m/text-size.test.ts`.
- `node scripts/audit-typography.mjs` (dev server and mock agent running) opens every desktop tab at 1280 and 1024 px and every phone route at 390 and 430 px (Compact) and 390 px (Standard), and fails on mono controls, non-Geist headings, unknown families, text under 12 px and sideways overflow.

## Where mono is kept (reviewed when the system was introduced)

Serials and device info (Manage, Automate), package names and permissions (Apps, App controls), paths and the data folder (Storage, Files, data-storage), ADB output and logs (Developer, logcat, Shell Automation, wireless ADB), schedules and times (Macros queue, Events detail lines), model and screen size (Hosts, device cards), the stats line (fps, CPU, RAM, kbps), touch diagnostics, version and uid lines, environment variable names, and the phrase to type in a confirm dialog.
