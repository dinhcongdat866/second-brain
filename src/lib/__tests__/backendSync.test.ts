/**
 * Retry semantics for fetchDocSync — the fetch that gates the document
 * loading overlay and the weekly-planner first paint.
 *
 *   - 404 = "doc never saved": a definitive answer, no retry.
 *   - other 4xx (401, 403…) = deterministic: fail fast, no retry.
 *   - network errors / 5xx = transient (cold Fly machine, Neon resume):
 *     retried with backoff, then give up with null.
 *
 * Plus the framing that /sync uses to return a snapshot and its deltas in one
 * body — a bad split there would silently corrupt a document on load.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../http', () => {
  class HttpError extends Error {
    status: number;
    path: string;
    constructor(status: number, path: string) {
      super(`Backend responded ${status} for ${path}`);
      this.status = status;
      this.path = path;
    }
  }
  return { HttpError, apiFetch: vi.fn() };
});
vi.mock('../authToken', () => ({ getCachedToken: () => null }));

import { apiFetch, HttpError } from '../http';
import { fetchDocSync, parseSyncFrames } from '../backendSync';

const apiFetchMock = vi.mocked(apiFetch);

/** Build a /sync body: [4-byte big-endian length][bytes] per update. */
function framed(...updates: number[][]): ArrayBuffer {
  const total = updates.reduce((n, u) => n + 4 + u.length, 0);
  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  let off = 0;
  for (const u of updates) {
    view.setUint32(off, u.length);
    off += 4;
    bytes.set(u, off);
    off += u.length;
  }
  return buf;
}

function syncResponse(buf: ArrayBuffer, maxUpdateId = 0): Response {
  return {
    arrayBuffer: async () => buf,
    headers: { get: (k: string) => (k === 'X-Max-Update-Id' ? String(maxUpdateId) : null) },
  } as unknown as Response;
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

describe('parseSyncFrames', () => {
  it('splits a snapshot followed by its deltas', () => {
    const parsed = parseSyncFrames(framed([1, 2, 3], [4], [5, 6]));
    expect(parsed.map((u) => [...u])).toEqual([[1, 2, 3], [4], [5, 6]]);
  });

  it('returns nothing for an empty body', () => {
    expect(parseSyncFrames(new ArrayBuffer(0))).toEqual([]);
  });

  it('keeps the frames that parsed when the body is truncated', () => {
    const full = framed([1, 2, 3], [7, 7, 7, 7]);
    const cut = full.slice(0, full.byteLength - 2);
    expect(parseSyncFrames(cut).map((u) => [...u])).toEqual([[1, 2, 3]]);
  });
});

describe('fetchDocSync retry semantics', () => {
  it('returns the updates and the max id on first success', async () => {
    apiFetchMock.mockResolvedValueOnce(syncResponse(framed([1, 2, 3]), 7));
    const result = await fetchDocSync('doc-a');
    expect(result?.updates.map((u) => [...u])).toEqual([[1, 2, 3]]);
    expect(result?.maxUpdateId).toBe(7);
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });

  it('404 (never saved) returns null without retrying', async () => {
    apiFetchMock.mockRejectedValueOnce(new HttpError(404, '/documents/doc-a/sync'));
    expect(await fetchDocSync('doc-a')).toBeNull();
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });

  it('deterministic 4xx (401) fails fast without retrying', async () => {
    apiFetchMock.mockRejectedValueOnce(new HttpError(401, '/documents/doc-a/sync'));
    expect(await fetchDocSync('doc-a')).toBeNull();
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });

  it('recovers when a transient network error clears before retries run out', async () => {
    apiFetchMock
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(syncResponse(framed([9]), 2));
    const pending = fetchDocSync('doc-a');
    await vi.runAllTimersAsync();
    expect((await pending)?.updates.map((u) => [...u])).toEqual([[9]]);
    expect(apiFetchMock).toHaveBeenCalledTimes(3);
  });

  it('retries 5xx (cold start) and gives up with null after the backoff schedule', async () => {
    apiFetchMock.mockRejectedValue(new HttpError(502, '/documents/doc-a/sync'));
    const pending = fetchDocSync('doc-a');
    await vi.runAllTimersAsync();
    expect(await pending).toBeNull();
    expect(apiFetchMock).toHaveBeenCalledTimes(4); // initial + one per backoff delay
  });
});
