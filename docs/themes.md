# Themes

Back to the [docs index](README.md). **Settings → Appearance** chooses how ADBoard looks: dark or light, and a colour theme for each. The choice applies at once, with no reload, and is the same on the desktop page (`/`) and the phone app (`/m/`).

## What you can choose

- **Theme mode:** Dark (the default), Light, or System (follows the device and changes with it).
- **Dark theme:** ADBoard (the default, the existing look), Catppuccin Mocha, Dracula, Nord, Tokyo Night, Gruvbox Dark, Solarized Dark, One Dark, GitHub Dark, Rosé Pine.
- **Light theme:** ADBoard Light, Catppuccin Latte, Nord Light, Solarized Light, Gruvbox Light, GitHub Light, Rosé Pine Dawn.

Each swatch shows the theme's own page colour, its accent, success, warning and error colours, and its panel colour. Picking a theme of the other mode also switches to that mode (unless the mode is System, which keeps following the device). The three choices are saved with the other settings (`adboard-theme-mode`, `adboard-theme-dark`, `adboard-theme-light`), so every browser on the same ADBoard shows the same theme.

## How it works

- **One palette table:** `src/lib/ui/themes.ts` holds every palette (13 colours each) and the rule that picks the theme to show (`resolveTheme`). Nothing else writes theme colours down, so the desktop and phone apps cannot drift apart.
- **CSS:** `layout.tsx` renders one `html[data-theme="…"]` rule per theme from that table. A rule only sets the raw `--th-*` colours; `globals.css` derives every other token (`--pc-*`, the shadcn tokens, charts, the desk background, shadows) from them. The default theme is the `:root` values in `globals.css`, so the existing look is unchanged. Components use the tokens (`var(--pc-ink)`, `bg-card` ...) and never theme colours directly.
- **No flash:** a small script in `<head>` reads the saved choice and sets `class="dark"`, `data-theme`, and the browser's `theme-color` before the first paint. `ThemeSync` keeps `<html>` current afterwards (a change in Settings, another tab, a synced browser, or the device switching between light and dark in System mode). `themes.test.ts` runs the script against `resolveTheme` for every combination.
- **iPhone:** the Home Screen app uses a translucent status bar with white text, which cannot be changed while the app is open. On a light theme the strip over the status bar is therefore the theme's dark `frame` colour, so the time and battery stay readable; on dark themes it matches the page. Safari's own bar follows `theme-color`.
- **Fixed on purpose:** the black backdrop behind a phone's picture, text on top of the picture, and the marker colours drawn on a phone's screen stay the same in every theme. Fixed hues for step kinds (shell, key, file) get darker variants on light themes.

## Adding a theme

1. Add a palette to `THEMES` in `src/lib/ui/themes.ts` (a unique `id`, `mode` dark or light, all 13 colours).
2. Run `npm test`. `themes.test.ts` fails if a palette is incomplete, if its text, accent or button colours are not readable (contrast), or if a dark theme is not dark (or a light one not light).

Nothing else needs changing: the rule, the swatch and the saved-value check come from the table.
