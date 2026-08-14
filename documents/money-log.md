# Money Log — slice 1

Expense/income tracking as a **third tier inside the weekly planner cell**, not a new cell type.
Todos on top, a divider, money lines below, day total at the bottom.

The design decision that drives everything else: money is **keyed by date**, not by week/day slot.
Money is a stream that happens to you; a todo is something you place into Tuesday in advance.
`moodLog` already took that shape, so money follows it — though *where* the store lives changed
during implementation, for reasons §1 sets out.

`money_cell` is deliberately **out of scope**. When it arrives it is a *lens* over this same data
(monthly totals, ledger, runway), never a second place to store.

---

## 1. Y.Doc shape

A **flat, top-level map on the planner Y.Doc**, keyed by entry id. Each entry
carries its own date; a day or a range is a filter, not a lookup.

```
planner Y.Doc
├── weeklyPlans : Y.Map<cellId → plan{ weekStart, weeks, moodLog }>   ← unchanged
└── moneyLog    : Y.Map<entryId → Y.Map{…MoneyEntryData}>             ← new, top-level
```

This is a **correction to the original design**, which put `moneyLog` next to
`moodLog` inside the plan and keyed it by date with a `Y.Array` per day. A
convergence test proved that loses data:

> Two devices, both offline, each add their first money line. Each one runs
> `plan.set('moneyLog', new Y.Map())` — the same key, two different objects. Yjs
> resolves that by letting one side win **the whole map**, so the other device's
> line is gone, along with every other line it held. The per-date `Y.Array` is
> the identical trap one level down.

Top-level types are resolved by name and never conflict — the same guarantee
`WEEKLY_PLANS_KEY` already relies on — and a uuid key means two concurrent
writers always touch different keys. Between them there is nothing left to race.
The test that caught this is the first one in `src/collab/__tests__/moneyLog.test.ts`.

Keying by day is preserved through the `date` field, so the reasoning that put
money next to `moodLog` still holds: money is a stream that happens to you, not
something you place into Tuesday in advance.

```ts
/** MONEY_LOG_KEY = 'moneyLog' */
export interface MoneyEntryData {
  id: string;              // crypto.randomUUID(), also the Postgres PK
  date: string;            // 'YYYY-MM-DD'
  text: string;            // exactly what the user typed — the source of truth
  amount: number | null;   // signed integer VND. null ⇒ status 'needs_amount'
  category: string;        // from MONEY_CATEGORIES, canonical casing
  counterparty: string | null;
  debtDelta: number;       // signed VND, 0 for ordinary entries — see §5
  status: 'ok' | 'needs_amount';
  parsedFrom: string | null; // snapshot of `text` when parsed — dirty-check
  createdAt: number;       // insertion order within a day
}
```

Everything needed to **render offline** is here: the day total and the line itself paint with no
network. Only the aggregate queries need Postgres.

`amount` is an integer number of đồng, signed: negative = money out, positive = money in.
There are no minor units in practice, so no scaling factor — but it must be an integer, never a
float, because floats and money is how you get 84999.99999.

New functions in `weeklyPlans.ts`, below the mood-log block:

```ts
addMoneyEntry(ydoc, date, text): string                // returns the new id
readMoneyForDate(ydoc, date): MoneyEntryData[]
readMoneyLog(ydoc): Record<string, MoneyEntryData[]>
updateMoneyEntry(ydoc, id, patch: Partial<MoneyEntryData>): void
deleteMoneyEntry(ydoc, id): void
moneyTotal(entries): number                            // recomputed, never stored
formatDong(amount): string                             // '−85.000' / '+5.000.000'
```

---

## 2. Postgres

New table + router. Mirrors `todo_classifications` but keyed by date instead of week.

