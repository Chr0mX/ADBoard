# Performance: many phones at once

This page records what was measured, what changed, and how to measure again on your own machines.

## What limits ADBoard with 12 phones

A CPU profile of the page with 12 live phones showed where the time goes:

| Share of the page's main thread | What |
|---|---|
| 48% | `drawImage`: copying each decoded frame into its canvas |
| 3% | handing frames to the decoder |
| about 1% | all of ADBoard's own JavaScript per frame (parsing H264, bookkeeping) |

So the copy into the canvas is the cost that matters, and the React and WebSocket code around it is small. The profile was taken in headless Chromium with software decoding and no GPU.

## What changed

| Area | Change | File |
|---|---|---|
| Grid | Tiles and device cards are memoised; a fleet update re-renders only the phone that changed | `touch-screen-grid.tsx`, `device-card.tsx`, `lib/ui/tile-flags.ts` |
| Canvas | A canvas is as large as it is shown (in device pixels), not the phone's full resolution; the 2D context is looked up once; extra frames within one display refresh are not drawn | `lib/video/canvas-size-core.ts`, `frame-slot-core.ts`, `hub.ts` |
| Decoder | The browser picks the decoder (GPU when it has one); a decoder that fails 3 times in 10 s is replaced by the software decoder for that phone | `lib/video/decoder-config-core.ts` |
| WebSocket | Reconnects back off (0.4 s growing to 8 s, with jitter); a socket that goes silent past its heartbeat is reconnected; the agent sends a keyframe to a viewer that fell behind and no longer copies each frame per viewer | `lib/api/reconnect-core.ts`, agent `api/mod.rs`, `video.rs` |
| Memory | The MSE fallback's queues are bounded and played video is trimmed | `lib/video/mse-queue-core.ts`, `mse-player.ts` |
| Device list | Bursts of device events make one list request plus one follow-up; late answers are dropped | `lib/api/refresh-core.ts` |
| Macros | An identical poll is not parsed or announced; the run clock ticks once a second. Runs and schedules stay on the agent | `lib/macro/view-gate.ts`, `runs.ts` |
| Decoder back-pressure | The page drops frames only when the decoder holds 12 (about 0.4 s at 30 fps); a keyframe is then asked for once the queue has drained to 6. With the earlier limit of 3, a few phones decoding side by side kept tripping it, threw away the rest of each GOP and cost a keyframe round trip each time, so pictures updated only when a keyframe landed. Measured on the mock fleet at 60 fps with the CPU throttled 4×: 19 to 43 pictures a second per phone (7.5 to 20 at 8×) | `lib/video/backpressure.ts`, `hub.ts` |
| Hidden or unfocused | Nothing is reduced: every open stream stays connected and runs at full speed. An earlier idle mode (agent told to stop sending) and the Background FPS setting were removed because a stalled keyframe handshake looked like a frozen stream | `lib/video/hub.ts` |

## Measured here

Headless Chromium, software decode, no GPU, 4 CPU cores shared with the agent and one ffmpeg encoder per phone. Mock phones send a 360x640 test pattern at 30 fps. One minute per run. Raw results: `docs/bench/*.json`.

| Phones | Version | Painted fps per phone | Frames dropped per second | Input to next painted frame, p95 | Page main thread | Browser CPU | Tile re-renders per minute |
|---|---|---|---|---|---|---|---|
| 1 | before | 30 | 0 | 32 ms | 6% | 21% | 42 |
| 1 | after | 30 | 0 | 30 ms | 7% | 21% | 42 |
| 4 | before | 30 | 0 | 32 ms | 22% | 56% | 129 |
| 4 | after | 30 | 0 | 34 ms | 21% | 61% | 39 |
| 8 | before | 30 | 0 | 38 ms | 40% | 80% | 249 |
| 8 | after | 30 | 0 | 35 ms | 38% | 65% | 39 |
| 12 | before | 29.6 | 4.6 | 144 ms | 70% | 105% | 381 |
| 12 | after | 30 | 0 | 41 ms | 57% | 92% | 40 |

How to read it:

