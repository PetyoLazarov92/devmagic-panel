import { ArrowLeft, ChevronRight, KeyRound, LoaderCircle, LockKeyhole, TriangleAlert } from 'lucide-react';
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { LoginArt } from '@/components/login-art';
import { Logo } from '@/components/logo';
import { CopyCommand, NewPassword, newPasswordOk } from '@/components/panel-password';
import { ThemeToggle } from '@/components/theme-toggle';
import { Button } from '@/components/ui/button';
import { PasswordInput } from '@/components/ui/password-input';
import { api, ApiError } from '@/lib/api';
import { timeAgo } from '@/lib/format';
import { navigate, usePath } from '@/lib/router';
import { cn } from '@/lib/utils';

interface Props {
  setupRequired: boolean;
  /** The computer account the panel runs as, from /api/session: the greeting and the password managers' user name. */
  user?: string;
  onLogin: () => void;
}

/** The reset of a forgotten password has its own address, so Back returns to the login and it can be reloaded. */
export const RESET_PATH = '/login/reset';

/** When this browser last signed in, kept in this browser only: the page tells nothing to anything else on the machine. */
const LAST_KEY = 'dmp-last-login';
const readLast = () => {
  try {
    return window.localStorage.getItem(LAST_KEY);
  } catch {
    return null;
  }
};
const noteLogin = () => {
  try {
    window.localStorage.setItem(LAST_KEY, new Date().toISOString());
  } catch {
    // Storage refused (a private window): the page only shows less.
  }
};

const greeting = (hour = new Date().getHours()) => (hour < 5 ? 'Good evening' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening');

/**
 * The login page: the brand panel on the left, the form in a column of its
 * own on the right, at most 360 px wide and centred. Below 768 px the panel
 * becomes a strip with the orbit only, and on a phone it goes. The password
 * reset takes the form's place at /login/reset; the panel stays.
 */
export function LoginPage({ setupRequired, user, onLogin }: Props) {
  const path = usePath();
  const resetting = path === RESET_PATH && !setupRequired;
  const [typing, setTyping] = useState(false);
  const [wasReset, setWasReset] = useState(false);
  // Where Back to log in goes: the page you were on before the reset.
  const before = useRef('/sites');

  const openReset = () => {
    before.current = window.location.pathname === RESET_PATH ? '/sites' : `${window.location.pathname}${window.location.search}`;
    navigate(RESET_PATH);
  };
  const closeReset = (done: boolean) => {
    setWasReset(done);
    navigate(before.current);
  };

  return (
    <div className="grid min-h-svh md:grid-cols-[minmax(0,45fr)_minmax(0,55fr)]">
      <aside className="hidden items-center justify-center bg-[oklch(0.25_0.09_285)] p-10 md:flex">
        <LoginArt className="w-full max-w-[520px]" paused={typing} reset={resetting} />
      </aside>

      <main className="relative flex flex-col items-center justify-center px-6 py-12">
        <ThemeToggle className="absolute top-4 right-4" />
        <div className="w-full max-w-[360px]">
          <div className="mb-6 hidden rounded-xl bg-[oklch(0.25_0.09_285)] px-4 sm:block md:hidden">
            <LoginArt variant="orbit" className="mx-auto h-28" paused={typing} reset={resetting} />
          </div>
          <Logo className="mb-6 size-10" />

          {setupRequired ? (
            <SetupFirst />
          ) : resetting ? (
            <ResetPassword onDone={() => closeReset(true)} onBack={() => closeReset(false)} />
          ) : (
            <>
              <h1 className="text-2xl font-semibold tracking-tight">{greeting()}{user ? `, ${user}` : ''}</h1>
              <p className="mt-1 text-sm text-muted-foreground">Log in to your local sites.</p>
              {wasReset && <p role="status" className="mt-5 rounded-lg border border-success/30 bg-success/8 px-4 py-3 text-sm">Password reset. Log in with the new one.</p>}
              <LoginForm
                className="mt-6"
                {...(user ? { user } : {})}
                onTyping={setTyping}
                onLogin={onLogin}
                onForgot={openReset}
              />
            </>
          )}
        </div>
      </main>
    </div>
  );
}

function SetupFirst() {
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Set a panel password first</h1>
      <p className="mt-2 text-sm text-muted-foreground">The panel has no password yet. On a terminal, run:</p>
      <div className="mt-4"><CopyCommand command="node ~/.local/share/devmagic-panel/current/server/dist/cli.js setup" /></div>
      <p className="mt-3 text-xs text-muted-foreground">It asks for a password and the MySQL account, then this page lets you in.</p>
    </>
  );
}

