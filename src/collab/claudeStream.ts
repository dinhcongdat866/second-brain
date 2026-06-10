import Anthropic from '@anthropic-ai/sdk';
type ThinkingConfigParam = Anthropic.Messages.ThinkingConfigParam;
import type * as Y from 'yjs';
import type { Turn } from './historyCompressor';
import { BACKEND_URL, OLLAMA_URL } from '../lib/config';
import { dataUrlToApiImage } from '../lib/imageResize';
import { supabase } from '../lib/supabase';

/**
 * Create an Anthropic client that routes through the backend proxy.
 *
 * The proxy now requires a Supabase JWT (it is no longer an open relay), so a
 * custom `fetch` attaches `Authorization: Bearer <token>` to every request.
 * The user's own Anthropic key is forwarded via `x-user-api-key`; the proxy
 * has no fallback key, so a request without it is rejected with 400.
 */
function makeClient(userApiKey?: string | null) {
  return new Anthropic({
    baseURL: `${BACKEND_URL}/anthropic`,
    apiKey: 'proxied-by-backend',
    dangerouslyAllowBrowser: true,
    ...(userApiKey ? { defaultHeaders: { 'x-user-api-key': userApiKey } } : {}),
    fetch: async (url, init) => {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      const headers = new Headers(init?.headers);
      if (token) headers.set('Authorization', `Bearer ${token}`);
      return fetch(url, { ...init, headers });
    },
  });
}

// ---------------------------------------------------------------------------
// Model config
// ---------------------------------------------------------------------------

// Anthropic model IDs are fixed; Ollama model IDs are "ollama:<name>" at runtime.
export type ModelId = string;

export type ModelConfig = {
  model: ModelId;
  thinking: boolean;       // adaptive thinking — Sonnet/Opus only
  webSearch: boolean;      // Anthropic only
  contextScope: 'local' | 'doc'; // local = 1 cell above + RAG; doc = full doc + weekly + RAG
};

export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  model: 'claude-sonnet-4-6',
  thinking: false,
  webSearch: false,
  contextScope: 'local',
};

export function isOllamaModel(id: ModelId): boolean {
  return id.startsWith('ollama:');
}

/** Strip the "ollama:" prefix to get the raw model name for Ollama API. */
export function ollamaModelName(id: ModelId): string {
  return id.slice('ollama:'.length);
}

export const MODELS = [
  {
    id:                'claude-haiku-4-5-20251001',
    label:             'Haiku',
    desc:              'fast & cheap',
    supportsThinking:  false,
    supportsWebSearch: true,
    provider:          'anthropic' as const,
  },
  {
    id:                'claude-sonnet-4-6',
    label:             'Sonnet',
    desc:              'balanced',
    supportsThinking:  true,
    supportsWebSearch: true,
    provider:          'anthropic' as const,
  },
  {
    id:                'claude-opus-4-8',
    label:             'Opus',
    desc:              'smartest',
    supportsThinking:  true,
    supportsWebSearch: true,
    provider:          'anthropic' as const,
  },
] as const;

// ---------------------------------------------------------------------------
// Ollama model discovery
// ---------------------------------------------------------------------------

export type OllamaModel = { id: string; name: string; sizeGb: number };

