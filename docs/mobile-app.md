# Desktop and mobile apps

ADBoard serves two apps from one origin:

| | Desktop `/` | Mobile `/m/` |
|---|---|---|
| Manifest | `/manifest.webmanifest` (id, scope, start `/`) | `/m/manifest.webmanifest` (id, scope, start `/m/`, "ADBoard Mobile") |
| Service worker | `/sw.js`, caches `pc-shell-*` | `/m/sw.js`, caches `adboard-m-*` |

- The desktop worker ignores `/m` and deletes only `pc-shell-*` caches; the mobile worker never answers with the desktop shell and deletes only `adboard-m-*` caches. `src/lib/pwa/pwa.test.ts` checks both.
- `/m` looks the same in a browser tab and as an installed app: it never checks whether it is installed.
- Both apps share all device state, video, macros and settings. The mobile layout keeps its own keys (`adboard-m-section`, `adboard-m-macro-dock`, `adboard-m-grid-view`), so changing section on the phone does not move the desktop.
- To install the mobile app, open `/m/` on the phone and use Add to Home Screen. An old home-screen icon that opens `/` on a phone is moved to `/m/` automatically; "Open desktop version" in More goes back (`/?desktop=1`).
- The static pack uses `trailingSlash` so `/m` redirects to `/m/` and serves `ui/m/index.html`.

Not yet done: `/` still contains the old phone layout below 1024 px (kept until the mobile app is confirmed on real phones), and real-phone installs on iOS and Android are untested.
