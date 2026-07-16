/**
 * Retry semantics for fetchDocState — the fetch that gates the document
 * loading overlay and the weekly-planner first paint.
 *
 *   - 404 = "doc never saved": a definitive answer, no retry.
 *   - other 4xx (401, 403…) = deterministic: fail fast, no retry.
 *   - network errors / 5xx = transient (cold Fly machine, Neon resume):
 *     retried with backoff, then give up with null.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../http', () => {
  class HttpError extends Error {
    constructor(public status: number, public path: string) {
      super(`Backend responded ${status} for ${path}`);
    }
  }
  return { HttpError, apiFetch: vi.fn() };
});
vi.mock('../authToken', () => ({ getCachedToken: () => null }));

import { apiFetch, HttpError } from '../http';
import { fetchDocState } from '../backendSync';

const apiFetchMock = vi.mocked(apiFetch);

function okResponse(bytes: number[]): Response {
  return { arrayBuffer: async () => new Uint8Array(bytes).buffer } as unknown as Response;
}

beforeEach(() => {
  vi.useFakeTimers();
  apiFetchMock.mockReset();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('fetchDocState retry semantics', () => {
  it('returns the state bytes on first success', async () => {
    apiFetchMock.mockResolvedValueOnce(okResponse([1, 2, 3]));
    const result = await fetchDocState('doc-a');
    expect(result).toEqual(new Uint8Array([1, 2, 3]));
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });

  it('404 (never saved) returns null without retrying', async () => {
    apiFetchMock.mockRejectedValueOnce(new HttpError(404, '/documents/doc-a/state'));
    expect(await fetchDocState('doc-a')).toBeNull();
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });

  it('deterministic 4xx (401) fails fast without retrying', async () => {
    apiFetchMock.mockRejectedValueOnce(new HttpError(401, '/documents/doc-a/state'));
    expect(await fetchDocState('doc-a')).toBeNull();
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });

  it('recovers when a transient network error clears before retries run out', async () => {
    apiFetchMock
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(okResponse([9]));
    const pending = fetchDocState('doc-a');
    await vi.runAllTimersAsync();
    expect(await pending).toEqual(new Uint8Array([9]));
    expect(apiFetchMock).toHaveBeenCalledTimes(3);
  });

  it('retries 5xx (cold start) and gives up with null after the backoff schedule', async () => {
    apiFetchMock.mockRejectedValue(new HttpError(502, '/documents/doc-a/state'));
    const pending = fetchDocState('doc-a');
    await vi.runAllTimersAsync();
    expect(await pending).toBeNull();
    expect(apiFetchMock).toHaveBeenCalledTimes(4); // initial + one per backoff delay
  });
});
