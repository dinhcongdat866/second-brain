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

interface StoredEntry {
  entry_id: string;
  raw_text: string | null;
  taxonomy_version: number | null;
}

interface ParsedResult {
  entry_id: string;
  amount: number | null;
  category: string;
  counterparty: string | null;
  debt_delta: number;
  status: MoneyEntryData['status'];
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

  // 3. Dirty list.
  const dirty = pending.filter((entry) => {
    const row = storedMap.get(entry.id);
    return (
      row === undefined ||                                              // new line
      row.raw_text !== entry.text ||                                    // text edited
      (row.taxonomy_version ?? 0) < CURRENT_MONEY_TAXONOMY_VERSION ||   // taxonomy bumped
      entry.parsedFrom !== entry.text                                   // Y.Doc copy stale
    );
  });

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

    for (const entry of batch) {
      const r = byId.get(entry.id);
      if (!r) continue;
      updateMoneyEntry(ydoc, entry.id, {
        amount:       r.amount,
        category:     r.category,
        counterparty: r.counterparty,
        debtDelta:    r.debt_delta,
        status:       r.status,
        // Records what this result was derived from: edit the text and the
        // dirty-check fires again, leave it alone and this line stays free.
        parsedFrom:   entry.text,
      });
    }
  }
}

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
