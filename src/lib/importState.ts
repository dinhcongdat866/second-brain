import type { Node as PMNode } from 'prosemirror-model';
import type { TurnRole } from '../collab/aiThreads';

export interface ImportedThread {
  cellId: string;
  turns: Array<{ role: TurnRole; content: string }>;
}

export interface PendingImport {
  pmDoc: PMNode;
  threads: ImportedThread[];
}

let pending: PendingImport | null = null;

export function setPendingImport(data: PendingImport): void {
  pending = data;
}

/** Consume once — returns the pending import and clears it. */
export function consumePendingImport(): PendingImport | null {
  const d = pending;
  pending = null;
  return d;
}
