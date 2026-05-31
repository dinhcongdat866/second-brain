import Anthropic from '@anthropic-ai/sdk';
import type * as Y from 'yjs';
import type { Turn } from './historyCompressor';

const client = new Anthropic({
  apiKey: import.meta.env.VITE_ANTHROPIC_API_KEY as string,
  dangerouslyAllowBrowser: true,
});

export type UsageStats = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
};

// Pricing for claude-sonnet-4-6 (USD per token)
const PRICE = {
  input:           3    / 1_000_000,
  output:          15   / 1_000_000,
  cacheRead:       0.30 / 1_000_000,
  cacheCreation:   3    / 1_000_000,
} as const;

function calcCost(u: Omit<UsageStats, 'costUsd'>): number {
  return (
    u.inputTokens         * PRICE.input +
    u.outputTokens        * PRICE.output +
    u.cacheReadTokens     * PRICE.cacheRead +
    u.cacheCreationTokens * PRICE.cacheCreation
  );
}

/**
 * Stream a Claude response for the given thread history into `target` Y.Text.
 * The system prompt (doc context) is prompt-cached so repeated queries against
 * the same notebook content cost ~10% of full price after the first call.
 */
export async function streamClaudeReply(
  localContext: string,
  docContext: string,
  turns: Turn[],
  target: Y.Text,
  onDone: (usage: UsageStats) => void,
  onError: (err: Error) => void,
  ragContext = '',
  signal?: AbortSignal,
): Promise<void> {
  const messages: Anthropic.MessageParam[] = turns.map((t) => ({
    role: t.role,
    content: t.content,
  }));

  // Tier 1 + 2 combined into one cached block — stable for the same doc state.
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
    // Not cached — changes per query based on semantic search results.
    system.push({
      type: 'text',
      text: '--- RELATED NOTES FROM OTHER DOCS ---\n' + ragContext,
    });
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;

  const buildUsage = (): UsageStats => {
    const costUsd = calcCost({ inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens });
    return { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, costUsd };
  };

  try {
    const stream = client.messages.stream(
      { model: 'claude-sonnet-4-6', max_tokens: 2048, system, messages },
      { signal },
    );

    for await (const event of stream) {
      if (event.type === 'message_start') {
        const u = event.message.usage;
        inputTokens        = u.input_tokens;
        cacheReadTokens    = (u as Record<string, number>)['cache_read_input_tokens']    ?? 0;
        cacheCreationTokens = (u as Record<string, number>)['cache_creation_input_tokens'] ?? 0;
      } else if (event.type === 'message_delta') {
        outputTokens = event.usage.output_tokens;
      } else if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        target.insert(target.length, event.delta.text);
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