```sql
money_entries (
  entry_id         TEXT PRIMARY KEY,   -- the Y.Doc entry id
  user_id          TEXT NOT NULL,
  date             TEXT NOT NULL,      -- 'YYYY-MM-DD'
  raw_text         TEXT NOT NULL,      -- snapshot at parse time → dirty-check
  amount           BIGINT,             -- signed VND, NULL when status='needs_amount'
  category         TEXT NOT NULL,
  counterparty     TEXT,
  debt_delta       BIGINT NOT NULL DEFAULT 0,
  status           TEXT NOT NULL,      -- 'ok' | 'needs_amount'
  taxonomy_version INT,
  parsed_at        TIMESTAMPTZ
)
CREATE INDEX ix_money_entries_user_date ON money_entries (user_id, date);
```

`BIGINT`, not `INT`: 32 triệu fits in int32, 3 tỷ does not.

Migration goes in `backend/app/db/migrations.py` as **Phase 6** — `create_all` makes the table,
the index is stated explicitly for the same reason Phase 5 does it.

---

## 3. Parse prompt

New router `backend/app/routers/money.py`. Unlike `_classify_one`, this batches **N lines into one
Anthropic call** — the model reads a numbered list and returns an array. Classification is one call
per todo because each is independent; here the calls are identical in shape and the whole point is
that the user's own key pays for it.

```python
MONEY_TAXONOMY_VERSION = 1

MONEY_CATEGORIES = {
    "Food & Drink", "Transport", "Housing", "Bills", "Health",
    "Entertainment", "Shopping", "Education", "Salary", "Other Income",
    "Borrowing", "Debt Repayment", "Other",
}
```

Category names are **identifiers, not labels** — stored in
`money_entries.category`, grouped on in SQL, and returned by the parser. English
for the same reason `CATEGORIES` in `analytics.py` is (taxonomy v1→v2 renamed
`"Tìm việc"` → `"Job Search"` precisely to stop mixing the two roles).

Display goes through i18n: `MONEY_CAT` + `moneyCategoryLabel(t, category)` in
`src/lib/moneyTaxonomy.ts`, resolving `moneyCategory.*` in the locale files.
Adding a language is then a locale file, not a migration.

The **input** stays Vietnamese — that is user data. So does `counterparty`
("mẹ", "anh Tuấn"), which the prompt is told to copy through verbatim rather
than normalise.

System prompt, in outline:

```
You extract money entries from short Vietnamese notes.

Vietnamese money shorthand — this is the part that matters:
  k, ng, nghìn      → ×1_000        "85k"    → 85000
  tr, triệu, củ     → ×1_000_000    "5 củ"   → 5000000
  lít, xị           → ×100_000      per local usage
  tỷ                → ×1_000_000_000
  Compound forms:   "4tr5" → 4500000    "1tr2" → 1200000    "2ng5" → 2500
  A trailing digit group after the unit is a fraction of that unit, not a separate number.

Sign:
  money leaving   → negative        money arriving → positive
  Borrowing money is positive cash AND creates debt.
  Repaying is negative cash AND reduces debt.

Return ONLY a JSON array, one object per input line, same order, same length:
[{"i":0,"amount":-85000,"category":"Food & Drink","counterparty":"anh Tuấn","debt_delta":0}]

If a line has no recoverable amount, return "amount":null. NEVER guess a number.
Never invent a category outside the list.
```

### Validation — no silent fallback

The `all-Chores` bug is the reason this section exists. A classifier that guesses wrong gives you a
bad chart; a parser that guesses wrong gives you a wrong number you will act on.

Deterministic checks after `json.loads`, before anything is written:

| Check | On failure |
|---|---|
| array length == input length, `i` present and in range | reject the whole batch, 502 |
| `amount` is `int` or `null` — a string like `"85k"` fails | `status='needs_amount'` |
| `amount != 0` | `status='needs_amount'` |
| `category` in `MONEY_CATEGORIES` (case-insensitive → canonical) | `'Other'` |
| `debt_delta` is `int` | `0` |
| `counterparty` is `str` or `null` | `null` |

`'Other'` is a legitimate bucket, so falling back to it is honest. Falling back to an *amount* is
not — there is no honest default for "how much money", so the line stays flagged and the UI shows
the amber "no amount found" state with the raw text intact.

---

## 4. Endpoints

