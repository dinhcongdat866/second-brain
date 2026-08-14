/**
 * On app load, scans the last 12 months of money log entries, diffs them
 * against what the DB already parsed, and sends only new/changed lines to
 * POST /money/parse (max 50 per batch, Haiku, one call per batch).
 *
 * Dirty-check logic — the same shape as useClassificationSync:
 *   - entry not in DB → parse
 *   - text changed since last parse → re-parse
 *   - text unchanged → skip (free)
 *
 * Parse results are written back into the Y.Doc, so a line renders with its
 * amount offline on the next load without calling the model again.
 *
 * Runs once when ydoc becomes available. Auth users only; guests skip entirely.
 */
import { useCallback, useEffect, useRef } from 'react';
import * as Y from 'yjs';
import {
  MONEY_LOG_KEY,
  readMoneyLog,
  updateMoneyEntry,
  type MoneyEntryData,
} from '../collab/weeklyPlans';
import { getApiKey } from '../lib/apiKey';
import { deleteMoneyEntryRow } from '../lib/backendSync';
import { LLM_TIMEOUT_MS } from '../lib/config';
import { apiFetch } from '../lib/http';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * How far back to look. This is a date range, not a list of week keys — the
 * reason moneyLog is keyed by day. Compare WEEKS_TO_SCAN in
 * useClassificationSync, which has to generate one Monday string per week and
 * probe each one.
 */
const DAYS_TO_SCAN = 365;
const BATCH_SIZE   = 50;  // backend max per request

/**
 * Wait after the last planner edit before parsing. Long enough that finishing a
 * line, or typing two in a row, costs one call instead of one per keystroke.
 */
const PARSE_DEBOUNCE_MS = 2_500;

/** Must stay in sync with MONEY_TAXONOMY_VERSION in backend/app/routers/money.py */
const CURRENT_MONEY_TAXONOMY_VERSION = 1;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/**
 * Is there a line the model has not seen in its current form? Answered purely
 * from the Y.Doc, with no request — so the observer below can ignore ordinary
 * todo edits instead of firing a GET on every keystroke in the planner.
 */
function hasUnparsedEntry(ydoc: Y.Doc): boolean {
  for (const entries of Object.values(readMoneyLog(ydoc))) {
    for (const entry of entries) {
      if (entry.text.trim() && entry.parsedFrom !== entry.text) return true;
    }
  }
  return false;
}

/** The shape both GET /money/entries and POST /money/parse return per line. */
interface ParsedResult {
  entry_id: string;
  amount: number | null;
  category: string;
  counterparty: string | null;
  debt_delta: number;
  status: MoneyEntryData['status'];
}

/** A parsed row as GET /money/entries returns it — same fields plus provenance. */
interface StoredEntry extends ParsedResult {
  raw_text: string | null;
  taxonomy_version: number | null;
}

/** Turn a backend row into the fields the Y.Doc entry carries. */
function toPatch(row: ParsedResult, text: string): Partial<MoneyEntryData> {
  return {
    amount:       row.amount,
    category:     row.category,
    counterparty: row.counterparty,
    debtDelta:    row.debt_delta,
    status:       row.status,
    // Records what this result was derived from: edit the text and the
    // dirty-check fires again, leave it alone and this line stays free.
    parsedFrom:   text,
  };
}

// ---------------------------------------------------------------------------
// Core sync logic (runs outside React)
// ---------------------------------------------------------------------------

