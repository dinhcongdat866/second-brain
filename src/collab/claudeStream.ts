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
  docContext: string,
  turns: Turn[],
  target: Y.Text,
  onDone: () => void,
  onError: (err: Error) => void,
): Promise<void> {
  const messages: Anthropic.MessageParam[] = turns.map((t) => ({
    role: t.role,
    content: t.content,
  }));

  try {
    const stream = client.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: [
        {
          type: 'text',
          text:
            'You are a helpful research assistant embedded in a personal knowledge notebook. ' +
            'Answer concisely and in the same language the user writes in. ' +
            'Use the notebook context below to ground your answers.\n\n' +
            '--- NOTEBOOK CONTEXT ---\n' +
            (docContext || '(empty notebook)'),
          cache_control: { type: 'ephemeral' },
        },
      ],
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
