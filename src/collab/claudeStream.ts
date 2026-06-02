import Anthropic from '@anthropic-ai/sdk';
type ThinkingConfigParam = Anthropic.Messages.ThinkingConfigParam;
import type * as Y from 'yjs';
import type { Turn } from './historyCompressor';
import { BACKEND_URL, OLLAMA_URL } from '../lib/config';

// Calls go through the backend reverse proxy (`/anthropic`), which injects the
// real API key server-side. The key never ships in the browser bundle.
const client = new Anthropic({
  baseURL: `${BACKEND_URL}/anthropic`,
  apiKey: 'proxied-by-backend',
  dangerouslyAllowBrowser: true,
});

// ---------------------------------------------------------------------------
// Model config
// ---------------------------------------------------------------------------

// Anthropic model IDs are fixed; Ollama model IDs are "ollama:<name>" at runtime.
export type ModelId = string;

export type ModelConfig = {
  model: ModelId;
  thinking: boolean;   // adaptive thinking — Sonnet/Opus only
  webSearch: boolean;  // Anthropic only
};

export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  model: 'claude-sonnet-4-6',
  thinking: false,
  webSearch: false,
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
    desc:              'nhanh & rẻ',
    supportsThinking:  false,
    supportsWebSearch: true,
    provider:          'anthropic' as const,
  },
  {
    id:                'claude-sonnet-4-6',
    label:             'Sonnet',
    desc:              'cân bằng',
    supportsThinking:  true,
    supportsWebSearch: true,
    provider:          'anthropic' as const,
  },
  {
    id:                'claude-opus-4-8',
    label:             'Opus',
    desc:              'thông minh nhất',
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
  signal?: AbortSignal;
  config?: ModelConfig;
  /** Y.Text to stream thinking content into (Anthropic Sonnet/Opus only). */
  thinkingTarget?: Y.Text;
  /** Called with the web-search query string when Claude issues a search. */
  onSearching?: (query: string) => void;
  /** Called with the list of sources returned by the web search tool. */
  onSearchResults?: (sources: SearchSource[]) => void;
};

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
  const { ragContext = '', signal, config = DEFAULT_MODEL_CONFIG, thinkingTarget, onSearching, onSearchResults } = options;

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

  // ---------------------------------------------------------------------------
  // Ollama branch
  // ---------------------------------------------------------------------------
  if (isOllamaModel(config.model)) {
    const messages = turns.map((t) => ({ role: t.role, content: t.content }));
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      ({ inputTokens, outputTokens } = await streamOllamaReply(
        systemText,
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
  const messages: Anthropic.MessageParam[] = turns.map((t) => ({
    role: t.role,
    content: t.content,
  }));

  const system: Anthropic.TextBlockParam[] = [
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
