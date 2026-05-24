/**
 * Convergence tests — CRDT correctness for the notebook's Yjs layer.
 *
 * Strategy: create 2–3 Y.Doc "peers" forked from a common seed, let each make
 * independent changes while "offline", exchange updates, then assert both docs
 * arrive at identical state.
 *
 * No browser, no ProseMirror EditorView — pure Yjs. Tests cover:
 *   - XmlFragment (what ySyncPlugin binds PM doc into)
 *   - aiThreads   (Y.Map/Y.Array that lives outside the PM doc)
 *   - seedIfEmpty  (initial-content helper)
 */

import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';

import { getThread, addTurn } from '../aiThreads';
import { seedIfEmpty, XML_FRAGMENT_NAME } from '../ydoc';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Clone a Y.Doc into a fresh peer — simulates a client joining with full state. */
function fork(source: Y.Doc): Y.Doc {
  const peer = new Y.Doc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(source));
  return peer;
}

/**
 * Exchange only the delta each side is missing.
 * After this call both docs are in the same CRDT state.
 */
function sync(a: Y.Doc, b: Y.Doc): void {
  const aToB = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b));
  const bToA = Y.encodeStateAsUpdate(b, Y.encodeStateVector(a));
  Y.applyUpdate(b, aToB);
  Y.applyUpdate(a, bToA);
}

/** Serialise a doc's XmlFragment to a comparable string (deleted items excluded). */
function xmlOf(doc: Y.Doc): string {
  return doc.getXmlFragment(XML_FRAGMENT_NAME).toString();
}

/**
 * Build a minimal seeded doc without going through ProseMirror (no DOM needed):
 *   XmlFragment → markdown_cell → paragraph → XmlText(initialText)
 */
function makeSeededDoc(initialText = ''): Y.Doc {
  const doc = new Y.Doc();
  const frag = doc.getXmlFragment(XML_FRAGMENT_NAME);
  const cell = new Y.XmlElement('markdown_cell');
  const para = new Y.XmlElement('paragraph');
  if (initialText) para.insert(0, [new Y.XmlText(initialText)]);
  cell.insert(0, [para]);
  frag.insert(0, [cell]);
  return doc;
}

/** Navigate fragment → cell[0] → paragraph[0] → XmlText[0]. */
function getFirstText(doc: Y.Doc): Y.XmlText {
  const frag = doc.getXmlFragment(XML_FRAGMENT_NAME);
  const cell = frag.get(0) as Y.XmlElement;
  const para = cell.get(0) as Y.XmlElement;
  return para.get(0) as Y.XmlText;
}

// ---------------------------------------------------------------------------
// XmlFragment convergence (what ySyncPlugin syncs)
// ---------------------------------------------------------------------------

