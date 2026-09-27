# Phone Control — notes

Architecture lives in the Project store (`docs/architecture.md`). Run instructions and video framing: repo root `README.md`.

## Client API seam

`src/lib/api/client.ts` exports `DevicesClient` (list / tap / nav / sessions / subscribe).

Video is a separate WS: `src/hooks/use-device-video.ts` → `/ws/devices/{serial}/video` (Annex-B H264 + WebCodecs).
