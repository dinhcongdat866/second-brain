/**
 * The money log's Yjs layer.
 *
 * Three properties carry real risk and are why this file exists:
 *   - two devices adding lines concurrently must keep BOTH. The first version
 *     of this store nested a Y.Map under the plan and a Y.Array under each
 *     date; whoever created a container second lost every line in theirs. The
 *     flat top-level map exists to make that unrepresentable, and the last
 *     test here is the one that caught it;
 *   - a day total must always be recomputed from the lines, never accumulated —
 *     a stored balance is unrecoverable once two devices have both added to it;
 *   - `parsedFrom` must track the text a result was derived from, because it is
 *     the entire dirty-check: get it wrong in one direction and every load
 *     re-bills the user, wrong in the other and edits never re-parse.
 */
import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import {
  addMoneyEntry,
  deleteMoneyEntry,
  formatDong,
  moneyTotal,
  readMoneyForDate,
  readMoneyLog,
  updateMoneyEntry,
} from '../weeklyPlans';

const DATE = '2026-08-12';

describe('money entries', () => {
  it('a new line is stored unparsed, so the UI can render it before the network answers', () => {
    const ydoc = new Y.Doc();
    addMoneyEntry(ydoc, DATE, '  cà phê với anh Tuấn 85k  ');

    const [entry] = readMoneyForDate(ydoc, DATE);
    expect(entry.text).toBe('cà phê với anh Tuấn 85k'); // trimmed
    expect(entry.date).toBe(DATE);
    expect(entry.amount).toBeNull();
    expect(entry.status).toBe('needs_amount');
    expect(entry.parsedFrom).toBeNull();
  });

  it('reading an empty doc returns nothing rather than creating keys', () => {
    const ydoc = new Y.Doc();
    expect(readMoneyForDate(ydoc, DATE)).toEqual([]);
    expect(readMoneyLog(ydoc)).toEqual({});
  });

  it('keeps insertion order within a day', () => {
    const ydoc = new Y.Doc();
    addMoneyEntry(ydoc, DATE, 'cà phê 85k');
    addMoneyEntry(ydoc, DATE, 'grab 42k');
    addMoneyEntry(ydoc, DATE, 'ăn trưa 50k');

    expect(readMoneyForDate(ydoc, DATE).map((e) => e.text)).toEqual([
      'cà phê 85k',
      'grab 42k',
      'ăn trưa 50k',
    ]);
  });

  it('writes a parse result back onto the entry', () => {
    const ydoc = new Y.Doc();
    const id = addMoneyEntry(ydoc, DATE, 'mượn mẹ 5 củ');

    updateMoneyEntry(ydoc, id, {
      amount: 5_000_000,
      category: 'Borrowing',
      counterparty: 'mẹ',
      debtDelta: 5_000_000,
      status: 'ok',
      parsedFrom: 'mượn mẹ 5 củ',
    });

    expect(readMoneyForDate(ydoc, DATE)[0]).toMatchObject({
      amount: 5_000_000,
      category: 'Borrowing',
      counterparty: 'mẹ',
      debtDelta: 5_000_000,
      status: 'ok',
      parsedFrom: 'mượn mẹ 5 củ',
    });
  });

  it('keeps amount: null distinguishable from "not set" — a flagged line is a real result', () => {
    const ydoc = new Y.Doc();
    const id = addMoneyEntry(ydoc, DATE, 'trả nợ đợt này kha khá');

    updateMoneyEntry(ydoc, id, {
      amount: null,
      category: 'Debt Repayment',
      status: 'needs_amount',
      parsedFrom: 'trả nợ đợt này kha khá',
    });

    const [entry] = readMoneyForDate(ydoc, DATE);
    expect(entry.amount).toBeNull();
    // parsedFrom === text is what tells the UI "parsed, and it found nothing"
    // rather than "still waiting" — the two render differently.
    expect(entry.parsedFrom).toBe(entry.text);
  });

  it('editing the text leaves parsedFrom behind, which is what makes it re-parse', () => {
    const ydoc = new Y.Doc();
    const id = addMoneyEntry(ydoc, DATE, 'cà phê 85k');
    updateMoneyEntry(ydoc, id, { amount: -85_000, parsedFrom: 'cà phê 85k', status: 'ok' });

    updateMoneyEntry(ydoc, id, { text: 'cà phê 95k' });

    const [entry] = readMoneyForDate(ydoc, DATE);
    expect(entry.parsedFrom).not.toBe(entry.text);
  });

  it('deletes one line without touching its neighbours', () => {
    const ydoc = new Y.Doc();
    addMoneyEntry(ydoc, DATE, 'cà phê 85k');
    const id = addMoneyEntry(ydoc, DATE, 'grab 42k');
    addMoneyEntry(ydoc, DATE, 'ăn trưa 50k');

    deleteMoneyEntry(ydoc, id);

    expect(readMoneyForDate(ydoc, DATE).map((e) => e.text)).toEqual([
      'cà phê 85k',
      'ăn trưa 50k',
    ]);
  });

  it('groups by date and drops days that were emptied', () => {
    const ydoc = new Y.Doc();
    const id = addMoneyEntry(ydoc, DATE, 'cà phê 85k');
    addMoneyEntry(ydoc, '2026-08-13', 'grab 42k');
    deleteMoneyEntry(ydoc, id);

    expect(Object.keys(readMoneyLog(ydoc))).toEqual(['2026-08-13']);
  });
});

