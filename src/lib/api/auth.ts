/**
 * Shared agent auth for HTTP and WebSocket calls.
 * The agent exposes GET /api/bootstrap (same-origin or allow-listed Origin)
 * and expects x-phonecontrol-token (or ?token= on WebSockets).
 */

let cachedToken: string | null = null;
let tokenPromise: Promise<string> | null = null;

export function agentBaseUrl(): string | null {
  const raw = process.env.NEXT_PUBLIC_AGENT_URL?.trim();
  if (!raw) return null;
  if (raw === "same" || raw === "same-origin") return "";
  return raw.replace(/\/$/, "");
}

export function httpToWs(base: string): string {
  if (!base && typeof window !== "undefined") {
    const proto = window.location.protocol === "https:" ? "wss://" : "ws://";
    return `${proto}${window.location.host}`;
  }
  if (base.startsWith("https://")) return `wss://${base.slice("https://".length)}`;
  if (base.startsWith("http://")) return `ws://${base.slice("http://".length)}`;
  return base;
}

export async function ensureAgentToken(): Promise<string | null> {
  const base = agentBaseUrl();
  if (base === null) return null;
  if (cachedToken) return cachedToken;
  if (!tokenPromise) {
    tokenPromise = fetch(`${base}/api/bootstrap`, { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) {
          throw new Error((await res.text()) || `bootstrap failed: ${res.status}`);
        }
        const body = (await res.json()) as { token?: string };
        if (!body.token) {
          throw new Error("bootstrap did not return a token");
        }
        cachedToken = body.token;
        return body.token;
      })
      .catch((error) => {
        tokenPromise = null;
        throw error;
      });
  }
  return tokenPromise;
}

export function agentTokenSync(): string | null {
  return cachedToken;
}

export function withAgentToken(url: string): string {
  if (!cachedToken) return url;
  if (url.includes("token=")) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}token=${encodeURIComponent(cachedToken)}`;
}

export async function agentFetch(input: string, init?: RequestInit): Promise<Response> {
  const token = await ensureAgentToken();
  const headers = new Headers(init?.headers);
  if (token) {
    headers.set("x-phonecontrol-token", token);
  }
  return fetch(input, { ...init, headers });
}

export async function agentWsUrl(pathAndQuery: string): Promise<string> {
  const base = agentBaseUrl();
  if (base === null) {
    throw new Error("agent is not configured");
  }
  await ensureAgentToken();
  const root = httpToWs(base);
  const path = pathAndQuery.startsWith("/") ? pathAndQuery : `/${pathAndQuery}`;
  return withAgentToken(`${root}${path}`);
}
