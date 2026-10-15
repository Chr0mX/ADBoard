"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/button";
import { changePassword, fetchAgentSession, signIn, signOut } from "@/lib/api/auth";

const MIN_PASSWORD = 8;

interface SessionInfo {
  /** An account exists, so Account / Sign out make sense. */
  authRequired: boolean;
  username: string | null;
  /** No account yet on a direct LAN visit: offer "Set password". */
  canSetPassword: boolean;
  signOut: () => void;
  openAccount: () => void;
}

const SessionContext = createContext<SessionInfo>({
  authRequired: false,
  username: null,
  canSetPassword: false,
  signOut: () => {},
  openAccount: () => {},
});

export function useAgentSessionInfo() {
  return useContext(SessionContext);
}

type GateState =
  | { kind: "checking" }
  | { kind: "ready"; authRequired: boolean; username: string | null; canSetPassword: boolean }
  | { kind: "signin" }
  | { kind: "blocked" };

/**
 * Shows the sign-in form when the agent has an account (remote access through
 * a reverse proxy), otherwise renders the app straight away.
 */
export function SignInGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GateState>({ kind: "checking" });
  const [accountOpen, setAccountOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchAgentSession()
      .then((session) => {
        if (cancelled) return;
        if (!session) setState({ kind: "ready", authRequired: false, username: null, canSetPassword: false });
        else if (session.proxyBlocked) setState({ kind: "blocked" });
        else if (session.authRequired && !session.authenticated) setState({ kind: "signin" });
        else
          setState({
            kind: "ready",
            authRequired: session.authRequired,
            username: session.username ?? null,
            canSetPassword: Boolean(session.canSetPassword),
          });
      })
      .catch(() => {
        // Agent unreachable: let the app show its own connection error.
        if (!cancelled) setState({ kind: "ready", authRequired: false, username: null, canSetPassword: false });
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
            ADBoard is being reached through a reverse proxy, but no password is set. Anyone who
            can open this address could control the phones.
          </p>
          <p className="text-sm leading-relaxed text-[var(--pc-muted)]">
            Open ADBoard on the host&apos;s own network and choose <strong className="text-[var(--pc-ink)]">Set password</strong>,
            or start it with{" "}
            <code className="font-mono text-[var(--pc-ink)] [overflow-wrap:anywhere]">PHONECONTROL_PASSWORD</code>. If
            Cloudflare Access already protects this address, set{" "}
            <code className="font-mono text-[var(--pc-ink)] [overflow-wrap:anywhere]">PHONECONTROL_ALLOW_PROXY_WITHOUT_PASSWORD=1</code>{" "}
            instead.
          </p>
        </Card>
      </Screen>
    );
  }
  if (state.kind === "signin") {
    return (
      <SignInForm
        onSignedIn={(username) => setState({ kind: "ready", authRequired: true, username, canSetPassword: false })}
      />
    );
  }

  const info: SessionInfo = {
    authRequired: state.authRequired,
    username: state.username,
    canSetPassword: state.canSetPassword,
    signOut: () => {
      void signOut().finally(() => window.location.reload());
    },
    openAccount: () => setAccountOpen(true),
  };
  return (
    <SessionContext.Provider value={info}>
      {children}
      {accountOpen && (
        <AccountDialog
          hasAccount={state.authRequired}
          username={state.username}
          onClose={() => setAccountOpen(false)}
          onSaved={(username) => {
            setAccountOpen(false);
            setState({ kind: "ready", authRequired: true, username, canSetPassword: false });
          }}
        />
      )}
    </SessionContext.Provider>
  );
}

const inputClass =
  "h-11 rounded-xl border border-[var(--pc-line)] bg-[var(--pc-paper)] px-3 text-[var(--pc-ink)] outline-none focus-visible:border-[var(--pc-accent)]";
const primaryClass =
  "h-11 rounded-xl bg-[var(--pc-accent-fill)] text-white hover:bg-[var(--pc-accent-fill)]/90";

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm text-[var(--pc-muted)]">
        {label}
      </label>
      {children}
    </div>
  );
}