/** Fetch models currently installed in the local Ollama daemon. */
export async function fetchOllamaModels(): Promise<OllamaModel[]> {
  try {
    const resp = await fetch(`${OLLAMA_BASE}/api/tags`);
    if (!resp.ok) return [];
    const data = await resp.json() as { models?: { name: string; size: number }[] };
    return (data.models ?? []).map((m) => ({
      id:     `ollama:${m.name}`,
      name:   m.name,
      sizeGb: Math.round((m.size / 1e9) * 10) / 10,
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Usage / cost
// ---------------------------------------------------------------------------

export type UsageStats = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
};

// USD per token: [input, output, cache-read, cache-creation]
const ANTHROPIC_PRICE: Record<string, [number, number, number, number]> = {
  'claude-haiku-4-5-20251001': [0.80, 4,    0.08, 0.80].map(v => v / 1_000_000) as [number,number,number,number],
  'claude-sonnet-4-6':         [3,    15,   0.30, 3   ].map(v => v / 1_000_000) as [number,number,number,number],
  'claude-opus-4-8':           [15,   75,   1.50, 15  ].map(v => v / 1_000_000) as [number,number,number,number],
};

function calcCost(u: Omit<UsageStats, 'costUsd'>, model: ModelId): number {
  if (isOllamaModel(model)) return 0;
  const price = ANTHROPIC_PRICE[model];
  if (!price) return 0;
  const [pIn, pOut, pCacheRead, pCacheCreate] = price;
  return (
    u.inputTokens         * pIn +
    u.outputTokens        * pOut +
    u.cacheReadTokens     * pCacheRead +
    u.cacheCreationTokens * pCacheCreate
  );
}

// ---------------------------------------------------------------------------
// Ollama streaming
// ---------------------------------------------------------------------------

const OLLAMA_BASE = OLLAMA_URL;

async function streamOllamaReply(
  systemPrompt: string,
  messages: { role: 'user' | 'assistant'; content: string }[],
  modelName: string,
  target: Y.Text,
  signal?: AbortSignal,
): Promise<{ inputTokens: number; outputTokens: number }> {
  const resp = await fetch(`${OLLAMA_BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: modelName,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages,
      ],
      stream: true,
      options: { num_predict: 4096 },
    }),
    signal,
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Ollama ${resp.status}: ${body || resp.statusText}`);
  }

  const reader = resp.body!.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let inputTokens = 0;
  let outputTokens = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const chunk = JSON.parse(line) as {
          message?: { content?: string };
          done?: boolean;
          prompt_eval_count?: number;
          eval_count?: number;
        };
        if (chunk.message?.content) {
          target.insert(target.length, chunk.message.content);
        }
        if (chunk.done) {
          inputTokens  = chunk.prompt_eval_count ?? 0;
          outputTokens = chunk.eval_count        ?? 0;
        }
      } catch { /* skip malformed line */ }
    }
  }

  return { inputTokens, outputTokens };
}

// ---------------------------------------------------------------------------
// streamClaudeReply
// ---------------------------------------------------------------------------

export type SearchSource = { url: string; title: string };

export type StreamOptions = {
  ragContext?: string;
  /** Content from the user's Memory doc — injected as a separate cached system block. */
  memoryContext?: string;
  /** Personal analytics summary (last 30 days) — injected as a separate cached system block. */
  analyticsContext?: string;
  signal?: AbortSignal;
  config?: ModelConfig;
  /** Y.Text to stream thinking content into (Anthropic Sonnet/Opus only). */
  thinkingTarget?: Y.Text;
  /** Called with the web-search query string when Claude issues a search. */
  onSearching?: (query: string) => void;
  /** Called with the list of sources returned by the web search tool. */
  onSearchResults?: (sources: SearchSource[]) => void;
  /** Data-URL images attached to the current (last) user message. Anthropic only. */
  images?: string[];
  /** User's own Anthropic API key (from localStorage). Forwarded to backend proxy. */
  userApiKey?: string | null;
};

// ---------------------------------------------------------------------------
// Demo streaming (no API key configured)
// ---------------------------------------------------------------------------

const DEMO_TEXT = `## The Second Brain Method

A **second brain** is a personal knowledge management system — a trusted external repository for the ideas, insights, and resources you encounter every day.

### Why it works

Our brains are optimised for *generating* ideas, not *storing* them. By offloading information into an external system, you free up cognitive bandwidth for deeper thinking and unexpected creative connections.

### Core principles

1. **Capture** — Write down anything that resonates, quickly and without judgment
2. **Organise** — Sort notes into actionable categories (Projects, Areas, Resources, Archives)
3. **Distil** — Extract key insights and progressively summarise over time
4. **Express** — Use your notes as raw material to create, share, and build

### Getting started

Start small. Create one note today, then another tomorrow. The system grows naturally as you feed it.

> The goal isn't a perfect system. The goal is to think better.

Each note you write here is a building block. Over time, surprising connections will emerge between ideas you had months apart — that is when the magic happens.

---

*Add your Anthropic API key in the model settings panel to connect to real AI.*`;

/**
 * Simulates streaming by inserting the demo text character by character.
 * Used when no Anthropic API key is configured — lets visitors see the UI working.
 */
export async function streamDemoReply(
  target: Y.Text,
  onDone: (usage: UsageStats) => void,
  signal?: AbortSignal,
): Promise<void> {
  const CHUNK = 4; // chars per tick
  const DELAY = 18; // ms between ticks
  for (let i = 0; i < DEMO_TEXT.length; i += CHUNK) {
    if (signal?.aborted) break;
    target.insert(target.length, DEMO_TEXT.slice(i, i + CHUNK));
    await new Promise((r) => setTimeout(r, DELAY));
  }
  onDone({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 });
}