```
POST   /money/parse              x-user-api-key required
       { entries: [{ entry_id, date, text }] }   max 50
       → { results: [{ entry_id, amount, category, counterparty, debt_delta, status }] }
       Upserts money_entries, stamps taxonomy_version and parsed_at.

GET    /money/entries?from_date=&to_date=
       → rows incl. raw_text + taxonomy_version, for the client dirty-check

GET    /money/ledger
       → [{ counterparty, borrowed, repaid, balance }]  — see §5

DELETE /money/entries/{entry_id}
       Called when a line is removed from the Y.Doc.
```

`_require_user_key` is imported from `analytics.py` — same rule, no operator key, ever.

---

## 5. The debt ledger

One signed integer covers every case, and the balance is **always a SQL sum, never a stored
column**. Two devices incrementing a running balance is wrong forever with no way to recover; that
is the one hard rule from the CRDT discussion.

```
mượn mẹ 5tr          amount +5_000_000   debt_delta +5_000_000   (I owe more)
trả mẹ 2tr           amount −2_000_000   debt_delta −2_000_000   (I owe less)
cho Tuấn mượn 1tr    amount −1_000_000   debt_delta −1_000_000   (they owe me)
Tuấn trả 1tr         amount +1_000_000   debt_delta +1_000_000
```

```sql
SELECT counterparty,
       SUM(debt_delta)                                AS balance,
       SUM(GREATEST(debt_delta, 0))                   AS borrowed,
       -SUM(LEAST(debt_delta, 0))                     AS repaid
FROM money_entries
WHERE user_id = :uid AND counterparty IS NOT NULL AND debt_delta <> 0
GROUP BY counterparty
HAVING SUM(debt_delta) <> 0;
```

Positive balance = you owe them. Negative = they owe you. `HAVING` hides settled people —
that is the "đã xong · 0" row in the mockup, which should simply disappear once settled.

---

## 6. Client sync

`src/hooks/useMoneySync.ts`, modelled on `useClassificationSync.ts`, with one improvement worth
noting: it scans **a date range**, not a list of enumerated week keys.

```ts
const stale =
  stored === undefined ||
  stored.raw_text !== entry.text ||
  (stored.taxonomy_version ?? 0) < MONEY_TAXONOMY_VERSION;
```

This is where `WEEKS_TO_SCAN` does not need an equivalent: `moneyLog` is keyed by date, so
"last 12 months" is `from_date`/`to_date` on one query instead of generating 104 Monday strings and
probing each one. Same reason `GET /analytics/mood` takes a range and `/classifications` takes a
single week.

After a successful parse the hook writes the result **back into the Y.Doc** (`updateMoneyEntry`),
so the line renders correctly offline on next load without re-calling the model.

---

## 7. UI

`src/nodeViews/WeeklyPlannerCell.tsx` — each day column gains, below the todo list and a divider:

- one row per money entry: label left, signed amount right, red/green
- a muted "Cả ngày" total row, recomputed from the entries every render
- an input that accepts a free line; Enter → `addMoneyEntry` → optimistic row with a spinner

Below the week grid: the ledger panel, fed by `GET /money/ledger`.

A flagged line (`status='needs_amount'`) renders with the amber warning and keeps the raw text
editable — no number is ever shown for it.

**Guests do not get the money tier at all.** They have no backend session, so `useMoneySync` is
disabled and nothing would ever be parsed; the input, the rows, the day total and the ledger are
all hidden rather than shown inert. Offering an input whose lines are permanently stuck on
"reading…", with no amount and no total, is worse than not offering it. `isGuest` reaches the cell
through `WeeklyCellView`; todos are untouched, since they need no backend.

---

## 8. Explicitly out of slice 1

- `money_cell` (the lens: monthly totals, runway)
- receipt photo → entry (the upload/vision/lightbox infra already exists, so this is a prompt)
- recurring-charge detection in `analyticsRules.ts`
- money × mood × category correlation in `/analytics/report-data`
- feeding past corrections back as few-shot examples
- `extractMoneyContext` for the AI cell (`src/lib/docContext.ts`)
