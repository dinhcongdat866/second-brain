import { createClient } from '@supabase/supabase-js';

const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? '';
const key = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ?? '';

/** True when Supabase env vars are configured. */
export const supabaseConfigured = Boolean(url && key);

/**
 * Singleton Supabase client.
 * Falls back to a placeholder when env vars are missing so the app still
 * renders — initAuth will detect the missing config and set status to
 * 'unauthenticated' immediately.
 *
 * Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in .env.local
 */
export const supabase = createClient(
  url || 'https://placeholder.supabase.co',
  key || 'placeholder-key',
);
