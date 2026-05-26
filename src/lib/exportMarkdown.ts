import type { Node as PMNode } from 'prosemirror-model';
import type * as Y from 'yjs';

import { getAiThreads } from '../collab/aiThreads';

// ---------------------------------------------------------------------------
// Inline serialization
// ---------------------------------------------------------------------------

function serializeInline(node: PMNode): string {
  if (node.type.name === 'hard_break') return '\n';
  if (node.type.name !== 'text') return '';

  let text = node.text ?? '';
  const markNames = node.marks.map((m) => m.type.name);

  if (markNames.includes('code')) return `\`${text}\``;
  if (markNames.includes('strong')) text = `**${text}**`;
  if (markNames.includes('em')) text = `*${text}*`;
  if (markNames.includes('link')) {
    const href =
      node.marks.find((m) => m.type.name === 'link')?.attrs.href ?? '';
    text = `[${text}](${href})`;
  }

  return text;
}

// ---------------------------------------------------------------------------
// Block serialization
// ---------------------------------------------------------------------------

function serializeBlock(node: PMNode): string {
  const innerText = () => {
    const parts: string[] = [];
    node.forEach((child) => parts.push(serializeInline(child)));
    return parts.join('');
  };

  switch (node.type.name) {
    case 'paragraph':
      return innerText();

    case 'heading': {
      const hashes = '#'.repeat(node.attrs.level as number);
      return `${hashes} ${innerText()}`;
    }

    case 'blockquote': {
      const lines: string[] = [];
      node.forEach((child) => {
        serializeBlock(child)
          .split('\n')
          .forEach((line) => lines.push(`> ${line}`));
      });
      return lines.join('\n');
    }

    // Use ___ so --- stays reserved as cell separator
    case 'horizontal_rule':
      return '___';

    default:
      return innerText();
  }
}

// ---------------------------------------------------------------------------
// Cell serialization
// ---------------------------------------------------------------------------

function serializeMarkdownCell(cell: PMNode): string {
  const blocks: string[] = [];
  cell.forEach((block) => blocks.push(serializeBlock(block)));
  return blocks.join('\n\n');
}

function serializeAiCell(cellId: string, ydoc: Y.Doc): string {
  const threads = getAiThreads(ydoc);
  const thread = threads.get(cellId);
  if (!thread || thread.length === 0) return '';

  const parts: string[] = ['<!-- ai-cell -->'];
  for (const turn of thread.toArray()) {
    const role = turn.get('role') as string;
    const content = (turn.get('content') as Y.Text).toString().trim();
    if (!content) continue;
    const label = role === 'user' ? '**You:**' : '**AI:**';
    parts.push(`${label}\n\n${content}`);
  }
  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Serialize the full PM doc (markdown cells + AI threads) to a markdown string.
 * Cell separator: `\n\n---\n\n`
 * Horizontal rule in content: `___` (avoids collision with cell separator)
 * AI cell marker: `<!-- ai-cell -->`
 */
export function exportDocToMarkdown(
  doc: PMNode,
  ydoc: Y.Doc,
  docName: string,
): string {
  const cells: string[] = [];

  doc.forEach((cell) => {
    if (cell.type.name === 'markdown_cell') {
      const text = serializeMarkdownCell(cell).trim();
      if (text) cells.push(text);
    } else if (cell.type.name === 'ai_cell') {
      const text = serializeAiCell(cell.attrs.id as string, ydoc).trim();
      if (text) cells.push(text);
    }
  });

  const body = cells.join('\n\n---\n\n');
  return `# ${docName}\n\n${body}\n`;
}

/** Save a markdown string to disk via File System Access API or blob download. */
export async function saveMarkdownFile(
  content: string,
  docName: string,
): Promise<void> {
  const filename = `${docName.replace(/[^\w\-. ]/g, '_')}.md`;

  if ('showSaveFilePicker' in window) {
    try {
      const handle = await (
        window as Window & { showSaveFilePicker: Function }
      ).showSaveFilePicker({
        suggestedName: filename,
        types: [
          {
            description: 'Markdown file',
            accept: { 'text/markdown': ['.md'] },
          },
        ],
      });
      const writable = await handle.createWritable();
      await writable.write(content);
      await writable.close();
      return;
    } catch (err) {
      if ((err as DOMException).name === 'AbortError') return;
    }
  }

  // Fallback: invisible <a download>
  const blob = new Blob([content], { type: 'text/markdown; charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
