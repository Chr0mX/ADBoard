# Events and Discord notifications

ADBoard records what happens to your phones, macro runs and ADBoard itself, keeps that history across restarts, and can post the events you choose to a Discord channel.

## Events tab

**Events** in the desk header lists the history, newest first.

- **Last 24 hours:** warnings and errors, macro runs (done / failed / stopped and the success rate), phone connection changes, and whether Discord is delivering. Click a count to filter on it; click a phone under *Phones with problems* to see only its events.
- **Filters:** search (every word must appear in the summary, details, phone, macro name or run id), severity (*Warnings and errors*, *Errors only*…), category, phone, and time (last hour to 30 days, any time, or dates).
- **Details:** click an event for its reason, the macro, run id, step, cycles, touches and duration. **Only this phone**, **Whole run** (every event of that macro run), **Open phone** and **Open macro** jump to what it is about.
- **Macro runs:** for each macro over the last 24 hours, 7 or 30 days: runs, done / failed / stopped, success rate (bar), average length of finished runs, the last run, the steps that fail most (with the latest reason) and the phones they fail on. Click a macro's name to list its events, or **Open macro** to edit it. Figures come from the run events in the history, so they reach back as far as the history is kept.
- **Older events** loads the next 50. New events appear on their own while the tab is open.
- A number on the **Events** tab counts new warnings and errors since you last opened it.

Identical events close together (same kind, phone and text within 5 minutes) are shown once with ×N, so a phone that keeps dropping or a failing ADB poll can't flood the list.

### What is recorded

