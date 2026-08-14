/**
 * The two properties of the money sync that cost real money or corrupt real
 * numbers when they break:
 *
 *   1. A line whose answer is already in the database must NOT be sent to the
 *      model again. This is not hypothetical — close the tab while
 *      /money/parse is in flight and the row lands without the response ever
 *      reaching the client, so the Y.Doc copy is stale while the DB is current.
 *      Treating that as "needs parsing" bills the user a second time to be told
 *      exactly what the DB already knows.
 *
 *   2. A line deleted while its batch is in flight must not survive in SQL. The
 *      parse upserts a row regardless of what the client did meanwhile, and a
 *      row nothing points to still counts in SUM(debt_delta) on the ledger.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as Y from 'yjs';

vi.mock('../../lib/http', () => ({ apiFetch: vi.fn() }));
vi.mock('../../lib/apiKey', () => ({ getApiKey: () => 'sk-test' }));
vi.mock('../../lib/backendSync', () => ({ deleteMoneyEntryRow: vi.fn() }));

import { apiFetch } from '../../lib/http';
import { deleteMoneyEntryRow } from '../../lib/backendSync';
import { addMoneyEntry, deleteMoneyEntry, readMoneyForDate } from '../../collab/weeklyPlans';
import { syncMoneyForTest } from '../useMoneySync';

const apiFetchMock = vi.mocked(apiFetch);
const deleteRowMock = vi.mocked(deleteMoneyEntryRow);

const TODAY = new Date().toISOString().slice(0, 10);

/** A row as GET /money/entries returns it. */
function storedRow(entryId: string, rawText: string, over: Record<string, unknown> = {}) {
  return {
    entry_id: entryId,
    amount: -85_000,
    category: 'Food & Drink',
    counterparty: null,
    debt_delta: 0,
    status: 'ok',
    raw_text: rawText,
    taxonomy_version: 1,
    ...over,
  };
}

const jsonResponse = (body: unknown) => ({ json: async () => body }) as unknown as Response;

/** Which endpoints were hit, in order. */
const calledPaths = () => apiFetchMock.mock.calls.map((c) => String(c[0]).split('?')[0]);

beforeEach(() => {
  apiFetchMock.mockReset();
  deleteRowMock.mockReset();
});

describe('an answer already in the database', () => {
  it('is copied into the Y.Doc without calling the model', async () => {
    const ydoc = new Y.Doc();
    const id = addMoneyEntry(ydoc, TODAY, 'cà phê 85k');
    // The DB has the parse; the Y.Doc never received it (tab closed mid-flight).
    apiFetchMock.mockResolvedValueOnce(jsonResponse([storedRow(id, 'cà phê 85k')]));

    await syncMoneyForTest(ydoc);

    expect(calledPaths()).toEqual(['/money/entries']);
    expect(calledPaths()).not.toContain('/money/parse');

    const [entry] = readMoneyForDate(ydoc, TODAY);
    expect(entry.amount).toBe(-85_000);
    expect(entry.category).toBe('Food & Drink');
    expect(entry.status).toBe('ok');
    // parsedFrom now matches, so the next pass does nothing at all.
    expect(entry.parsedFrom).toBe(entry.text);
  });

  it('does nothing when the DB and the Y.Doc already agree', async () => {
    const ydoc = new Y.Doc();
    const id = addMoneyEntry(ydoc, TODAY, 'cà phê 85k');
    apiFetchMock.mockResolvedValueOnce(jsonResponse([storedRow(id, 'cà phê 85k')]));
    await syncMoneyForTest(ydoc);
    apiFetchMock.mockClear();

    apiFetchMock.mockResolvedValueOnce(jsonResponse([storedRow(id, 'cà phê 85k')]));
    await syncMoneyForTest(ydoc);

    expect(calledPaths()).toEqual(['/money/entries']);
  });

  it('still calls the model when the text was edited after the row was written', async () => {
    const ydoc = new Y.Doc();
    const id = addMoneyEntry(ydoc, TODAY, 'cà phê 95k');
    // Row reflects the OLD text — the amount in it is stale and must not be copied.
    apiFetchMock
      .mockResolvedValueOnce(jsonResponse([storedRow(id, 'cà phê 85k')]))
      .mockResolvedValueOnce(jsonResponse({
        results: [{ entry_id: id, amount: -95_000, category: 'Food & Drink', counterparty: null, debt_delta: 0, status: 'ok' }],
      }));

    await syncMoneyForTest(ydoc);

    expect(calledPaths()).toEqual(['/money/entries', '/money/parse']);
    expect(readMoneyForDate(ydoc, TODAY)[0].amount).toBe(-95_000);
  });

  it('still calls the model when the taxonomy has moved on', async () => {
    const ydoc = new Y.Doc();
    const id = addMoneyEntry(ydoc, TODAY, 'cà phê 85k');
    apiFetchMock
      .mockResolvedValueOnce(jsonResponse([storedRow(id, 'cà phê 85k', { taxonomy_version: 0 })]))
      .mockResolvedValueOnce(jsonResponse({
        results: [{ entry_id: id, amount: -85_000, category: 'Food & Drink', counterparty: null, debt_delta: 0, status: 'ok' }],
      }));

    await syncMoneyForTest(ydoc);

    expect(calledPaths()).toContain('/money/parse');
  });
});

describe('a line deleted while its batch is in flight', () => {
  it('has its row removed instead of being written back', async () => {
    const ydoc = new Y.Doc();
    const id = addMoneyEntry(ydoc, TODAY, 'cà phê 85k');

    apiFetchMock
      .mockResolvedValueOnce(jsonResponse([]))               // DB knows nothing yet
      .mockImplementationOnce(async () => {
        // The user deletes the line while /money/parse is running.
        deleteMoneyEntry(ydoc, id);
        return jsonResponse({
          results: [{ entry_id: id, amount: -85_000, category: 'Food & Drink', counterparty: null, debt_delta: 0, status: 'ok' }],
        });
      });

    await syncMoneyForTest(ydoc);

    // The row the parse just created is cleaned up…
    expect(deleteRowMock).toHaveBeenCalledWith(id);
    // …and the deleted line does not come back into the document.
    expect(readMoneyForDate(ydoc, TODAY)).toEqual([]);
  });

  it('leaves surviving lines in the same batch alone', async () => {
    const ydoc = new Y.Doc();
    const gone = addMoneyEntry(ydoc, TODAY, 'cà phê 85k');
    const kept = addMoneyEntry(ydoc, TODAY, 'grab 42k');

    apiFetchMock
      .mockResolvedValueOnce(jsonResponse([]))
      .mockImplementationOnce(async () => {
        deleteMoneyEntry(ydoc, gone);
        return jsonResponse({
          results: [
            { entry_id: gone, amount: -85_000, category: 'Food & Drink', counterparty: null, debt_delta: 0, status: 'ok' },
            { entry_id: kept, amount: -42_000, category: 'Transport', counterparty: null, debt_delta: 0, status: 'ok' },
          ],
        });
      });

    await syncMoneyForTest(ydoc);

    expect(deleteRowMock).toHaveBeenCalledTimes(1);
    expect(deleteRowMock).toHaveBeenCalledWith(gone);

    const survivors = readMoneyForDate(ydoc, TODAY);
    expect(survivors.map((e) => e.text)).toEqual(['grab 42k']);
    expect(survivors[0].amount).toBe(-42_000);
  });
});
