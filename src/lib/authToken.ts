/**
 * Synchronously-readable cache of the current Supabase access token.
 *
 * Teardown handlers (pagehide / visibilitychange) cannot await
 * supabase.auth.getSession(), so we keep a plain mirror of the token that is
 * updated on every auth state change (initial load, token refresh, sign-out).
 * This is what lets a keepalive beacon attach `Authorization: Bearer <token>`
 * without an async hop — sendBeacon/keepalive on a dying page has no time to
 * resolve a promise.
 */
import { supabase } from './supabase';

let cachedToken: string | null = null;

supabase.auth.getSession().then(({ data }) => {
  cachedToken = data.session?.access_token ?? null;
});

// Fires on SIGNED_IN, TOKEN_REFRESHED, SIGNED_OUT, etc. — keeps the mirror fresh
// as Supabase silently rotates the JWT (~hourly), so the token is never stale.
supabase.auth.onAuthStateChange((_event, session) => {
  cachedToken = session?.access_token ?? null;
});

/** Current access token, read synchronously. Null when signed out / not yet loaded. */
export function getCachedToken(): string | null {
  return cachedToken;
}
