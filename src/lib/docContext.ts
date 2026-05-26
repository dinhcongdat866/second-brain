import type { Node as PMNode } from 'prosemirror-model';

/** Extract a plain-text summary of the document for use as AI context. */
export function extractDocContext(doc: PMNode): string {
  const lines: string[] = [];
  doc.forEach((cell) => {
    cell.forEach((block) => {
      const text = block.textContent.trim();
      if (text) lines.push(text);
    });
  });
  return lines.join('\n\n');
}
