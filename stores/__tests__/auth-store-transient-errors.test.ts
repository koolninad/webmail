import { describe, it, expect } from 'vitest';
import { isTransientAuthError } from '../auth-store';
import { RateLimitError } from '@/lib/jmap/client';

// checkAuth evicts an account - dropping it from the registry AND deleting its
// server-side session cookie - for any restore failure it does not classify as
// transient. So this predicate decides whether a hiccup costs the user their
// saved mailboxes.
//
// The regression this guards: Stalwart answers 403 on /.well-known/jmap when it
// has auto-banned the client IP (`server.auto-ban auth.rate`). checkAuth
// re-authenticates every registered account on every page load, so N accounts x
// a few refreshes trips that limit routinely. Treating 403 as definitive wiped
// every mailbox on refresh and forced the user to re-add them by hand.

const sessionErr = (status: number) => new Error(`Failed to get session: ${status}`);
const refreshErr = (status: number) => new Error(`Session refresh failed: ${status}`);

describe('isTransientAuthError', () => {
  it('keeps the account when Stalwart auto-bans the client IP (403)', () => {
    expect(isTransientAuthError(sessionErr(403))).toBe(true);
    expect(isTransientAuthError(refreshErr(403))).toBe(true);
  });

  it('keeps the account when the server rate-limits (429)', () => {
    expect(isTransientAuthError(sessionErr(429))).toBe(true);
    expect(isTransientAuthError(refreshErr(429))).toBe(true);
    expect(isTransientAuthError(new RateLimitError(5000))).toBe(true);
  });

  it('keeps the account through server outages (5xx)', () => {
    for (const status of [500, 502, 503, 504]) {
      expect(isTransientAuthError(sessionErr(status))).toBe(true);
    }
  });

  it('keeps the account when the network is unreachable', () => {
    // fetch() rejects with TypeError when there is no connectivity.
    expect(isTransientAuthError(new TypeError('Failed to fetch'))).toBe(true);
  });

  it('evicts only on a definitive credential rejection', () => {
    expect(isTransientAuthError(sessionErr(400))).toBe(false);
    expect(isTransientAuthError(sessionErr(401))).toBe(false);
    // JMAPClient maps 401 to a prose message before the status-bearing branch,
    // so these must stay definitive too.
    expect(isTransientAuthError(new Error('Invalid username or password'))).toBe(false);
    expect(isTransientAuthError(new Error('Authentication failed - token may be expired'))).toBe(false);
  });

  it('leaves unrelated failures definitive', () => {
    // A missing session cookie is about our own cookie store, not the mail
    // server being unhappy - restoring can never succeed, so eviction is right.
    expect(isTransientAuthError(new Error('Session cookie missing: 404'))).toBe(false);
    expect(isTransientAuthError(new Error('TOTP_REQUIRED'))).toBe(false);
    expect(isTransientAuthError('not an error')).toBe(false);
    expect(isTransientAuthError(undefined)).toBe(false);
  });
});
