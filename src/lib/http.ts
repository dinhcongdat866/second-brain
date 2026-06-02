/**
 * Thin HTTP helper for the FastAPI backend.
 *
 * Centralises the base URL and turns a non-OK response into a typed error, so
 * call sites stop string-concatenating `BACKEND_URL` and handle failures the
 * same way. Network errors reject as usual — each caller decides whether to
 * swallow them (most backend calls here are best-effort / fire-and-forget).
 */

import { BACKEND_URL } from './config';

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
  const res = await fetch(`${BACKEND_URL}${path}`, init);
  if (!res.ok) throw new HttpError(res.status, path);
  return res;
}
