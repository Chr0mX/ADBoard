# Phone Control — first slice notes

Runnable mock UI. Full architecture lives in the Project store (`docs/architecture.md`).

## Client API seam

`src/lib/api/client.ts` exports `DevicesClient`:

- `listDevices()`
- `sendTap(mode, targets, normalizedPoint)`
- `sendNav(mode, targets, action)`

Replace `createMockDevicesClient()` with HTTP/WebSocket calls to the Rust control plane without rewriting the React hooks.
