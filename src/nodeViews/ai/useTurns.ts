import { useEffect, useReducer } from 'react';
import * as Y from 'yjs';
import { type TurnRole, type YThread } from '../../collab/aiThreads';

export interface SearchSource {
  url: string;
  title: string;
}

/** A turn projected from Yjs into plain values for rendering. */
export interface TurnView {
  role: TurnRole;
  content: string;
  createdAt: string;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  thinking?: string;
  searchQuery?: string;
  searchSources?: SearchSource[];
  /** Data-URL images attached to a user turn. */
  images?: string[];
}

/**
 * Subscribe to a thread's Y.Array and project each turn into a plain TurnView.
 * Re-renders on any deep change (streaming token, new turn, metadata set).
 */
export function useTurns(thread: YThread): TurnView[] {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const handler = () => bump();
    thread.observeDeep(handler);
    return () => thread.unobserveDeep(handler);
  }, [thread]);

  return thread.toArray().map((turn) => {
    const thinkingYText = turn.get('thinking') as Y.Text | undefined;
    const rawSources = turn.get('search_sources') as string | undefined;
    const rawImages = turn.get('images') as string | undefined;
    return {
      role: turn.get('role') as TurnRole,
      content: (turn.get('content') as Y.Text).toString(),
      createdAt: (turn.get('created_at') as string) ?? '',
      tokensIn: turn.get('tokens_in') as number | undefined,
      tokensOut: turn.get('tokens_out') as number | undefined,
      costUsd: turn.get('cost_usd') as number | undefined,
      thinking: thinkingYText ? thinkingYText.toString() : undefined,
      searchQuery: (turn.get('search_query') as string | undefined) ?? undefined,
      searchSources: rawSources ? (JSON.parse(rawSources) as SearchSource[]) : undefined,
      images: rawImages ? (JSON.parse(rawImages) as string[]) : undefined,
    };
  });
}