/**
 * Stream an AI response for the given thread history into `target` Y.Text.
 *
 * Routes to Ollama when `config.model` starts with "ollama:", otherwise uses
 * the Anthropic Messages API.  Ollama models ignore thinking/webSearch flags.
 */
export async function streamClaudeReply(
  localContext: string,
  docContext: string,
  turns: Turn[],
  target: Y.Text,
  onDone: (usage: UsageStats) => void,
  onError: (err: Error) => void,
  options: StreamOptions = {},
): Promise<void> {
  const { ragContext = '', memoryContext = '', analyticsContext = '', signal, config = DEFAULT_MODEL_CONFIG, thinkingTarget, onSearching, onSearchResults, images = [], userApiKey } = options;
  const client = makeClient(userApiKey);

  const baseContext =
    (localContext ? '--- CELLS ABOVE THIS AI CELL ---\n' + localContext + '\n\n' : '') +
    (docContext ? '--- FULL DOC (summary) ---\n' + docContext : '(empty notebook)');

  const systemText =
    'You are a helpful research assistant embedded in a personal knowledge notebook. ' +
    'Answer concisely and in the same language the user writes in. ' +
    'Prioritize the cells directly above this AI cell when answering, ' +
    'then use the broader context if needed.\n\n' +
    baseContext +
    (ragContext ? '\n\n--- RELATED NOTES FROM OTHER DOCS ---\n' + ragContext : '');

  // Ollama: no cache_control support, prepend memory + analytics to systemText.
  const ollamaSystemText = [
    memoryContext   ? '--- MEMORY ---\n'   + memoryContext   : '',
    analyticsContext                        ? analyticsContext : '',
    systemText,
  ].filter(Boolean).join('\n\n');

  // ---------------------------------------------------------------------------
  // Ollama branch
  // ---------------------------------------------------------------------------
  if (isOllamaModel(config.model)) {
    const messages = turns.map((t) => ({ role: t.role, content: t.content }));
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      ({ inputTokens, outputTokens } = await streamOllamaReply(
        ollamaSystemText,
        messages,
        ollamaModelName(config.model),
        target,
        signal,
      ));
      onDone({ inputTokens, outputTokens, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 });
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        onDone({ inputTokens, outputTokens, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 });
        return;
      }
      onError(err instanceof Error ? err : new Error(String(err)));
    }
    return;
  }

  // ---------------------------------------------------------------------------
  // Anthropic branch
  // ---------------------------------------------------------------------------
  const messages: Anthropic.MessageParam[] = turns.map((t, i) => {
    // Attach images to the current (last) user message only — we do not re-send
    // them on later turns (cost), so multi-turn follow-ups rely on the model's
    // first textual description.
    const isLast = i === turns.length - 1;
    if (isLast && t.role === 'user' && images.length > 0) {
      const blocks: Anthropic.ContentBlockParam[] = [];
      for (const url of images) {
        const img = dataUrlToApiImage(url);
        if (img) {
          blocks.push({
            type: 'image',
            source: { type: 'base64', media_type: img.media_type as 'image/jpeg', data: img.data },
          });
        }
      }
      blocks.push({ type: 'text', text: t.content });
      return { role: 'user', content: blocks };
    }
    return { role: t.role, content: t.content };
  });

  // System block order (most stable → least stable for optimal cache hit rate):
  //   1. Memory   — changes rarely; cache stays warm across many conversations
  //   2. Analytics — changes at most daily; cached separately from memory
  //   3. Main     — contains local/doc/RAG context; changes every message
  const system: Anthropic.TextBlockParam[] = [
    ...(memoryContext ? [{
      type: 'text' as const,
      text: '--- MEMORY ---\nThe following was written by you or learned over time. Use it as permanent background context:\n\n' + memoryContext,
      cache_control: { type: 'ephemeral' as const },
    }] : []),
    ...(analyticsContext ? [{
      type: 'text' as const,
      text: analyticsContext,
      cache_control: { type: 'ephemeral' as const },
    }] : []),
    {
      type: 'text',
      text: systemText,
      cache_control: { type: 'ephemeral' },
    },
  ];

  const thinkingEnabled = config.thinking && config.model !== 'claude-haiku-4-5-20251001';
  const thinkingParam: ThinkingConfigParam | undefined = thinkingEnabled
    ? { type: 'adaptive' }
    : undefined;

  const tools: Anthropic.ToolUnion[] = config.webSearch
    ? [{ type: 'web_search_20250305', name: 'web_search' }]
    : [];

  const maxTokens = thinkingEnabled ? 16000 : 4096;

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;

  const buildUsage = (): UsageStats => {
    const costUsd = calcCost({ inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens }, config.model);
    return { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, costUsd };
  };

  try {
    const stream = client.messages.stream(
      {
        model: config.model,
        max_tokens: maxTokens,
        system,
        messages,
        ...(thinkingParam && { thinking: thinkingParam }),
        ...(tools.length > 0 && { tools }),
      },
      { signal },
    );

    let searchInputBuf = '';
    let searchBlockIdx: number | null = null;

    for await (const event of stream) {
      const raw = event as unknown as Record<string, unknown>;

      if (event.type === 'message_start') {
        const u = event.message.usage;
        inputTokens         = u.input_tokens;
        cacheReadTokens     = u.cache_read_input_tokens     ?? 0;
        cacheCreationTokens = u.cache_creation_input_tokens ?? 0;

      } else if (event.type === 'content_block_start') {
        const block = raw['content_block'] as Record<string, unknown>;
        const blockType = block['type'] as string;

        if (blockType === 'server_tool_use' && block['name'] === 'web_search') {
          searchBlockIdx = event.index;
          searchInputBuf = '';
        } else if (blockType === 'web_search_tool_result') {
          const content = block['content'];
          if (Array.isArray(content)) {
            const sources = (content as Record<string, string>[])
              .filter((r) => r['type'] === 'web_search_result' && r['url'] && r['title'])
              .map((r) => ({ url: r['url'], title: r['title'] }));
            if (sources.length > 0) onSearchResults?.(sources);
          }
        }

      } else if (event.type === 'content_block_delta') {
        const delta = event.delta;
        if (delta.type === 'text_delta') {
          target.insert(target.length, delta.text);
        } else if (delta.type === 'thinking_delta' && thinkingTarget) {
          thinkingTarget.insert(thinkingTarget.length, delta.thinking);
        } else if (delta.type === 'input_json_delta' && searchBlockIdx !== null) {
          searchInputBuf += delta.partial_json;
        }

      } else if (event.type === 'content_block_stop') {
        if (searchBlockIdx !== null && event.index === searchBlockIdx) {
          try {
            const parsed = JSON.parse(searchInputBuf) as Record<string, string>;
            if (parsed['query']) onSearching?.(parsed['query']);
          } catch { /* malformed — ignore */ }
          searchBlockIdx = null;
          searchInputBuf = '';
        }

      } else if (event.type === 'message_delta') {
        outputTokens = event.usage.output_tokens;
      }
    }

    onDone(buildUsage());
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      onDone(buildUsage());
      return;
    }
    onError(err instanceof Error ? err : new Error(String(err)));
  }
}

