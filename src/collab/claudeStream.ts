import Anthropic from '@anthropic-ai/sdk';
import type * as Y from 'yjs';
import type { TurnRole } from './aiThreads';

const client = new Anthropic({
  apiKey: import.meta.env.VITE_ANTHROPIC_API_KEY as string,
  dangerouslyAllowBrowser: true,
});

type Turn = { role: TurnRole; content: string };

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
  onDone: () => void,
  onError: (err: Error) => void,
  ragContext = '',
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

  try {
    const stream = client.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system,
      messages,
    });

    for await (const event of stream) {
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        target.insert(target.length, event.delta.text);
      }
    }

    onDone();
  } catch (err) {
    onError(err instanceof Error ? err : new Error(String(err)));
  }
}
