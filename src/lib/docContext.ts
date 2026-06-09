import type { Node as PMNode } from 'prosemirror-model';
import type * as Y from 'yjs';
import { WEEKLY_PLANS_KEY, serializeWeeklyForAI } from '../collab/weeklyPlans';

/**
 * Tier 1 — local context: text from the N markdown cells immediately before
 * the given ai_cell. Small and on-point; always included.
 */
export function extractLocalContext(doc: PMNode, aiCellId: string, cellsBefore = 1): string {
  const cells: PMNode[] = [];
  doc.forEach((cell) => { cells.push(cell); });

  const aiIdx = cells.findIndex(
    (c) => c.type.name === 'ai_cell' && c.attrs.id === aiCellId,
  );
  if (aiIdx === -1) return '';

  return cells
    .slice(Math.max(0, aiIdx - cellsBefore), aiIdx)
    .filter((c) => c.type.name === 'markdown_cell')
    .map((c) => c.textContent.trim())
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Tier 2 — doc context: all markdown cells in the current doc, truncated to
 * avoid unbounded growth as the notebook accumulates months of entries.
 */
export function extractDocContext(doc: PMNode, maxChars = 1500): string {
  const lines: string[] = [];
  doc.forEach((cell) => {
    if (cell.type.name !== 'markdown_cell') return;
    cell.forEach((block) => {
      const text = block.textContent.trim();
      if (text) lines.push(text);
    });
  });
  const full = lines.join('\n\n');
  return full.length > maxChars ? full.slice(0, maxChars) + '\n…(truncated)' : full;
}

/**
 * Weekly planner context: serialize up to `maxWeeks` most-recent non-empty
 * weeks from all planner cells in the global planner Y.Doc.
 * Data is not filtered by the current document — the planner is global.
 */
export function extractWeeklyContext(plannerYdoc: Y.Doc, maxWeeks = 4): string {
  const plans = plannerYdoc.getMap<Y.Map<unknown>>(WEEKLY_PLANS_KEY);
  const parts: string[] = [];
  plans.forEach((plan) => {
    const serialized = serializeWeeklyForAI(plan, maxWeeks);
    if (serialized) parts.push(serialized);
  });
  return parts.join('\n\n');
}