- **Tile re-renders** fell from about 30 per phone to about 40 in total. The test changes one phone's vitals every 2 s and taps one tile every 5 s.
- **CPU and main-thread numbers at 12 phones vary between runs** on this machine: four repeat runs gave 64 to 77% main thread and 0 to 4.6 dropped frames per second for both versions. Treat the CPU columns as "no worse", not as a proven gain.
- **Input to next painted frame** is the time from a marked input to that phone's next drawn frame inside the page. With a test pattern it measures the page's pipeline, not a real phone's reaction. Three "before" runs at 12 phones gave a p95 of 50 to 144 ms; three "after" runs gave 32 to 41 ms.
- **Memory**: browser memory was flat within each run (about 1.3 to 1.5 GB for all Chromium processes, which is mostly Chromium itself). After leaving the screens, the page held 0 streams and 0 stats listeners in every run.
- **Recovery after an agent restart** (12 phones, no reload): 1.7 s before, 2.1 s after, one sample each. Not an improvement.
- **Canvas sizing was not exercised by these runs**: the test pattern (360x640) is smaller than the tiles, so canvases stayed at full frame size. The gain applies to real phones, whose frames are much larger than a grid tile.

Checked once end to end on the mock fleet: a frozen agent is detected after 15 s and video returns 0.2 s after it resumes; on `/m/`, leaving Control closes the video socket and coming back paints again in 0.2 s; a tap sent while the stream is suspended is accepted.

## Not measured here

- GPU use and GPU memory, and anything with hardware decoding.
- Windows, Chrome with a real display, and the iPhone PWA.
- Real phones (1080p and larger frames, 60 fps, real input latency).
- Memory growth over 30 minutes.

## Measure it yourself

### The probe

Open ADBoard with `?perf=1` (or set `localStorage["adboard-perf"] = "1"` and reload). In the browser console:

```js
__adboardPerf.snapshot()
```

It returns, per phone: frames received, decoded, painted, dropped, the highest decode queue, reconnects, suspends, the decoder kind, and message handling time. `hardwareDecoderSupported` says whether the browser reports a GPU H264 decoder.

To compare decoders, set `localStorage["adboard-video-accel"]` to `hardware` or `software` and reload. Remove it to let the browser choose.

### The script (Linux or macOS)

```sh
cargo build --release -p adboard-agent
node scripts/bench/run.mjs --phones 12 --minutes 2 --label mine
node scripts/bench/run.mjs --phones 12 --minutes 30 --label soak
node scripts/bench/run.mjs --phones 12 --recover --label mine
node scripts/bench/run.mjs --phones 12 --route /m/ --label phone-layout
```

Results go to `temp/bench/`. `ADBOARD_MOCK_COUNT`, `ADBOARD_MOCK_VITALS` and `ADBOARD_TESTPATTERN_FPS` only affect the mock fleet.

### Windows, with your real phones

1. Open ADBoard in Chrome with `?perf=1` and show the grid with 1, 4, 8, then 12 phones.
2. In Task Manager, add the "GPU" and "Dedicated GPU memory" columns and note Chrome's CPU, memory and GPU. `chrome://gpu` shows whether video decode is hardware accelerated.
3. After two minutes, run `__adboardPerf.snapshot()` and note painted frames, dropped frames and the highest queue.
4. Leave it for 30 minutes and compare Chrome's memory with the start.
5. Unplug and replug a phone, and restart the agent, and note how long the picture takes to return.

### iPhone PWA

1. Open the installed app, then add `?perf=1` once in Safari (or set the localStorage key through Web Inspector).
2. With the iPhone connected to a Mac, Safari's Web Inspector (Develop menu) shows memory and timelines for the PWA.
3. Compare Control with one phone against the grid with several, and check that leaving Control for a few seconds and returning brings the picture back.

| Machine | Phones | CPU | Memory | GPU | GPU memory | Painted fps | Dropped | Memory after 30 min | Recovery |
|---|---|---|---|---|---|---|---|---|---|
| Windows | 1 | | | | | | | | |
| Windows | 4 | | | | | | | | |
| Windows | 8 | | | | | | | | |
| Windows | 12 | | | | | | | | |
| iPhone PWA | 1 | | | n/a | n/a | | | | |
| iPhone PWA | 4 | | | n/a | n/a | | | | |
