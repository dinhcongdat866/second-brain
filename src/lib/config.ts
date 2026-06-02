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

/** Debounce for persisting the Yjs doc to Neon. */
export const YJS_SAVE_DEBOUNCE_MS = 4_000;

/** Debounce for syncing markdown-cell text to the embeddings index. */
export const EMBED_DEBOUNCE_MS = 2_000;