type Ways = Awaited<ReturnType<typeof api.resetWays>>;
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/**
 * A forgotten panel password: reset with the password of this computer
 * account (sudo checks it; it only shows where sudo asks this account for a
 * password, so it proves who you are), or in a terminal.
 */
function ResetPassword({ onDone, onBack }: { onDone: () => void; onBack: () => void }) {
  const [ways, setWays] = useState<Ways | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [system, setSystem] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.resetWays().then(setWays, (err: Error) => setLoadError(err.message));
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.resetPassword(system, next);
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setSystem('');
      // A lock that just started shows itself.
      void api.resetWays().then(setWays, () => undefined);
    } finally {
      setBusy(false);
    }
  }

  const locked = ways?.lockedUntil;
  return (
    <div className="text-sm">
      <button type="button" onClick={onBack} className="mb-4 inline-flex items-center gap-1.5 text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" />Back to log in
      </button>
      <h1 className="text-2xl font-semibold tracking-tight">Reset your password</h1>
      <p className="mt-1 text-muted-foreground">
        {ways && !ways.system ? 'Set a new one in a terminal.' : 'Prove it is you with the password you log in to this computer with.'} Every browser signed in to the panel is signed out.
      </p>

      {loadError && <p role="alert" className="mt-5 text-danger">{loadError}</p>}
      {!ways && !loadError && <p className="mt-5 flex items-center gap-2 text-muted-foreground"><LoaderCircle className="size-4 animate-spin" />Checking what this computer allows...</p>}

      {ways?.system && (
        <form className="mt-6 grid gap-4" onSubmit={(e) => void submit(e)} autoComplete="off">
          <div className="grid gap-1.5">
            <label htmlFor="reset-system" className="font-medium">Computer password</label>
            <PasswordInput id="reset-system" autoComplete="off" data-1p-ignore data-lpignore="true" autoFocus value={system} onChange={(e) => setSystem(e.target.value)} disabled={busy || Boolean(locked)} />
            <p className="text-xs text-muted-foreground">The one you use with sudo. sudo checks it; the panel never keeps it.</p>
          </div>
          <NewPassword id="reset" value={next} repeat={repeat} onValue={setNext} onRepeat={setRepeat} disabled={busy || Boolean(locked)} />
          {locked && <p role="alert" className="text-danger">Too many attempts: try again after {clock(locked)}, or use a terminal.</p>}
          {error && !locked && <p role="alert" className="text-danger">{error}</p>}
          <Button type="submit" className="w-full" disabled={busy || Boolean(locked) || !system || !newPasswordOk(next, repeat)}>
            {busy ? <LoaderCircle className="animate-spin" /> : <KeyRound />}
            Reset password
          </Button>
        </form>
      )}

      {ways && (
        ways.system ? (
          <details className="group mt-5 text-muted-foreground">
            <summary className="flex cursor-pointer list-none items-center gap-1 text-xs [&::-webkit-details-marker]:hidden">
              <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
              Or use a terminal
            </summary>
            <div className="mt-2 grid gap-2 text-xs">
              <p>It asks for the new password twice:</p>
              <CopyCommand command={ways.command} />
            </div>
          </details>
        ) : (
          <div className="mt-5 grid gap-2">
            <p className="text-xs text-muted-foreground">Your computer password cannot reset it here ({ways.reason ?? 'sudo cannot check it'}). Run this; it asks for the new password twice:</p>
            <CopyCommand command={ways.command} />
          </div>
        )
      )}
    </div>
  );
}