| Category | Events |
|---|---|
| Phones | phone tweaks and Shizuku starts, connected, went offline / disconnected, back online (with how long it was away), offline for longer than the alert time (when set), waiting for USB debugging approval, restart / power off / screen size results, screenshot and recording failures |
| Macros | started, finished, stopped, failed — with the run id, macro, phone, failing step and reason (for text steps: what was not found), cycles, touches and duration. Testing a single step is not recorded |
| Apps & installs | APK installed / failed per phone, uninstall, clear data, app launch and force-stop failures, **app crashed** (Java or native, read from each phone's crash buffer, with the first lines of the report), changes made in Apps → Controls (app ops, permissions, bucket, battery, network, state, intents) |
| Live screen | the scrcpy stream stopped (with its reason) and recovered |
| ADB | `adb devices` failures and other ADB notices |
| ADBoard | started (phones online), stopped, **did not shut down cleanly last time** (crash, closed window, power loss), internal errors, history problems |
| Notifications | webhook changed, test sent / failed, Discord delivery failing and recovered |

Routine successes (a screenshot, an app launch, a shell command) are not recorded; their failures are.

### Keeping history

History is saved in `logs\events.jsonl` in the data folder (one JSON object per line) and survives restarts. **Keep history** (bottom of the Events tab) sets how much is kept: up to 10 000 events and 30 days by default (100–200 000 events; 0 days = no age limit). The file is rewritten when it grows past the limit, so it never grows without bound. **Clear older than 7 days** and **Clear all** (type `clear` to confirm) delete history; settings and notifications are not affected.

If the file is damaged, the readable events are kept, the original is copied to `backups\corrupt\`, and an event says how many lines were skipped. If it can't be read at all, ADBoard keeps working with an in-memory history and records a warning.

## Discord

**Settings → Discord notifications**.

1. In Discord, open the channel's settings → **Integrations** → **Webhooks** → **New Webhook**, then **Copy Webhook URL**.
2. Paste it in **Webhook URL** and press **Save**. **Send test** first if you like: it sends to the URL in the box without saving it, or to the saved webhook when the box is empty.
3. Choose **What to send** for each category: *Off*, *Everything*, *Warnings and errors*, *Errors only* or *Critical only*.

The defaults send only what needs attention: phones going offline or waiting for approval, failed macros, failed installs, ADB failures and ADBoard crashes. Set **Macros** to *Everything* to also get finished and stopped runs.

| Setting | Meaning |
|---|---|
| Send notifications | Pause Discord without removing the webhook. Events are still recorded |
| Message detail | **Full**: reason, run id, duration, host. **Brief**: title, phone and severity |
| Cooldown | The same kind of event for the same phone is sent at most once per cooldown (default 2 min). The next message says how many were held back |
| Phone offline alerts | **Every drop** (default) sends each disconnect, as the Phones level allows. **Offline for N min** (2–60) sends a phone only once it has stayed offline (or waiting for USB approval) that long — "S24 has been offline for 10 min" — and sends "back online" when it returns. Short drops are still recorded in Events but not sent |

Each message is an embed coloured by severity, with the phone (and model), macro, severity and time; the footer names the ADBoard host and event kind. Events arriving within about 1.5 s go in one message (up to 10 embeds). Mentions are turned off, so text such as `@everyone` in a macro name never pings anyone.

Below the settings, ADBoard shows when it last delivered, how many were sent, failed, held back or dropped, and the last error.

### Delivery

- Messages are sent by ADBoard (the agent), not the browser, from a background queue. Sending never holds up device operations, macro runs or the history.
- Each request times out after 10 s. Discord rate limits (HTTP 429) are waited out as Discord asks; server errors and network failures are retried with 2, 4, 8 s waits. After 4 tries the message is dropped and counted as failed. A deleted webhook (404) or refused one (401/403) is not retried.
- A failing webhook is noted in the history at most every 10 minutes, and once more when it works again.
- If more than 256 events wait at once (Discord down for a long time during a flood), new ones are dropped and counted.
- On a multi-host setup each ADBoard sends its own events; configure the webhook on the controller only, or each host posts separately.

### Secrets

- The webhook URL is kept in `config\monitoring.json` in the data folder (readable by your user only on Linux), not in the settings shared with browsers. The API and the page only say whether a webhook is set and show the last digits of its id (…5678).
- Only `https://discord.com` (and `discordapp.com`, `ptb.`, `canary.`) webhook URLs are accepted. Error messages never repeat the URL.
- Every event is cleaned before it is stored or sent: webhook URLs and `token=`, `password=`, `secret=` style values are replaced with `[hidden]`.

## API

| Route | Does |
|---|---|
| `GET /api/events` | History, newest first. Query: `q`, `severity` (lowest shown), `category` (comma list), `device`, `run`, `since`, `until` (ms), `before` (paging cursor), `limit` (≤ 200). Returns `events`, `total`, `hasMore`, `nextBefore` |
| `GET /api/events/summary?since=` | Counts by severity and category, macro results, phones with problems, recent problems |
| `GET /api/events/macros?since=` | Per macro: runs, done / failed / stopped, success rate, average duration, last run, most failing steps, phones with failures (default: 7 days) |
| `POST /api/events/clear` `{before?}` | Delete all history, or events older than `before` (ms) |
| `GET /api/notifications` | Discord settings and delivery status (`webhookSet`, never the URL) |
| `PUT /api/notifications` | Change some of `enabled`, `webhookUrl` (`""` removes it), `categories`, `detail`, `cooldownSecs`, `offlineAlertMins` (0–1440, 0 = every drop), `history` |
| `POST /api/notifications/test` `{webhookUrl?}` | Send a test message now |

## Adding another destination

`crates/adboard-agent/src/notify.rs` keeps the rules (category levels, cooldown) and the queue apart from the Discord sender (`deliver_discord`). A generic webhook, Telegram or email would be another sender called from the same worker; events and their recording don't change.

## Limits

- ADBoard posts to Discord directly. It does not use `HTTPS_PROXY`, and a proxy that re-signs HTTPS with its own certificate makes delivery fail with "invalid peer certificate".
- History is per ADBoard process: a remote agent keeps its own events (phones on it still show on the controller's Events tab, because the controller sees them come and go).
- Clean-stop detection covers Ctrl+C, closing the console window on Windows and SIGTERM on Linux. Ending the process from Task Manager or `kill -9` counts as not shut down cleanly.
