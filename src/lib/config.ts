/**
 * Central runtime configuration.
 *
 * Single place every env var and tunable constant is read, so endpoints and
 * timings live in one file instead of being re-declared across modules.
 */

const env = import.meta.env;

/** Strip trailing slashes so `${URL}/path` never produces a `//` (which 404s). */
const trimUrl = (url: string) => url.replace(/\/+$/, '');

/** FastAPI backend (RAG, Yjs persistence, Anthropic reverse-proxy). */
export const BACKEND_URL = trimUrl(
  (env.VITE_BACKEND_URL as string | undefined) ?? 'http://localhost:8000',
);

/** y-websocket sync relay. */
export const WS_URL = trimUrl(
  (env.VITE_WS_URL as string | undefined) ?? 'ws://localhost:1234',
);

/** Local Ollama daemon (optional, privacy provider). */
export const OLLAMA_URL = trimUrl(
  (env.VITE_OLLAMA_URL as string | undefined) ?? 'http://localhost:11434',
);

// --- Timings (ms) ---------------------------------------------------------

/**
 * Default per-request timeout for `apiFetch`.
 *
 * `fetch` has no timeout of its own: a production machine that is waking up can
 * accept the connection and then never answer, leaving the promise pending
 * forever. Every request therefore carries an AbortSignal — endpoints that
 * legitimately run longer (LLM calls, blob uploads) pass their own value.
 */
export const API_TIMEOUT_MS = 30_000;

/**
 * Timeout for the Yjs state fetch. Deliberately short: it runs on the document
 * load path, and failing fast is cheap now that the editor binds from the
 * IndexedDB cache first and merges server state in the background.
 */
export const STATE_FETCH_TIMEOUT_MS = 8_000;

/** Timeout for saving Yjs state / uploading images — large bodies, slow uplinks. */
export const UPLOAD_TIMEOUT_MS = 60_000;

/** Timeout for backend endpoints that call an LLM and stream nothing back. */
export const LLM_TIMEOUT_MS = 180_000;

/** Debounce for persisting the Yjs doc to Neon. */
export const YJS_SAVE_DEBOUNCE_MS = 4_000;

/** Debounce for syncing markdown-cell text to the embeddings index. */
export const EMBED_DEBOUNCE_MS = 2_000;
