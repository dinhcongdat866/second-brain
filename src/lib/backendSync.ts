import type { Node as PMNode } from 'prosemirror-model';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? 'http://localhost:8000';

interface CellPayload {
  cell_id: string;
  doc_id: string;
  content: string;
}

function extractMarkdownCells(doc: PMNode, docId: string): CellPayload[] {
  const cells: CellPayload[] = [];
  doc.forEach((cell) => {
    if (cell.type.name !== 'markdown_cell') return;
    const content = cell.textContent.trim();
    if (!content) return;
    cells.push({ cell_id: cell.attrs.id as string, doc_id: docId, content });
  });
  return cells;
}

async function upsertCell(payload: CellPayload): Promise<void> {
  await fetch(`${BACKEND_URL}/embeddings/upsert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/** Embed a single user turn from an AI cell immediately (no debounce). */
export function upsertUserTurn(cellId: string, docId: string, text: string): void {
  const content = text.trim();
  if (!content) return;
  upsertCell({ cell_id: `${cellId}:u:${Date.now()}`, doc_id: docId, content }).catch(() => {});
}

/** Returns a debounced sync function. Call on every docChanged transaction. */
export function createDocSyncer(docId: string, debounceMs = 2000) {
  let timer: ReturnType<typeof setTimeout> | null = null;

  return function syncDoc(doc: PMNode): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const cells = extractMarkdownCells(doc, docId);
      for (const cell of cells) {
        upsertCell(cell).catch(() => {
          // backend unreachable during dev — silently ignore
        });
      }
    }, debounceMs);
  };
}
