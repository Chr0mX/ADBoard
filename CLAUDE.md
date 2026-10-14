@AGENTS.md

# Phone Control — Claude project brief

Use this file when working in Claude Code, Claude.ai Projects, or any Claude session attached to this repo. Cursor Cloud agents also read `AGENTS.md` via the include above.

## What this is

**Phone Control** is a multi-device Android control center. scrcpy/ADB is the transport; this app owns device discovery, sessions, video/input abstraction, and the Web UI. The browser never talks to ADB directly.

| Piece | Path | Port |
|---|---|---|
| Next.js Web UI | `src/` | **3847** |
| Rust binary (`phonecontrol-agent`) | `crates/phonecontrol-agent` | **3848** controller / **3849** agent |
| Shared protocol types | `crates/phonecontrol-protocol` | — |

Same binary, two roles via `--role` / `PHONECONTROL_ROLE`: **controller** (default) serves the UI API and proxies video; **agent** owns local ADB/scrcpy/testpattern and registers with a controller.

## What you are trying to achieve

Help ship a reliable operator desk for Android fleets: live H264 video over WebSocket, touch/keyboard input, multi-device grid, floating chrome, desk panels (apps, files, automate, manage), and Windows/Linux packaging. Prefer small, correct changes that match existing patterns over large rewrites.

## How to work

- Read `README.md` and `docs/architecture.md` before changing protocol, video, or session lifecycle.
- This Next.js version differs from older training data — check `node_modules/next/dist/docs/` before UI framework changes.
- This environment usually has **no USB phones**. Use the mock fleet + test pattern (see `AGENTS.md`).
- Do not invent ADB/scrcpy behavior; match what the Rust agent and scrcpy server already do.
- Keep the Next.js agent-rules block in `AGENTS.md` intact (it is re-added by `next dev`).

## Checks

- Rust: `cargo test --workspace`
- UI types: `npx next typegen && npx tsc --noEmit`
- Lint: `npm run lint` (known pre-existing hook lint in `src/hooks/use-device-video.ts`)

## Claude.ai project form (copy/paste)

Ready-made answers for claude.ai → Projects → **Create a project**:

**What are you working on?**
```
Phone Control
```

**What are you trying to achieve?**
```
Multi-device Android control center (Rust agent + Next.js UI over scrcpy/ADB). Help develop video streaming, input, desk UI, fleet management, and packaging. Follow this repo’s CLAUDE.md and AGENTS.md; use the mock fleet when no phones are available.
```

**Context (optional)** — after create, also set project instructions / knowledge to:

- This repository (`CLAUDE.md`, `AGENTS.md`, `README.md`, `docs/architecture.md`)
- Prefer the instructions in `CLAUDE.md` for standing rules; use `docs/architecture.md` for protocol and process layout
