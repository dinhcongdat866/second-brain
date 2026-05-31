import Anthropic from '@anthropic-ai/sdk';
import type { TurnRole } from './aiThreads';

const client = new Anthropic({
  apiKey: import.meta.env.VITE_ANTHROPIC_API_KEY as string,
  dangerouslyAllowBrowser: true,
});

/** Plain turn shape sent to the Claude messages API. */
export type Turn = { role: TurnRole; content: string };

/**
 * Rough token estimate: ~4 chars per token (works for both English and
 * Vietnamese).  Used only to decide whether to compress, so precision does
 * not matter.
 */
export function estimateTokens(turns: Turn[]): number {
  const chars = turns.reduce((sum, t) => sum + t.content.length, 0);
  return Math.ceil(chars / 4);
}

const TOKEN_THRESHOLD = 8_000; // compress when history exceeds this
const KEEP_RECENT = 6;         // always keep the last N turns verbatim

async function summarizeOldTurns(turns: Turn[], signal?: AbortSignal): Promise<string> {
  const dialogue = turns
    .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`)
    .join('\n\n');

  const resp = await client.messages.create(
    {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      system:
        'Tóm tắt ngắn gọn đoạn hội thoại dưới đây (tối đa 3-4 câu). ' +
        'Giữ lại: chủ đề chính, quyết định đã đưa ra, bối cảnh/tình huống của người dùng, ' +
        'và các chi tiết cụ thể có thể được nhắc đến về sau. ' +
        'Trả lời cùng ngôn ngữ với hội thoại.',
      messages: [{ role: 'user', content: dialogue }],
    },
    { signal },
  );

  return resp.content[0].type === 'text' ? resp.content[0].text : '';
}

/**
 * Compress old conversation turns into a summary when the history grows large.
 *
 * Strategy (Option 2 — summarize + slide):
 *   - Keep the last KEEP_RECENT turns verbatim.
 *   - Replace everything older with a synthetic summary exchange so Claude
 *     retains long-term context without paying for full token cost.
 *   - Falls back to the original array on any error.
 *
 * The returned array always starts with a 'user' turn (required by the
 * Anthropic messages API alternation rule).
 */
export async function compressHistory(
  turns: Turn[],
  signal?: AbortSignal,
): Promise<Turn[]> {
  if (estimateTokens(turns) <= TOKEN_THRESHOLD || turns.length <= KEEP_RECENT) {
    return turns;
  }

  const oldTurns = turns.slice(0, -KEEP_RECENT);
  let recentTurns = turns.slice(-KEEP_RECENT);

  // The window must start with 'user' to satisfy Anthropic's alternation rule.
  while (recentTurns.length > 0 && recentTurns[0].role === 'assistant') {
    recentTurns = recentTurns.slice(1);
  }
  if (recentTurns.length === 0) return turns;

  try {
    const summary = await summarizeOldTurns(oldTurns, signal);
    return [
      { role: 'user', content: `[Tóm tắt hội thoại trước]\n${summary}` },
      { role: 'assistant', content: 'Đã ghi nhận.' },
      ...recentTurns,
    ];
  } catch {
    // Network error, AbortError, etc. — degrade gracefully by sending full history.
    return turns;
  }
}
