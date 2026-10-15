<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Cursor Cloud specific instructions

### Git workflow

- Work **directly on `main`**. Do not create `cursor/*` feature branches for new requests unless the user explicitly asks.
- Commit and push to `main`. Do not open extra branches or leave stale agent branches around.

ADBoard is two processes. This VM has no USB phones, so use the mock fleet.

- Agent (port 3848): `PHONECONTROL_FORCE_MOCK=1 PHONECONTROL_VIDEO_SOURCE=testpattern PHONECONTROL_BIND=0.0.0.0 cargo run -p phonecontrol-agent`. `ffmpeg` is on `PATH` and supplies the live H264 test pattern.
- Web UI (port 3847): `NEXT_PUBLIC_AGENT_URL=http://127.0.0.1:3848 npm run dev -- --webpack`. Without `NEXT_PUBLIC_AGENT_URL` the UI stays on the in-browser mock and never opens the video WebSocket. Pass `--webpack` because Next.js 16.3 Turbopack fails to compile `next/font/google` (`Can't resolve '@vercel/turbopack-next/internal/font/google/font'`).

Checks:

- `cargo test --workspace` is the Rust suite.
- `npx next typegen && npx tsc --noEmit` typechecks the UI. `next typegen` (also run by `next dev` / `next build`) generates `LayoutProps` and `next-env.d.ts`.
- `npm run lint` currently fails on a pre-existing `react-hooks/set-state-in-effect` error in `src/hooks/use-device-video.ts`.

`make fetch-deps` downloads ADB and scrcpy into `./temp/` for real-device work. It is not required for the mock fleet.
