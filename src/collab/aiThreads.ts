import * as Y from 'yjs';

/**
 * Top-level Y.Map key holding every AI conversation thread.
 * Lives in the Y.Doc alongside the ProseMirror XmlFragment, but separate from
 * it — the conversation is NOT part of the editable document tree.
 */
export const AI_THREADS_KEY = 'aiThreads';

export type TurnRole = 'user' | 'assistant';

/** A single conversation turn: Y.Map { role, content: Y.Text, created_at }. */
export type YTurn = Y.Map<unknown>;

/** A conversation thread for one ai_cell: an ordered list of turns. */
export type YThread = Y.Array<YTurn>;

/** All threads, keyed by ai_cell id. */
export function getAiThreads(ydoc: Y.Doc): Y.Map<YThread> {
  return ydoc.getMap<YThread>(AI_THREADS_KEY);
}

/**
 * Get the conversation thread for an ai_cell, creating it on first access.
 * Keeping it keyed by the cell's stable UUID means the thread survives the
 * cell moving around the document.
 */
export function getThread(ydoc: Y.Doc, cellId: string): YThread {
  const threads = getAiThreads(ydoc);
  let thread = threads.get(cellId);
  if (!thread) {
    thread = new Y.Array<YTurn>();
    threads.set(cellId, thread);
  }
  return thread;
}

/**
 * Append a turn to a thread. `content` is a Y.Text so an assistant reply can
 * be streamed token-by-token after creation. The turn is attached to the doc
 * (via push) before its text is filled — Yjs requires integration first.
 */
export function addTurn(thread: YThread, role: TurnRole, text = ''): YTurn {
  const turn: YTurn = new Y.Map();
  turn.set('role', role);
  turn.set('content', new Y.Text());
  turn.set('created_at', new Date().toISOString());
  thread.push([turn]);
  if (text) (turn.get('content') as Y.Text).insert(0, text);
  return turn;
}
