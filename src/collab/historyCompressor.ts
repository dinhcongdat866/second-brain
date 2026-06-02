import Anthropic from '@anthropic-ai/sdk';
import type { TurnRole } from './aiThreads';
import type { ModelConfig } from './claudeStream';
import { BACKEND_URL, OLLAMA_URL } from '../lib/config';

// Routed through the backend reverse proxy — see claudeStream.ts.
const client = new Anthropic({
  baseURL: `${BACKEND_URL}/anthropic`,
  apiKey: 'proxied-by-backend',
  dangerouslyAllowBrowser: true,
});

/** Plain turn shape sent to the messages API. */
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

const TOKEN_THRESHOLD = 8_000;
const KEEP_RECENT = 6;

const SUMMARY_SYSTEM =
  'Tóm tắt ngắn gọn đoạn hội thoại dưới đây (tối đa 3-4 câu). ' +
  'Giữ lại: chủ đề chính, quyết định đã đưa ra, bối cảnh/tình huống của người dùng, ' +
  'và các chi tiết cụ thể có thể được nhắc đến về sau. ' +
  'Trả lời cùng ngôn ngữ với hội thoại.';

async function summarizeWithAnthropic(turns: Turn[], signal?: AbortSignal): Promise<string> {
  const dialogue = turns
    .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`)
    .join('\n\n');

  const resp = await client.messages.create(
    {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      system: SUMMARY_SYSTEM,
      messages: [{ role: 'user', content: dialogue }],
    },
    { signal },
  );

  return resp.content[0].type === 'text' ? resp.content[0].text : '';
}

async function summarizeWithOllama(turns: Turn[], modelName: string, signal?: AbortSignal): Promise<string> {
  const dialogue = turns
    .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`)
    .join('\n\n');

  const resp = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: modelName,
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM },
        { role: 'user', content: dialogue },
      ],
      stream: false,
      options: { num_predict: 512 },
    }),
    signal,
  });

  if (!resp.ok) throw new Error(`Ollama summarize ${resp.status}`);
  const data = await resp.json() as { message?: { content?: string } };
  return data.message?.content ?? '';
}

/**
 * Compress old conversation turns into a summary when the history grows large.
 *
 * When `config` specifies an Ollama model the summary is generated locally so
 * no conversation content leaves the machine.  Falls back to Anthropic Haiku
 * when no config is provided.
 */
export async function compressHistory(
  turns: Turn[],
  signal?: AbortSignal,
  config?: ModelConfig,
): Promise<Turn[]> {
  if (estimateTokens(turns) <= TOKEN_THRESHOLD || turns.length <= KEEP_RECENT) {
    return turns;
  }

  const oldTurns = turns.slice(0, -KEEP_RECENT);
  let recentTurns = turns.slice(-KEEP_RECENT);

  while (recentTurns.length > 0 && recentTurns[0].role === 'assistant') {
    recentTurns = recentTurns.slice(1);
  }
  if (recentTurns.length === 0) return turns;

  try {
    const useOllama = config?.model.startsWith('ollama:');
    const summary = useOllama
      ? await summarizeWithOllama(oldTurns, config!.model.slice('ollama:'.length), signal)
      : await summarizeWithAnthropic(oldTurns, signal);

    return [
      { role: 'user', content: `[Tóm tắt hội thoại trước]\n${summary}` },
      { role: 'assistant', content: 'Đã ghi nhận.' },
      ...recentTurns,
    ];
  } catch {
    return turns;
  }
}
