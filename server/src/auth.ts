import { createHash, randomBytes } from 'node:crypto';
import type { SessionStore } from './store.js';

/**
 * Login sessions, kept in the panel's database so a restart (an update)
 * leaves you signed in. Only a hash of each token is stored, with a hash of
 * the panel password's hash: a new password ends every session made with the
 * old one. The cookie lasts until the browser closes; a session unused for
 * 12 hours ends.
 */
export const SESSION_COOKIE = 'dmp_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** A session used again is extended at most this often, so a page's requests do not each write to the database. */
const EXTEND_EVERY_MS = 60_000;

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

export class Sessions {
  constructor(
    private readonly store: SessionStore,
    /** The current panel password hash; without one no session is valid. */
    private readonly passwordHash: () => string | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  create(): string {
    const password = this.passwordHash();
    if (!password) throw new Error('no panel password');
    const token = randomBytes(32).toString('base64url');
    this.store.purgeSessions(this.now());
    this.store.putSession(sha256(token), { password: sha256(password), expiresAt: this.now() + SESSION_TTL_MS });
    return token;
  }

  /** True for a live session made with the current password; extends it on use. */
  touch(token: string | undefined): boolean {
    const password = this.passwordHash();
    if (!token || !password) return false;
    const key = sha256(token);
    const session = this.store.getSession(key);
    if (!session) return false;
    if (session.expiresAt < this.now() || session.password !== sha256(password)) {
      this.store.deleteSession(key);
      return false;
    }
    const expiresAt = this.now() + SESSION_TTL_MS;
    if (expiresAt - session.expiresAt >= EXTEND_EVERY_MS) this.store.putSession(key, { ...session, expiresAt });
    return true;
  }

  destroy(token: string | undefined): void {
    if (token) this.store.deleteSession(sha256(token));
  }
}

/**
 * The limit for checking the computer password on the login page: every
 * client of the panel is 127.0.0.1, so it counts failures from anywhere, and 5
 * in 15 minutes lock it for an hour.
 */
export class GlobalLock {
  private failures: number[] = [];
  private lockedUntil = 0;

  constructor(
    private readonly limit = 5,
    private readonly windowMs = 15 * 60 * 1000,
    private readonly lockMs = 60 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  /** When the lock ends, while it holds. */
  until(): number | undefined {
    return this.lockedUntil > this.now() ? this.lockedUntil : undefined;
  }

  fail(): void {
    const since = this.now() - this.windowMs;
    this.failures = [...this.failures.filter((t) => t > since), this.now()];
    if (this.failures.length >= this.limit) {
      this.lockedUntil = this.now() + this.lockMs;
      this.failures = [];
    }
  }
}

/** Failed-login limiter: 10 failures per 15 minutes per client. */
export class LoginLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly limit = 10,
    private readonly windowMs = 15 * 60 * 1000,
    private readonly now: () => number = Date.now,
  ) {}

  blocked(client: string): boolean {
    return this.recent(client).length >= this.limit;
  }

  fail(client: string): void {
    this.failures.set(client, [...this.recent(client), this.now()]);
  }

  reset(client: string): void {
    this.failures.delete(client);
  }

  /** When a blocked client may try again: once its oldest failure in the window is out of it. */
  retryAt(client: string): number {
    const [oldest] = this.recent(client);
    return (oldest ?? this.now()) + this.windowMs;
  }

  private recent(client: string): number[] {
    const since = this.now() - this.windowMs;
    return (this.failures.get(client) ?? []).filter((t) => t > since);
  }
}
