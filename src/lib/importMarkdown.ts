import type { Node as PMNode } from 'prosemirror-model';

import { notebookSchema } from '../schema';
import { setPendingImport, type ImportedThread } from './importState';

// ---------------------------------------------------------------------------
// File reading
// ---------------------------------------------------------------------------

async function pickAndReadFile(): Promise<{ text: string; name: string } | null> {
  if ('showOpenFilePicker' in window) {
    try {
      const [handle] = await (
        window as Window & { showOpenFilePicker: Function }
      ).showOpenFilePicker({
        types: [
          {
            description: 'Markdown file',
            accept: { 'text/markdown': ['.md'], 'text/plain': ['.md', '.txt'] },
          },
        ],
        multiple: false,
      });
      const file = await handle.getFile();
      return {
        text: await file.text(),
        name: (file.name as string).replace(/\.md$/i, ''),
      };
    } catch (err) {
      if ((err as DOMException).name === 'AbortError') return null;
    }
  }

  // Fallback: hidden <input type="file">
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.md,.txt';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      resolve({ text: await file.text(), name: file.name.replace(/\.md$/i, '') });
    };
    input.click();
  });
}

// ---------------------------------------------------------------------------
// Inline mark parsing
// ---------------------------------------------------------------------------

function parseInline(text: string): PMNode[] {
  if (!text) return [];
  const schema = notebookSchema;
  const nodes: PMNode[] = [];
  // Priority: code > bold > italic > link
  const re = /`([^`]+)`|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|\[([^\]]+)\]\(([^)]+)\)/g;
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(schema.text(text.slice(last, m.index)));

    if (m[1] !== undefined) {
      nodes.push(schema.text(m[1], [schema.marks.code.create()]));
    } else if (m[2] !== undefined) {
      nodes.push(schema.text(m[2], [schema.marks.strong.create()]));
    } else if (m[3] !== undefined) {
      nodes.push(schema.text(m[3], [schema.marks.em.create()]));
    } else {
      nodes.push(schema.text(m[4], [schema.marks.link.create({ href: m[5] })]));
    }
    last = m.index + m[0].length;
  }

  if (last < text.length) nodes.push(schema.text(text.slice(last)));
  return nodes;
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

function parseCellText(cellText: string): PMNode[] {
  const schema = notebookSchema;
  const blocks: PMNode[] = [];

  // Group consecutive non-blank lines into block groups
  const lineGroups: string[][] = [];
  let cur: string[] = [];
  for (const line of cellText.split('\n')) {
    if (line.trim() === '') {
      if (cur.length > 0) {
        lineGroups.push(cur);
        cur = [];
      }
    } else {
      cur.push(line);
    }
  }
  if (cur.length > 0) lineGroups.push(cur);

  for (const group of lineGroups) {
    const first = group[0];

    // Heading (single-line only)
    const hm = first.match(/^(#{1,3}) (.+)$/);
    if (hm && group.length === 1) {
      const inline = parseInline(hm[2]);
      blocks.push(
        schema.nodes.heading.create(
          { level: hm[1].length },
          inline.length > 0 ? inline : undefined,
        ),
      );
      continue;
    }

    // Horizontal rule: ___, * * *, ***
    if (group.length === 1 && /^[_*]{3}$/.test(first.replace(/ /g, ''))) {
      blocks.push(schema.nodes.horizontal_rule.create());
      continue;
    }

    // Blockquote: all lines start with "> "
    if (group.every((l) => l.startsWith('> '))) {
      const innerText = group.map((l) => l.slice(2)).join(' ');
      const inner = schema.nodes.paragraph.create(null, parseInline(innerText));
      blocks.push(schema.nodes.blockquote.create(null, inner));
      continue;
    }

    // Paragraph — join multi-line with a space
    const combined = group.join(' ');
    const inline = parseInline(combined);
    blocks.push(
      schema.nodes.paragraph.create(null, inline.length > 0 ? inline : undefined),
    );
  }

  return blocks.length > 0 ? blocks : [schema.nodes.paragraph.create()];
}

// ---------------------------------------------------------------------------
// AI conversation parsing
// ---------------------------------------------------------------------------

function parseAiTurns(
  text: string,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const turns: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  let currentRole: 'user' | 'assistant' | null = null;
  let buf: string[] = [];

  const flush = () => {
    if (!currentRole) return;
    const c = buf.join('\n').trim();
    if (c) turns.push({ role: currentRole, content: c });
    buf = [];
  };

  for (const line of text.split('\n')) {
    if (line === '**You:**') {
      flush();
      currentRole = 'user';
    } else if (line === '**AI:**') {
      flush();
      currentRole = 'assistant';
    } else {
      buf.push(line);
    }
  }
  flush();

  return turns;
}

// ---------------------------------------------------------------------------
// PM node factories
// ---------------------------------------------------------------------------

function makeMarkdownCell(blocks: PMNode[]): PMNode {
  const now = new Date().toISOString();
  return notebookSchema.nodes.markdown_cell.create(
    { id: crypto.randomUUID(), created_at: now, updated_at: now },
    blocks,
  );
}

function makeAiCell(): { node: PMNode; id: string } {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  return {
    node: notebookSchema.nodes.ai_cell.create({ id, created_at: now, updated_at: now }),
    id,
  };
}

// ---------------------------------------------------------------------------
// Parse a full markdown file
// ---------------------------------------------------------------------------

interface ParseResult {
  title: string;
  pmDoc: PMNode;
  threads: ImportedThread[];
}

function parseMarkdownFile(text: string, fallbackName: string): ParseResult {
  const lines = text.split('\n');
  let title = fallbackName;
  let bodyStart = 0;

  if (lines[0].startsWith('# ')) {
    title = lines[0].slice(2).trim();
    bodyStart = 1;
    while (bodyStart < lines.length && lines[bodyStart].trim() === '') bodyStart++;
  }

  const body = lines.slice(bodyStart).join('\n');
  const rawBlocks = body
    .split(/\n[ \t]*---[ \t]*\n/)
    .map((b) => b.trim())
    .filter(Boolean);

  const pmCells: PMNode[] = [];
  const threads: ImportedThread[] = [];

  for (const block of rawBlocks) {
    if (block.startsWith('<!-- ai-cell -->')) {
      const { node, id } = makeAiCell();
      pmCells.push(node);
      const rest = block.slice('<!-- ai-cell -->'.length).trimStart();
      const turns = parseAiTurns(rest);
      if (turns.length > 0) threads.push({ cellId: id, turns });
    } else {
      pmCells.push(makeMarkdownCell(parseCellText(block)));
    }
  }

  if (pmCells.length === 0) {
    pmCells.push(makeMarkdownCell([notebookSchema.nodes.paragraph.create()]));
  }

  const pmDoc = notebookSchema.nodes.doc.create(null, pmCells);
  return { title, pmDoc, threads };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Open a file picker, parse the chosen .md file, and create a new document
 * pre-populated with the file content.
 *
 * Flow:
 *   1. User picks a file.
 *   2. File is parsed into a PM doc + AI thread data.
 *   3. Data is stored in importState (module-level pending).
 *   4. `importDoc(title)` is called — creates the registry entry and navigates.
 *   5. `useNotebookEditor` re-initialises with the new docId, consumes the
 *      pending import, and seeds the fresh Y.Doc with the parsed content.
 *
 * Returns true if the import was started, false if the user cancelled.
 */
export async function importMarkdownAsNewDoc(
  importDoc: (name: string) => void,
): Promise<boolean> {
  const file = await pickAndReadFile();
  if (!file) return false;

  const { title, pmDoc, threads } = parseMarkdownFile(file.text, file.name);

  // Store data for useNotebookEditor to consume on next init
  setPendingImport({ pmDoc, threads });

  // Create new doc + navigate (triggers useNotebookEditor re-init)
  importDoc(title);

  return true;
}
