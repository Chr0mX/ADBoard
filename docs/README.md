# ADBoard — notes

Architecture: [architecture.md](./architecture.md). Run instructions and video framing: repo root `README.md`. Windows pack: `dist/windows/README.md`.

## Client API seam

`src/lib/api/client.ts` exports `DevicesClient` (list / tap / nav / sessions / subscribe).
Auth for the agent lives in `src/lib/api/auth.ts` (`x-adboard-token` from `/api/bootstrap`).

Video is a separate WS: `src/hooks/use-device-video.ts` → `/ws/devices/{serial}/video` (Annex-B H264 + WebCodecs).

## Toggle design system

Every on/off control uses one of four shared looks, defined in `src/app/globals.css` with React wrappers in `src/components/ui/`:

| Control | Use for | Class / component |
|---|---|---|
| Toggle button | toolbar, floating panel, taskbar and grid bar actions that stay on | `.pc-toggle` + `.pc-toggle-sm` (36px) / `-md` (44px) / `-lg` (48px), `.pc-toggle-icon` for square, `.pc-toggle-warn` for recording; `<Toggle size tone shape>`; `PC_HIT_*` in `src/lib/ui/control-chrome.ts` |
| Switch | a setting with a text label | `<Switch>` / `<SwitchRow>` (`.pc-switch`, a native checkbox with `role="switch"`) |
| Checkbox | picking items from a list | `<Checkbox>` / `<CheckRow>` (`.pc-checkbox`); `<CheckboxVisual>` inside a button |
| Segmented | one of N | `.pc-segmented` track with `.pc-segment` items |

"On" looks the same everywhere: accent border, accent-soft background and accent text. Recording uses the warn colours instead. On beats hover. Focus shows a 2px accent outline, disabled controls are at 45% opacity, and pressing a toggle scales it to 97%. Colours and sizes are unlayered CSS, so shadcn utilities can't override them. Display and alignment are in `@layer components`, so layout utilities still apply.
