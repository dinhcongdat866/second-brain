import { create } from 'zustand';
import type { Session, User } from '@supabase/supabase-js';
import { supabase, supabaseConfigured } from '../lib/supabase';
import { clearUserStorage } from '../collab/ydoc';

export type AuthStatus = 'loading' | 'authenticated' | 'guest' | 'unauthenticated';

interface AuthState {
  status: AuthStatus;
  user: User | null;
  session: Session | null;
  signInWithGoogle: () => Promise<void>;
  signInWithEmail: (email: string, password: string) => Promise<void>;
  signUpWithEmail: (email: string, password: string) => Promise<{ error: string | null }>;
  continueAsGuest: () => void;
  signOut: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  status: 'loading',
  user: null,
  session: null,

  signInWithGoogle: async () => {
    await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    });
  },

  signInWithEmail: async (email, password) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw new Error(error.message);
  },

  signUpWithEmail: async (email, password) => {
    const { error } = await supabase.auth.signUp({ email, password });
    return { error: error?.message ?? null };
  },

  continueAsGuest: () => set({ status: 'guest', user: null, session: null }),

  signOut: async () => {
    if (get().status === 'guest') {
      set({ status: 'unauthenticated', user: null, session: null });
      return;
    }
    const userId = get().user?.id;
    await supabase.auth.signOut();
    // Clear local Yjs caches so the next user starts fresh from the server
    if (userId) await clearUserStorage(userId);
    set({ status: 'unauthenticated', user: null, session: null });
  },
}));

/**
 * Call once at app startup (main.tsx).
 * Bootstraps the session from Supabase and subscribes to future auth changes.
 */
export function initAuth(): void {
  // If Supabase isn't configured (no .env.local), skip straight to unauthenticated
  if (!supabaseConfigured) {
    useAuthStore.setState({ status: 'unauthenticated' });
    return;
  }

  // Restore existing session on load
  supabase.auth.getSession().then(({ data }) => {
    if (data.session) {
      useAuthStore.setState({
        status: 'authenticated',
        user: data.session.user,
        session: data.session,
      });
    } else {
      useAuthStore.setState({ status: 'unauthenticated' });
    }
  });

  // Keep store in sync with Supabase auth events (OAuth redirect, token refresh, sign-out)
  supabase.auth.onAuthStateChange((_event, session) => {
    if (session) {
      useAuthStore.setState({
        status: 'authenticated',
        user: session.user,
        session,
      });
    } else {
      // Don't overwrite guest mode when there's no Supabase session
      const current = useAuthStore.getState().status;
      if (current !== 'guest') {
        useAuthStore.setState({ status: 'unauthenticated', user: null, session: null });
      }
    }
  });
}
