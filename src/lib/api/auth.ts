/**
 * Shared agent auth for HTTP and WebSocket calls.
 * The agent exposes GET /api/bootstrap (same-origin or allow-listed Origin)
 * and expects x-adboard-token (a `adboard-token.<hex>` subprotocol on WebSockets).
 */

import { httpErrorMessage } from "@/lib/api/http-error";

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

/** Bootstrap answered 401: a password is set and this browser is not signed in. */
export class SignInRequiredError extends Error {}

export async function ensureAgentToken(): Promise<string | null> {
  const base = agentBaseUrl();
  if (base === null) return null;
  if (cachedToken) return cachedToken;
  if (!tokenPromise) {
    // credentials: the session cookie from /api/login (also cross-port in dev).
    tokenPromise = fetch(`${base}/api/bootstrap`, { cache: "no-store", credentials: "include" })
      .then(async (res) => {
        if (!res.ok) {
          const message = httpErrorMessage(res.status, await res.text(), `bootstrap failed: ${res.status}`);
          throw res.status === 401 ? new SignInRequiredError(message) : new Error(message);
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

/**
 * WebSocket subprotocols carrying the token. Browsers cannot set headers on a
 * WebSocket, and a ?token= query would end up in proxy and Cloudflare logs.
 * Hex keeps any ADBOARD_TOKEN value a valid protocol name.
 */
export function agentWsProtocols(): string[] {
  if (!cachedToken) return [];
  const hex = Array.from(new TextEncoder().encode(cachedToken), (b) => b.toString(16).padStart(2, "0")).join("");
  return ["adboard", `adboard-token.${hex}`];
}

export async function agentFetch(input: string, init?: RequestInit): Promise<Response> {
  const token = await ensureAgentToken();
  const headers = new Headers(init?.headers);
  if (token) {
    headers.set("x-adboard-token", token);
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
  return `${root}${path}`;
}

export interface AgentSession {
  authRequired: boolean;
  authenticated: boolean;
  /** Reached through a proxy while no password is configured. */
  proxyBlocked: boolean;
  username?: string | null;
  /** No account yet and this is a direct LAN visit: offer "Set password". */
  canSetPassword?: boolean;
}

export async function fetchAgentSession(): Promise<AgentSession | null> {
  const base = agentBaseUrl();
  if (base === null) return null;
  const res = await fetch(`${base}/api/session`, { cache: "no-store", credentials: "include" });
  // Older agents have no /api/session: behave as before (no sign-in).
  if (res.status === 404) return { authRequired: false, authenticated: false, proxyBlocked: false };
  if (!res.ok) throw new Error(httpErrorMessage(res.status, await res.text(), `session check failed: ${res.status}`));
  return (await res.json()) as AgentSession;
}

export async function signIn(username: string, password: string): Promise<void> {
  const base = agentBaseUrl() ?? "";
  const res = await fetch(`${base}/api/login`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) throw new Error(httpErrorMessage(res.status, await res.text(), `sign-in failed: ${res.status}`));
  cachedToken = null;
  tokenPromise = null;
}

export async function signOut(): Promise<void> {
  const base = agentBaseUrl() ?? "";
  try {
    await fetch(`${base}/api/logout`, { method: "POST", credentials: "include" });
  } finally {
    cachedToken = null;
    tokenPromise = null;
  }
}

/** Change the password (or set the first one on the LAN). Starts a new session. */
export async function changePassword(change: {
  currentPassword?: string;
  username?: string;
  newPassword: string;
}): Promise<void> {
  const base = agentBaseUrl() ?? "";
  const res = await fetch(`${base}/api/account/password`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(change),
  });
  if (!res.ok) throw new Error(httpErrorMessage(res.status, await res.text(), `password change failed: ${res.status}`));
  cachedToken = null;
  tokenPromise = null;
}

