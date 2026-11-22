# Remote access (Nginx Proxy Manager + Cloudflare)

Back to the [README](../README.md).

ADBoard can be published on a hostname such as `adboard.example.com` behind Nginx Proxy Manager, with Cloudflare's proxy in front. The UI talks to the same origin and switches to `wss://` on HTTPS, so no URLs need changing.

**Create an account first.** Without one, ADBoard refuses to hand out its API token to any request that arrived through a proxy (it shows "Password required for remote access"). Anyone who reaches the site could otherwise control the phones, run ADB shell commands and browse host files.

- Open ADBoard on the host's own network (e.g. `http://127.0.0.1:3848`) and click **Set password** in the header, or start it once with `ADBOARD_PASSWORD` (username `admin`, or `ADBOARD_USERNAME`).
- Visitors through the proxy get a sign-in form (username and password). Sessions last 30 days in an HttpOnly, Secure, SameSite=Strict cookie.
- Signed-in users change the password from the **account name** in the header. That needs the current password and signs out every other browser.
- The account is stored as a salted PBKDF2-SHA256 hash in `config\auth.json` in the [data folder](storage.md) (`ADBOARD_AUTH_FILE` to move it). `ADBOARD_PASSWORD` only sets the first password; to recover a forgotten one, start with `ADBOARD_PASSWORD=… ADBOARD_RESET_PASSWORD=1`.
- `ADBOARD_ALLOW_PROXY_WITHOUT_PASSWORD=1` skips all of this when Cloudflare Access already guards the hostname.

On Windows: `.\Start-ADBoard.ps1 -Bind 0.0.0.0 -Password '…'` sets the first password. LAN access without a proxy keeps working without an account.

**Nginx Proxy Manager** (proxy host):
- Scheme `http`, forward to the ADBoard host, port `3848`. Turn on **Websockets Support**.
- SSL: request a certificate (or use a Cloudflare Origin certificate) and turn on **Force SSL**.
- Advanced tab, so long-lived video sockets are not cut:
  ```nginx
  proxy_read_timeout 3600s;
  proxy_send_timeout 3600s;
  proxy_buffering off;
  ```
- Use its own subdomain. Serving ADBoard under a path such as `example.com/adboard` is not supported.

**Cloudflare:**
- SSL/TLS mode **Full (strict)**; Network → **WebSockets** on (default).
- Turn **Rocket Loader off** (it rewrites scripts).
- Leave caching at defaults: ADBoard sends `no-cache` for the page, `sw.js` and the manifest, `no-store` for `/api/*`, and long-lived `immutable` caching only for hashed `/_next/static/*` files.
- Bot Fight Mode or "I'm Under Attack" can challenge the app's background requests; skip them for this hostname or use Cloudflare Access.
- Cloudflare Free and Pro accept at most 100 MB per request. ADBoard sends files over 64 MB in 32 MB chunks, so APK installs and file pushes up to 256 MB still work.
- Optional: firewall port 3848 so only the Nginx Proxy Manager host can reach it.

ADBoard pings every WebSocket every 25 s, under Cloudflare's 100 s and nginx's default 60 s idle limits, so a still phone screen does not drop the video. The API token never appears in URLs (browsers send it as a WebSocket subprotocol, servers as the `x-adboard-token` header), so it stays out of proxy and Cloudflare logs. Remote agents can join a controller published this way with `ADBOARD_CONTROLLER_URL=wss://adboard.example.com/ws/agent` and the same `ADBOARD_TOKEN` on both sides.