async function syncMoney(ydoc: Y.Doc): Promise<void> {
  // Parsing is billed to the user's own Anthropic key (the backend has none).
  // Without a key every batch would 400, so skip the scan entirely.
  const userApiKey = getApiKey();
  if (!userApiKey) return;

  const today = new Date();
  const toDate = isoDate(today);
  const fromDate = isoDate(new Date(today.getTime() - DAYS_TO_SCAN * 86_400_000));

  // 1. Collect in-range entries from Yjs.
  const pending: MoneyEntryData[] = [];
  for (const [date, entries] of Object.entries(readMoneyLog(ydoc))) {
    if (date < fromDate || date > toDate) continue;
    for (const entry of entries) {
      if (entry.text.trim()) pending.push(entry);
    }
  }

  if (pending.length === 0) return;

  // 2. What the DB already knows, in one range query.
  const res = await apiFetch(
    `/money/entries?from_date=${fromDate}&to_date=${toDate}`,
  );
  const stored: StoredEntry[] = await res.json();
  const storedMap = new Map(stored.map((r) => [r.entry_id, r]));

  // 3. Split what needs the model from what the DB can already answer.
  //
  // These are different questions and conflating them costs real money. The DB
  // row can be current while the Y.Doc copy is not — that is exactly what
  // happens when the tab closes after /money/parse wrote its row but before the
  // response came back. Treating that as "dirty" re-ran the whole parse and
  // billed the user a second time to be told the same thing.
  const needsModel: MoneyEntryData[] = [];
  const canCopy: Array<{ entry: MoneyEntryData; row: StoredEntry }> = [];

  for (const entry of pending) {
    const row = storedMap.get(entry.id);
    const rowIsCurrent =
      row !== undefined &&
      row.raw_text === entry.text &&
      (row.taxonomy_version ?? 0) >= CURRENT_MONEY_TAXONOMY_VERSION;

    if (!rowIsCurrent) { needsModel.push(entry); continue; }
    if (entry.parsedFrom !== entry.text) canCopy.push({ entry, row: row! });
    // else: DB and Y.Doc agree — nothing to do, and nothing to pay for.
  }

  // Copy first: free, and it clears the common case before anything is billed.
  for (const { entry, row } of canCopy) {
    updateMoneyEntry(ydoc, entry.id, toPatch(row, entry.text));
  }

  const dirty = needsModel;
  if (dirty.length === 0) return;

  // 4. Parse in batches, writing each batch back before starting the next so a
  //    later failure doesn't discard work already paid for.
  for (let i = 0; i < dirty.length; i += BATCH_SIZE) {
    const batch = dirty.slice(i, i + BATCH_SIZE);
    const parseRes = await apiFetch('/money/parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-api-key': userApiKey },
      body: JSON.stringify({
        entries: batch.map((entry) => ({
          entry_id: entry.id,
          date: entry.date,
          text: entry.text,
        })),
      }),
      timeoutMs: LLM_TIMEOUT_MS,
    });
    const { results } = (await parseRes.json()) as { results: ParsedResult[] };
    const byId = new Map(results.map((r) => [r.entry_id, r]));

    const live = ydoc.getMap<Y.Map<unknown>>(MONEY_LOG_KEY);

    for (const entry of batch) {
      const r = byId.get(entry.id);
      if (!r) continue;
      // The line can be deleted while its batch is in flight — typing something,
      // seeing it is wrong and removing it is exactly what people do during the
      // seconds this call takes. The parse upserted a row for it anyway, so that
      // row has to go, or it sits in money_entries with nothing in the document
      // pointing at it, still counted by SUM(debt_delta) in the ledger.
      // Checking the map rather than the deleted id also cleans up lines another
      // device removed while this one was parsing.
      if (!live.has(entry.id)) { deleteMoneyEntryRow(entry.id); continue; }
      updateMoneyEntry(ydoc, entry.id, toPatch(r, entry.text));
    }
  }
}

/**
 * The sync pass, exposed for tests. Everything worth asserting here — that a
 * line already answered by the DB is not re-billed, that a line deleted
 * mid-flight has its row removed — lives in this function rather than in the
 * hook wrapper around it.
 */
export const syncMoneyForTest = syncMoney;

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * @param ydoc     - the planner Y.Doc (null while loading)
 * @param enabled  - false for guests; hook no-ops entirely
 * @param isReady  - true once IndexedDB + server state are loaded; prevents
 *                   running on an empty ydoc before entries have been applied
 * @returns `sync()` — call to re-trigger after adding a line
 */
export function useMoneySync(
  ydoc: Y.Doc | null,
  enabled: boolean,
  isReady: boolean,
): { sync: () => void } {
  const runningRef = useRef(false);
  const queuedRef = useRef(false);

  const sync = useCallback(() => {
    if (!ydoc || !enabled) return;
    // A line typed while a parse is in flight would otherwise wait for the next
    // reload — mark it and let the loop below pick it up on this pass.
    if (runningRef.current) { queuedRef.current = true; return; }
    runningRef.current = true;
    void (async () => {
      try {
        do {
          queuedRef.current = false;
          await syncMoney(ydoc);
        } while (queuedRef.current);
      } catch {
        /* fail silently — the raw text is already safe in Yjs */
      } finally {
        runningRef.current = false;
      }
    })();
  }, [ydoc, enabled]);

  useEffect(() => {
    if (ydoc && enabled && isReady) sync();
  }, [ydoc, enabled, isReady, sync]);

  // Parse lines added after load too, so typing a line and leaving it alone
  // still fills in the amount. Watching only the money map keeps todo edits out
  // of it entirely; the local gate then stops the write-back at the end of a
  // parse from scheduling another one.
  useEffect(() => {
    if (!ydoc || !enabled || !isReady) return;
    const entries = ydoc.getMap<Y.Map<unknown>>(MONEY_LOG_KEY);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const handler = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (hasUnparsedEntry(ydoc)) sync();
      }, PARSE_DEBOUNCE_MS);
    };
    entries.observeDeep(handler);
    return () => {
      entries.unobserveDeep(handler);
      if (timer) clearTimeout(timer);
    };
  }, [ydoc, enabled, isReady, sync]);

  return { sync };
}
