/**
 * Thin HTTP helper for the FastAPI backend.
 *
 * Injects the Supabase JWT as Authorization: Bearer <token> on every request
 * so the backend can authenticate the caller. Guest-mode requests carry no
 * token and will be rejected by auth-gated endpoints — callers in guest mode
 * should not hit those endpoints anyway.
 */

import { BACKEND_URL } from './config';
import { supabase } from './supabase';

export class HttpError extends Error {
  readonly status: number;
  readonly path: string;

  constructor(status: number, path: string) {
    super(`Backend responded ${status} for ${path}`);
    this.name = 'HttpError';
    this.status = status;
    this.path = path;
  }
}

/** fetch against the backend base URL; throws HttpError on a non-OK status. */
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;

  const headers = new Headers(init?.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const res = await fetch(`${BACKEND_URL}${path}`, { ...init, headers });
  if (!res.ok) throw new HttpError(res.status, path);
  return res;
}
