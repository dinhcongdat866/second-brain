import Anthropic from '@anthropic-ai/sdk';
type ThinkingConfigParam = Anthropic.Messages.ThinkingConfigParam;
import type * as Y from 'yjs';
import type { Turn } from './historyCompressor';

const client = new Anthropic({
  apiKey: import.meta.env.VITE_ANTHROPIC_API_KEY as string,
  dangerouslyAllowBrowser: true,
});

// ---------------------------------------------------------------------------
// Model config
// ---------------------------------------------------------------------------

export type ModelId =
  | 'claude-haiku-4-5-20251001'
  | 'claude-sonnet-4-6'
  | 'claude-opus-4-8';

export type ModelConfig = {
  model: ModelId;
  thinking: boolean;   // adaptive thinking — Sonnet/Opus only
  webSearch: boolean;
};

export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  model: 'claude-sonnet-4-6',
  thinking: false,
  webSearch: false,
};

export const MODELS = [
  {
    id:               'claude-haiku-4-5-20251001' as ModelId,
    label:            'Haiku',
    desc:             'nhanh & rẻ',
    supportsThinking: false,
  },
  {
    id:               'claude-sonnet-4-6' as ModelId,
    label:            'Sonnet',
    desc:             'cân bằng',
    supportsThinking: true,
  },
  {
    id:               'claude-opus-4-8' as ModelId,
    label:            'Opus',
    desc:             'thông minh nhất',
    supportsThinking: true,
  },
] as const;

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

// USD per token, per model (input / output / cache-read / cache-creation)
const MODEL_PRICE: Record<ModelId, [number, number, number, number]> = {
  'claude-haiku-4-5-20251001': [0.80, 4,    0.08, 0.80].map(v => v / 1_000_000) as [number,number,number,number],
  'claude-sonnet-4-6':         [3,    15,   0.30, 3   ].map(v => v / 1_000_000) as [number,number,number,number],
  'claude-opus-4-8':           [15,   75,   1.50, 15  ].map(v => v / 1_000_000) as [number,number,number,number],
};

function calcCost(u: Omit<UsageStats, 'costUsd'>, model: ModelId): number {
  const [pIn, pOut, pCacheRead, pCacheCreate] = MODEL_PRICE[model];
  return (
    u.inputTokens         * pIn +
    u.outputTokens        * pOut +
    u.cacheReadTokens     * pCacheRead +
    u.cacheCreationTokens * pCacheCreate
  );
}

// ---------------------------------------------------------------------------
// streamClaudeReply
// ---------------------------------------------------------------------------

export type SearchSource = { url: string; title: string };

export type StreamOptions = {
  ragContext?: string;
  signal?: AbortSignal;
  config?: ModelConfig;
  /** Y.Text to stream thinking content into (only when config.thinking = true). */
  thinkingTarget?: Y.Text;
  /** Called with the web-search query string when Claude issues a search. */
  onSearching?: (query: string) => void;
  /** Called with the list of sources returned by the web search tool. */
  onSearchResults?: (sources: SearchSource[]) => void;
};

/**
 * Stream a Claude response for the given thread history into `target` Y.Text.
 *
 * Optional capabilities (all off by default):
 *   - Adaptive thinking: set config.thinking = true (Sonnet / Opus only)
 *   - Web search: set config.webSearch = true
 *   - Custom model: set config.model
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

  const messages: Anthropic.MessageParam[] = turns.map((t) => ({
    role: t.role,
    content: t.content,
  }));

  // Tier 1 + 2 combined into one cached block.
  const baseContext =
    (localContext ? '--- CELLS ABOVE THIS AI CELL ---\n' + localContext + '\n\n' : '') +
    (docContext ? '--- FULL DOC (summary) ---\n' + docContext : '(empty notebook)');

  const system: Anthropic.TextBlockParam[] = [
    {
      type: 'text',
      text:
        'You are a helpful research assistant embedded in a personal knowledge notebook. ' +
        'Answer concisely and in the same language the user writes in. ' +
        'Prioritize the cells directly above this AI cell when answering, ' +
        'then use the broader context if needed.\n\n' +
        baseContext,
      cache_control: { type: 'ephemeral' },
    },
  ];

  if (ragContext) {
    system.push({
      type: 'text',
      text: '--- RELATED NOTES FROM OTHER DOCS ---\n' + ragContext,
    });
  }

  // Thinking: adaptive (recommended over 'enabled') — Haiku does not support it.
  const thinkingEnabled = config.thinking && config.model !== 'claude-haiku-4-5-20251001';
  const thinkingParam: ThinkingConfigParam | undefined = thinkingEnabled
    ? { type: 'adaptive' }
    : undefined;

  // Web search: built-in server-side tool, Anthropic runs it automatically.
  const tools: Anthropic.ToolUnion[] = config.webSearch
    ? [{ type: 'web_search_20250305', name: 'web_search' }]
    : [];

  // Thinking needs more headroom for max_tokens.
  const maxTokens = thinkingEnabled ? 16000 : 4096;

  // ---------------------------------------------------------------------------
  // Usage tracking
  // ---------------------------------------------------------------------------
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;

  const buildUsage = (): UsageStats => {
    const costUsd = calcCost({ inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens }, config.model);
    return { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, costUsd };
  };

  // ---------------------------------------------------------------------------
  // Stream
  // ---------------------------------------------------------------------------


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

    // Track server_tool_use input (streamed via input_json_delta, not available at block_start)
    let searchInputBuf = '';
    let searchBlockIdx: number | null = null;

    for await (const event of stream) {
      const raw = event as unknown as Record<string, unknown>;

      if (event.type === 'message_start') {
        const u = event.message.usage;
        inputTokens        = u.input_tokens;
        cacheReadTokens    = (u as unknown as Record<string, number>)['cache_read_input_tokens']    ?? 0;
        cacheCreationTokens = (u as unknown as Record<string, number>)['cache_creation_input_tokens'] ?? 0;

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