describe('XmlFragment convergence', () => {
  it('concurrent cell inserts: both cells appear in both peers', () => {
    const base = makeSeededDoc('seed');
    const peerA = fork(base);
    const peerB = fork(base);
    base.destroy();

    const fragA = peerA.getXmlFragment(XML_FRAGMENT_NAME);
    const fragB = peerB.getXmlFragment(XML_FRAGMENT_NAME);

    peerA.transact(() => {
      const cell = new Y.XmlElement('markdown_cell');
      cell.setAttribute('data-id', 'cell-a');
      fragA.insert(fragA.length, [cell]);
    });

    peerB.transact(() => {
      const cell = new Y.XmlElement('markdown_cell');
      cell.setAttribute('data-id', 'cell-b');
      fragB.insert(fragB.length, [cell]);
    });

    sync(peerA, peerB);

    const finalA = xmlOf(peerA);
    const finalB = xmlOf(peerB);

    // Primary: byte-identical convergence
    expect(finalA).toBe(finalB);
    // Both cells from both peers are present (seed + A + B)
    expect(fragA.length).toBe(3);
    expect(finalA).toContain('cell-a');
    expect(finalA).toContain('cell-b');
  });

  it('concurrent text edits in the same XmlText both survive', () => {
    const base = makeSeededDoc('hello');
    const peerA = fork(base);
    const peerB = fork(base);
    base.destroy();

    const textA = getFirstText(peerA);
    const textB = getFirstText(peerB);

    // Each peer appends to the shared XmlText while offline
    peerA.transact(() => textA.insert(textA.length, ' from-A'));
    peerB.transact(() => textB.insert(textB.length, ' from-B'));

    sync(peerA, peerB);

    const finalA = xmlOf(peerA);
    const finalB = xmlOf(peerB);

    expect(finalA).toBe(finalB);
    // Original text and both edits survive
    expect(finalA).toContain('hello');
    expect(finalA).toContain('from-A');
    expect(finalA).toContain('from-B');
  });

  it('delete-vs-edit: deletion wins, both docs converge', () => {
    // Most important conflict: A deletes a cell while B is editing text inside it.
    // Yjs tombstones the element — deletion wins, edits to that element are lost.
    // The key assertion: BOTH sides end up identical (no split-brain).
    const base = makeSeededDoc('shared');
    const peerA = fork(base);
    const peerB = fork(base);
    base.destroy();

    const fragA = peerA.getXmlFragment(XML_FRAGMENT_NAME);
    const fragB = peerB.getXmlFragment(XML_FRAGMENT_NAME);

    // A deletes the cell
    peerA.transact(() => fragA.delete(0, 1));

    // B concurrently edits text inside that same cell
    const textB = getFirstText(peerB);
    peerB.transact(() => textB.insert(textB.length, ' edited-by-B'));

    sync(peerA, peerB);

    expect(xmlOf(peerA)).toBe(xmlOf(peerB));
    // Deletion wins: no cells remain
    expect(fragA.length).toBe(0);
    expect(fragB.length).toBe(0);
  });

  it('three-peer concurrent inserts converge regardless of sync order', () => {
    const base = makeSeededDoc();
    const peerA = fork(base);
    const peerB = fork(base);
    const peerC = fork(base);
    base.destroy();

    for (const [peer, id] of [
      [peerA, 'cell-a'] as const,
      [peerB, 'cell-b'] as const,
      [peerC, 'cell-c'] as const,
    ]) {
      peer.transact(() => {
        const cell = new Y.XmlElement('markdown_cell');
        cell.setAttribute('data-id', id);
        peer.getXmlFragment(XML_FRAGMENT_NAME).insert(0, [cell]);
      });
    }

    // Sync in A→B, B→C, A→C order to stress-test commutativity
    sync(peerA, peerB);
    sync(peerB, peerC);
    sync(peerA, peerC);

    const finalA = xmlOf(peerA);
    const finalB = xmlOf(peerB);
    const finalC = xmlOf(peerC);

    expect(finalA).toBe(finalB);
    expect(finalB).toBe(finalC);
    // Seed + 3 concurrent cells = 4 total
    expect(peerA.getXmlFragment(XML_FRAGMENT_NAME).length).toBe(4);
    expect(finalA).toContain('cell-a');
    expect(finalA).toContain('cell-b');
    expect(finalA).toContain('cell-c');
  });
});

// ---------------------------------------------------------------------------
// aiThreads convergence (lives in Y.Map outside the PM doc)
// ---------------------------------------------------------------------------