describe('moneyTotal', () => {
  const line = (amount: number | null) => ({ amount } as never);

  it('nets money in against money out', () => {
    expect(moneyTotal([line(-210_000), line(5_000_000)])).toBe(4_790_000);
  });

  it('contributes nothing for a flagged line instead of guessing a zero amount', () => {
    expect(moneyTotal([line(-85_000), line(null), line(-42_000)])).toBe(-127_000);
  });

  it('is zero for an empty day', () => {
    expect(moneyTotal([])).toBe(0);
  });
});

describe('formatDong', () => {
  it('marks direction with an explicit sign', () => {
    expect(formatDong(-85_000)).toBe('−85.000');
    expect(formatDong(5_000_000)).toBe('+5.000.000');
  });
});

describe('concurrent edits', () => {
  /** Two replicas that have already seen each other, then diverge offline. */
  function twoDevices() {
    const a = new Y.Doc();
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    return { a, b };
  }

  function sync(a: Y.Doc, b: Y.Doc) {
    const fromA = Y.encodeStateAsUpdate(a);
    const fromB = Y.encodeStateAsUpdate(b);
    Y.applyUpdate(b, fromA);
    Y.applyUpdate(a, fromB);
  }

  it('keeps both lines when two devices write the very first entry offline', () => {
    // The regression test. With a Y.Map created per device under the plan, one
    // side's map replaced the other's and its line vanished entirely.
    const { a, b } = twoDevices();
    addMoneyEntry(a, DATE, 'cà phê 85k');
    addMoneyEntry(b, DATE, 'grab 42k');

    sync(a, b);

    const textsA = readMoneyForDate(a, DATE).map((e) => e.text).sort();
    expect(textsA).toEqual(['cà phê 85k', 'grab 42k']);
    expect(readMoneyForDate(b, DATE).map((e) => e.text).sort()).toEqual(textsA);
  });

  it('a total is identical on both devices because it is derived, never merged', () => {
    const { a, b } = twoDevices();
    const idA = addMoneyEntry(a, DATE, 'cà phê 85k');
    const idB = addMoneyEntry(b, DATE, 'mượn mẹ 5 củ');
    updateMoneyEntry(a, idA, { amount: -85_000, status: 'ok', parsedFrom: 'cà phê 85k' });
    updateMoneyEntry(b, idB, { amount: 5_000_000, status: 'ok', parsedFrom: 'mượn mẹ 5 củ' });

    sync(a, b);

    expect(moneyTotal(readMoneyForDate(a, DATE))).toBe(4_915_000);
    expect(moneyTotal(readMoneyForDate(b, DATE))).toBe(
      moneyTotal(readMoneyForDate(a, DATE)),
    );
  });

  it('a delete on one device survives a concurrent parse write-back on the other', () => {
    const { a, b } = twoDevices();
    const id = addMoneyEntry(a, DATE, 'cà phê 85k');
    sync(a, b);

    deleteMoneyEntry(a, id);
    updateMoneyEntry(b, id, { amount: -85_000, status: 'ok', parsedFrom: 'cà phê 85k' });

    sync(a, b);

    // Deleting a whole key beats writing fields inside it — the line stays gone
    // on both sides rather than coming back half-populated.
    expect(readMoneyForDate(a, DATE)).toEqual([]);
    expect(readMoneyForDate(b, DATE)).toEqual([]);
  });
});