// ---------------------------------------------------------------------------
// Memory extraction — fire-and-forget Haiku call after each assistant turn
// ---------------------------------------------------------------------------

/**
 * Ask Claude Haiku to extract memorable long-term facts from one exchange.
 * Returns bullet strings (without leading "- "), or [] if nothing notable.
 * Never throws — failures are silently ignored so they don't affect the chat.
 */
export async function extractMemorableFacts(
  userMessage: string,
  assistantMessage: string,
  existingMemory: string,
  userApiKey?: string | null,
): Promise<string[]> {
  try {
    const client = makeClient(userApiKey);
    const memorySection = existingMemory
      ? `Existing memory about this user:\n${existingMemory}\n\n`
      : 'Existing memory: (empty)\n\n';
    const prompt =
      memorySection +
      'New conversation exchange:\n' +
      `User: ${userMessage.slice(0, 600)}\n` +
      `Assistant: ${assistantMessage.slice(0, 1200)}\n\n` +
      'Extract ONLY facts that are genuinely new and not already captured in the existing memory above.\n' +
      'Focus on: preferences, personal context, ongoing projects, skills, goals, recurring patterns.\n' +
      'Ignore: one-off questions, generic knowledge, things already known, trivial details.\n' +
      'If nothing meaningfully new: respond with exactly: NOTHING\n' +
      'Otherwise respond with bullet points only, no preamble (- fact):';

    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = msg.content[0]?.type === 'text' ? msg.content[0].text.trim() : '';
    if (!text || text === 'NOTHING') return [];
    return text
      .split('\n')
      .map((l) => l.replace(/^[-•*]\s*/, '').trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}