describe('aiThreads convergence', () => {
  it('concurrent turns from two peers both appear after sync', () => {
    const CELL_ID = 'cell-123';
    const peerA = new Y.Doc();
    // Create the thread entry so it exists before forking
    getThread(peerA, CELL_ID);

    const peerB = fork(peerA);
    const threadA = getThread(peerA, CELL_ID);
    const threadB = getThread(peerB, CELL_ID);

    addTurn(threadA, 'user', 'Question from A');
    addTurn(threadB, 'assistant', 'Answer from B');

    sync(peerA, peerB);

    const contentsA = threadA.toArray().map(t => (t.get('content') as Y.Text).toString());
    const contentsB = threadB.toArray().map(t => (t.get('content') as Y.Text).toString());

    expect(contentsA).toEqual(contentsB);
    expect(contentsA).toHaveLength(2);
    expect(contentsA).toContain('Question from A');
    expect(contentsA).toContain('Answer from B');
  });

  it('concurrent Y.Text streaming into the same turn converges', () => {
    // Simulates two peers both appending tokens to the same assistant Y.Text —
    // e.g. two browser tabs both receiving streamed output.
    const CELL_ID = 'cell-stream';
    const peerA = new Y.Doc();
    const threadA = getThread(peerA, CELL_ID);
    const turn = addTurn(threadA, 'assistant');

    const peerB = fork(peerA);
    const threadB = getThread(peerB, CELL_ID);

    const textA = turn.get('content') as Y.Text;
    const textB = threadB.get(0).get('content') as Y.Text;

    // Concurrent inserts at different positions
    peerA.transact(() => textA.insert(0, 'Hello '));
    peerB.transact(() => textB.insert(0, 'World'));

    sync(peerA, peerB);

    const finalA = (threadA.get(0).get('content') as Y.Text).toString();
    const finalB = (threadB.get(0).get('content') as Y.Text).toString();

    expect(finalA).toBe(finalB);
    expect(finalA).toContain('Hello');
    expect(finalA).toContain('World');
  });

  it('threads for different cells stay isolated after sync', () => {
    const peerA = new Y.Doc();
    const peerB = fork(peerA);

    addTurn(getThread(peerA, 'cell-A'), 'user', 'For A');
    addTurn(getThread(peerB, 'cell-B'), 'user', 'For B');

    sync(peerA, peerB);

    // Each cell's thread has exactly one turn, on both peers
    for (const doc of [peerA, peerB]) {
      expect(getThread(doc, 'cell-A').length).toBe(1);
      expect(getThread(doc, 'cell-B').length).toBe(1);
    }

    const aContent = (getThread(peerA, 'cell-A').get(0).get('content') as Y.Text).toString();
    const bContent = (getThread(peerA, 'cell-B').get(0).get('content') as Y.Text).toString();
    expect(aContent).toBe('For A');
    expect(bContent).toBe('For B');
  });

  it('three-peer turn merge: all turns present in all peers', () => {
    const CELL_ID = 'cell-multi';
    const peerA = new Y.Doc();
    // Create the Y.Array entry BEFORE forking so all peers share the same
    // CRDT identity. If each peer creates its own Y.Array under the same
    // Y.Map key while offline, Y.Map last-write-wins semantics would
    // discard the other arrays — that would be a real app bug to avoid.
    getThread(peerA, CELL_ID);
    const peerB = fork(peerA);
    const peerC = fork(peerA);

    addTurn(getThread(peerA, CELL_ID), 'user', 'From A');
    addTurn(getThread(peerB, CELL_ID), 'user', 'From B');
    addTurn(getThread(peerC, CELL_ID), 'user', 'From C');

    // Full convergence via pairwise syncs
    sync(peerA, peerB);
    sync(peerB, peerC);
    sync(peerA, peerC);

    // Sort for order-independent comparison (Yjs Y.Array ordering is
    // deterministic per CRDT rules, but we care about presence, not position)
    const contents = (doc: Y.Doc) =>
      getThread(doc, CELL_ID)
        .toArray()
        .map(t => (t.get('content') as Y.Text).toString())
        .sort();

    expect(contents(peerA)).toEqual(contents(peerB));
    expect(contents(peerB)).toEqual(contents(peerC));
    expect(contents(peerA)).toHaveLength(3);
    expect(contents(peerA)).toContain('From A');
    expect(contents(peerA)).toContain('From B');
    expect(contents(peerA)).toContain('From C');
  });
});

// ---------------------------------------------------------------------------
// seedIfEmpty
// ---------------------------------------------------------------------------

describe('seedIfEmpty', () => {
  it('seeds a fresh doc with one cell', () => {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment(XML_FRAGMENT_NAME);
    expect(frag.length).toBe(0);

    seedIfEmpty(doc, frag);

    expect(frag.length).toBe(1);
  });

  it('does not overwrite existing content', () => {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment(XML_FRAGMENT_NAME);
    frag.insert(0, [new Y.XmlElement('markdown_cell')]);

    seedIfEmpty(doc, frag);

    expect(frag.length).toBe(1);
  });

  it('is idempotent — calling twice does not double-insert', () => {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment(XML_FRAGMENT_NAME);

    seedIfEmpty(doc, frag);
    seedIfEmpty(doc, frag);

    expect(frag.length).toBe(1);
  });
});
