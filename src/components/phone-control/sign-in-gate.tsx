"use client";

import { createContext, useContext, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { fetchAgentSession, signIn, signOut } from "@/lib/api/auth";

interface SessionInfo {
  /** A password is configured, so a Sign out control makes sense. */
  authRequired: boolean;
  signOut: () => void;
}

const SessionContext = createContext<SessionInfo>({ authRequired: false, signOut: () => {} });

export function useAgentSessionInfo() {
  return useContext(SessionContext);
}

type GateState =
  | { kind: "checking" }
  | { kind: "ready"; authRequired: boolean }
  | { kind: "signin" }
  | { kind: "blocked" };

/**
 * Asks for the Rasiel password when the agent requires one (remote access
 * through a reverse proxy), otherwise renders the app straight away.
 */
export function SignInGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GateState>({ kind: "checking" });

  useEffect(() => {
    let cancelled = false;
    fetchAgentSession()
      .then((session) => {
        if (cancelled) return;
        if (!session) setState({ kind: "ready", authRequired: false });
        else if (session.proxyBlocked) setState({ kind: "blocked" });
        else if (session.authRequired && !session.authenticated) setState({ kind: "signin" });
        else setState({ kind: "ready", authRequired: session.authRequired });
      })
      .catch(() => {
        // Agent unreachable: let the app show its own connection error.
        if (!cancelled) setState({ kind: "ready", authRequired: false });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === "checking") {
    return <Screen><p className="font-mono text-xs text-[var(--pc-muted)]">Connecting…</p></Screen>;
  }
  if (state.kind === "blocked") {
    return (
      <Screen>
        <Card title="Password required for remote access">
          <p className="text-sm leading-relaxed text-[var(--pc-muted)]">
            Rasiel is being reached through a reverse proxy, but no password is set. Anyone who
            can open this address could control the phones.
          </p>
          <p className="text-sm leading-relaxed text-[var(--pc-muted)]">
            On the Rasiel host, set <code className="font-mono text-[var(--pc-ink)] [overflow-wrap:anywhere]">PHONECONTROL_PASSWORD</code>{" "}
            and restart it. If Cloudflare Access already protects this address, set{" "}
            <code className="font-mono text-[var(--pc-ink)] [overflow-wrap:anywhere]">PHONECONTROL_ALLOW_PROXY_WITHOUT_PASSWORD=1</code>{" "}
            instead.
          </p>
        </Card>
      </Screen>
    );
  }
  if (state.kind === "signin") {
    return <SignInForm onSignedIn={() => setState({ kind: "ready", authRequired: true })} />;
  }

  const info: SessionInfo = {
    authRequired: state.authRequired,
    signOut: () => {
      void signOut().finally(() => window.location.reload());
    },
  };
  return <SessionContext.Provider value={info}>{children}</SessionContext.Provider>;
}

function SignInForm({ onSignedIn }: { onSignedIn: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      await signIn(password);
      onSignedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed.");
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Card title="Sign in to Rasiel">
        <form onSubmit={submit} className="flex flex-col gap-3" data-sign-in>
          <label htmlFor="rasiel-password" className="text-sm text-[var(--pc-muted)]">
            Password
          </label>
          <input
            id="rasiel-password"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="h-11 rounded-xl border border-[var(--pc-line)] bg-[var(--pc-paper)] px-3 text-[var(--pc-ink)] outline-none focus-visible:border-[var(--pc-accent)]"
          />
          {error && (
            <p role="alert" className="text-sm text-[var(--pc-warn)]">
              {error}
            </p>
          )}
          <Button
            type="submit"
            disabled={busy || !password}
            className="h-11 rounded-xl bg-[var(--pc-accent-fill)] text-white hover:bg-[var(--pc-accent-fill)]/90"
          >
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </Card>
    </Screen>
  );
}

function Screen({ children }: { children: ReactNode }) {
  return (
    <div className="pc-shell fixed flex flex-col items-center justify-center overflow-auto p-4">
      <div className="pc-atmosphere" aria-hidden />
      <div className="relative z-10 flex w-full justify-center">{children}</div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex w-full max-w-sm flex-col gap-4 rounded-2xl border border-[var(--pc-line)] bg-[var(--pc-panel)] p-6 shadow-lg">
      <h1 className="font-display text-xl font-bold tracking-tight text-[var(--pc-ink)]">{title}</h1>
      {children}
    </section>
  );
}
