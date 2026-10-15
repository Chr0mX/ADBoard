# ADBoard — notes

Architecture: [architecture.md](./architecture.md). Run instructions and video framing: repo root `README.md`. Windows pack: `dist/windows/README.md`.

## Client API seam

`src/lib/api/client.ts` exports `DevicesClient` (list / tap / nav / sessions / subscribe).
Auth for the agent lives in `src/lib/api/auth.ts` (`x-phonecontrol-token` from `/api/bootstrap`).

Video is a separate WS: `src/hooks/use-device-video.ts` → `/ws/devices/{serial}/video` (Annex-B H264 + WebCodecs).