/**
 * The password form, on the login page and in the dialog that opens when a
 * session ends. A hidden user name lets password managers file the entry
 * under this account; Caps Lock shows; too many wrong tries count down.
 */
export function LoginForm({ onLogin, className, user, onTyping, onForgot }: {
  onLogin: () => void;
  className?: string;
  user?: string;
  /** Told while you type (until 1.5 seconds after the last key), so the brand panel can hold still. */
  onTyping?: (typing: boolean) => void;
  /** Shown as Forgot your password? when given. */
  onForgot?: () => void;
}) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [caps, setCaps] = useState(false);
  const [shake, setShake] = useState(0);
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const field = useRef<HTMLInputElement>(null);
  const idle = useRef<number | undefined>(undefined);
  const last = readLast();
  // The field has focus from the start, so focus alone says nothing: typing does.
  const typed = () => {
    onTyping?.(true);
    window.clearTimeout(idle.current);
    idle.current = window.setTimeout(() => onTyping?.(false), 1500);
  };
  useEffect(() => () => window.clearTimeout(idle.current), []);

  // The countdown of a lockout, once a second until it ends.
  useEffect(() => {
    if (!retryAt) return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= retryAt) {
        setRetryAt(null);
        setError(null);
        field.current?.focus();
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [retryAt]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      noteLogin();
      onLogin();
    } catch (err) {
      const at = err instanceof ApiError && err.status === 429 && typeof err.data.retryAt === 'string' ? Date.parse(err.data.retryAt) : NaN;
      if (Number.isFinite(at)) {
        setRetryAt(at);
        setNow(Date.now());
      } else {
        setError((err as Error).message);
        setShake((n) => n + 1);
      }
      setPassword('');
      setBusy(false);
      field.current?.focus();
    }
  }

  const keys = (event: KeyboardEvent<HTMLInputElement>) => setCaps(event.getModifierState('CapsLock'));
  const left = retryAt ? Math.max(0, Math.ceil((retryAt - now) / 1000)) : 0;
  const countdown = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;

  return (
    <form key={shake} onSubmit={submit} className={cn(className, shake > 0 && 'login-shake')}>
      {/* For password managers: which account this password belongs to. */}
      <input type="text" name="username" autoComplete="username" value={user ?? ''} readOnly hidden />
      <label htmlFor="password" className="mb-2 block text-sm font-medium">Password</label>
      <PasswordInput
        ref={field}
        id="password"
        autoComplete="current-password"
        autoFocus
        value={password}
        onChange={(e) => {
          setPassword(e.target.value);
          typed();
        }}
        onKeyDown={keys}
        onKeyUp={keys}
        onBlur={() => setCaps(false)}
        disabled={retryAt !== null}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || retryAt ? 'login-error' : caps ? 'login-caps' : undefined}
      />
      {caps && (
        <p id="login-caps" className="mt-2 flex items-center gap-1.5 text-xs text-warning">
          <TriangleAlert className="size-3.5" />Caps Lock is on
        </p>
      )}
      {(error || retryAt) && (
        <p id="login-error" role="alert" className="mt-2 text-sm text-danger">
          {retryAt ? `Too many attempts. Try again in ${countdown}.` : error}
        </p>
      )}
      <Button type="submit" className="mt-4 w-full" disabled={busy || password.length === 0 || retryAt !== null}>
        {busy ? <LoaderCircle className="animate-spin" /> : <LockKeyhole />}
        Log in
      </Button>
      {(onForgot || last) && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>{last ? `Last signed in ${timeAgo(last)} on this browser` : ''}</span>
          {onForgot && (
            <button type="button" onClick={onForgot} className="font-medium text-foreground underline-offset-4 hover:underline">
              Forgot your password?
            </button>
          )}
        </div>
      )}
    </form>
  );
}