function SignInForm({ onSignedIn }: { onSignedIn: (username: string) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!username.trim() || !password || busy) return;
    setBusy(true);
    setError(null);
    try {
      await signIn(username.trim(), password);
      onSignedIn(username.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed.");
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Card title="Sign in to ADBoard">
        <form onSubmit={submit} className="flex flex-col gap-3" data-sign-in>
          <Field id="adboard-username" label="Username">
            <input
              id="adboard-username"
              name="username"
              autoComplete="username"
              autoCapitalize="none"
              autoFocus
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              className={inputClass}
            />
          </Field>
          <Field id="adboard-password" label="Password">
            <input
              id="adboard-password"
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className={inputClass}
            />
          </Field>
          {error && (
            <p role="alert" className="text-sm text-[var(--pc-warn)]">
              {error}
            </p>
          )}
          <Button type="submit" disabled={busy || !username.trim() || !password} className={primaryClass}>
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </Card>
    </Screen>
  );
}

function AccountDialog({
  hasAccount,
  username,
  onClose,
  onSaved,
}: {
  hasAccount: boolean;
  username: string | null;
  onClose: () => void;
  onSaved: (username: string) => void;
}) {
  const [name, setName] = useState(username ?? "admin");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const problem =
    !name.trim()
      ? "Enter a username."
      : next.length < MIN_PASSWORD
        ? `Use at least ${MIN_PASSWORD} characters.`
        : next !== confirm
          ? "The new passwords do not match."
          : hasAccount && !current
            ? "Enter your current password."
            : null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (problem || busy) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await changePassword({
        currentPassword: hasAccount ? current : undefined,
        username: name.trim(),
        newPassword: next,
      });
      onSaved(name.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the password.");
      setBusy(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="adboard-account-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="flex w-full max-w-sm flex-col gap-4 rounded-2xl border border-[var(--pc-line)] bg-[var(--pc-panel)] p-6 shadow-lg">
        <h2 id="adboard-account-title" className="font-display text-xl font-bold tracking-tight text-[var(--pc-ink)]">
          {hasAccount ? "Change password" : "Set a password"}
        </h2>
        {!hasAccount && (
          <p className="text-sm leading-relaxed text-[var(--pc-muted)]">
            Required before ADBoard can be reached through a reverse proxy or Cloudflare. Anyone
            opening it from outside will have to sign in.
          </p>
        )}
        <form onSubmit={submit} className="flex flex-col gap-3" data-account-form>
          <Field id="adboard-account-username" label="Username">
            <input
              id="adboard-account-username"
              autoComplete="username"
              autoCapitalize="none"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className={inputClass}
            />
          </Field>
          {hasAccount && (
            <Field id="adboard-current-password" label="Current password">
              <input
                id="adboard-current-password"
                type="password"
                autoComplete="current-password"
                autoFocus
                value={current}
                onChange={(event) => setCurrent(event.target.value)}
                className={inputClass}
              />
            </Field>
          )}
          <Field id="adboard-new-password" label="New password">
            <input
              id="adboard-new-password"
              type="password"
              autoComplete="new-password"
              autoFocus={!hasAccount}
              value={next}
              onChange={(event) => setNext(event.target.value)}
              className={inputClass}
            />
          </Field>
          <Field id="adboard-confirm-password" label="Confirm new password">
            <input
              id="adboard-confirm-password"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              className={inputClass}
            />
          </Field>
          {hasAccount && (
            <p className="text-xs text-[var(--pc-muted)]">Other browsers signed in to ADBoard will be signed out.</p>
          )}
          {error && (
            <p role="alert" className="text-sm text-[var(--pc-warn)]">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={onClose} className="h-11 flex-1 rounded-xl text-[var(--pc-ink)]">
              Cancel
            </Button>
            <Button type="submit" disabled={busy} className={`${primaryClass} flex-1`}>
              {busy ? "Saving…" : hasAccount ? "Change password" : "Set password"}
            </Button>
          </div>
        </form>
      </section>
    </div>
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
