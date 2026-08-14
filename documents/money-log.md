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

- `money_cell` (the lens: monthly totals, runway) — **shipped in slice 2, §9**
- receipt photo → entry (the upload/vision/lightbox infra already exists, so this is a prompt)
- recurring-charge detection in `analyticsRules.ts` — **shipped in slice 2**, though in
  `moneyStats.ts` rather than `analyticsRules.ts`; see §12
- money × mood correlation — **shipped in slice 2**, client-side rather than in
  `/analytics/report-data`; see §12
- money × todo-category correlation — still out. Todo categories live in
  `todo_classifications`, keyed by week, so unlike mood this is not a join on a
  date the client already holds.
- feeding past corrections back as few-shot examples
- `extractMoneyContext` for the AI cell (`src/lib/docContext.ts`) — **shipped in slice 2**

---

# Money Log — slice 2: the lens

Slice 1 gave money a way in. Nothing gave it a way out: a day had a total, a
month had nothing. `money_cell` is that way out — a **read-only lens** over the
same log, exactly as the header of this document promised, never a second place
to store.

## 9. Everything is computed on the client

The decision that shapes this slice: **no new endpoints**. Every figure in the
money cell is derived from the Y.Doc, in `src/lib/moneyStats.ts`, with no request.

That is not a shortcut, it falls out of the shape slice 1 chose. Each entry
carries its own `date`, `amount`, `category` and `debtDelta`, and the whole log
is one flat top-level map — so a month, a category, a search or a per-person
balance is a filter over an array already in memory. The backend keeps the job
only it can do: run the parser, which needs a model, and hold the SQL projection
other devices read.

Consequences worth stating: the numbers are there offline, and changing the
month has no spinner between the click and the answer.

`GET /money/ledger` stays as it is and the planner's `DebtLedger` still uses it.
The money cell computes its own ledger from the Y.Doc because it needs something
SQL was never asked for — how old the debt is.

### Two rules hold throughout

- **Balance corrections are excluded from every statistic.** A correction is
  bookkeeping. Counting one as spending would mean fixing your wallet reads as a
  shopping trip.
- **Averages are medians.** One 20 triệu laptop drags a mean for months, and the
  question these figures answer is "what is normal for me" — precisely what a
  mean stops being able to say.

## 10. Wallets

Requested as "like Money Lover: if the balance is wrong I just fix it".

A wallet has **no stored balance**. It is the sum of the entries that moved
through it, recomputed every time — the same rule as the debt ledger and the day
total, and for the same reason: a counter two devices both increment is wrong
forever with no way to tell afterwards.

So "correct my balance" is expressed as an *entry*, not an assignment. The
difference between what the app thinks you have and what you say is really there
becomes a dated line with `category = 'Balance Adjustment'`. You get the
correction you asked for, the balance stays a pure sum, and the history still
says when it drifted and by how much. Two devices correcting the same wallet
keep both corrections rather than one overwriting the other.

```
planner Y.Doc
├── weeklyPlans   ← unchanged
├── moneyLog      ← unchanged, entries gain `walletId: string | null`
├── moneyWallets  : Y.Map<walletId → Y.Map{id,name,icon,createdAt}>   ← new
└── moneySettings : Y.Map<'monthlyBudget' → number>                   ← new
```

`moneySettings` is safe as a plain key/value map because its values are scalars:
a same-key conflict is last-write-wins on a number, which loses a preference at
worst — a different situation from the containers, where the same conflict
discards a whole map of entries.

`walletId: null` means "the default wallet". Everything logged before wallets
existed carries null, and `walletBalance` folds those into the first wallet, so
shipping wallets rewrote no entries and made none disappear.

Wallets are **client-side only**. `money_entries` gains no column: the DB is the
parse cache and the cross-device projection, and neither needs to know which
pocket the money sat in.

Which wallet new lines land in is a **device preference** (`localStorage`), not
shared data — a phone and a laptop plausibly spend from different wallets. It is
a small store with a `useSyncExternalStore` subscription rather than two
`localStorage` calls, because the choice is made in the money cell and read by
the planner's wallet chip, two React trees with nothing between them, and
`storage` events do not fire in the tab that did the writing.

The planner's money input stays at exactly one keystroke. Picking a wallet per
line would be correct bookkeeping and nobody would do it twice.

## 11. Pace — the honest version of a projection

The naive projection is wrong in a way that destroys trust within two weeks:
6 triệu over 14 days does not mean 12,9 triệu by month end, because rent was in
those 14 days and rent does not happen twice.

So spending splits into **fixed** (`Housing`, `Bills`, `Education` — obligations
that land on a date someone else picked) and **variable**. Only the variable part
is extrapolated. Fixed is counted once — and the opposite failure is handled too:
on the 14th with rent due on the 28th, `expectedFixed = max(fixedSoFar, median
fixed of past months)`, so a rent that has not landed is still expected.

The output people act on is not a monthly total but **an allowance per remaining
day**, with fixed costs still due already set aside — rent due on the 28th is not
money you may spend on the 20th. That needs a budget, the one number the user has
to supply; without it the cell shows pace only, plus an estimate for next month
from the median of complete months (and says how many it rests on).

## 12. What the lens shows

| Section | Answers |
|---|---|
| Summary | in / out / net for the month, with a warning when lines are still unparsed |
| Wallets | balance per wallet, correction, which one new lines go to |
| Categories | plain lines, plus "usually X" from the median of complete months |
| Pace | fixed/variable split, projection, next month, optional allowance |
| Unusual days | days costing ≥2.5× a normal day — a budget you never have to set |
| Recurring | same text, same amount, ~monthly. Deliberately strict: 3 sightings, amounts within 20%, gaps 20–40 days. A rule loose enough to also flag "cà phê" is a list nobody reads twice |
| Debts | the ledger, plus how old it is |
| Rhythm | spending against the mood logged the same day, and by weekday |
| Search | free text over `raw_text` |

Two of these exist only because this is a notebook and not a money app. **Rhythm**
is a join on a date string, because `moodLog` and `moneyLog` are both keyed by
day. **Search** works because slice 1 kept the user's line verbatim: `Food & Drink`
is somebody else's bucket, but "cà phê" is the thing you wanted to know about,
and no category set can ever answer it.

## 13. `parseDongShorthand`

A hand-written reader for `5tr`, `4tr5`, `300k`, `3.800.000`, used by the balance
and budget fields. Vietnamese money shorthand is a small closed grammar — four
multipliers and one compound form — so it fits in twenty lines and answers
instantly. The model earns its keep on prose like "cà phê với anh Tuấn 85k",
where the amount is one part of a sentence; it has no business being asked what
"5tr" means. Returns null rather than guessing, and the field echoes back what it
read before you commit.

## 14. Adding a node type is a breaking change for old clients

Found while verifying this in the running app, and worth writing down.

Inserting a `money_cell` while another client on the **previous build** was
connected to the same sync server did not merely fail to render there — that
client **deleted the node from the shared document**, and the deletion came back
over the websocket. y-prosemirror's `createNodeFromYElement` deletes any element
it cannot build against the current schema.

So a new cell type must be deployed before it is used anywhere, and any tab still
running the old build has to be reloaded. Nothing in the schema-migration
machinery helps: migrations run forward, and the damage is done by a client that
has not been upgraded yet.

## 15. Money x todo category

The one item slice 2 left out, and the reason it was awkward: todo categories
live in `todo_classifications`, keyed by week, while spending happens on a day.
Worse, `useClassificationSync` pushed results to Postgres and kept nothing — the
client had no copy of the answer at all.

Rather than add a range endpoint, the sync now **writes the categories back onto
the todo in Yjs**, exactly as `useMoneySync` writes parse results back onto a
money entry. That brings the join into the same place as everything else in this
slice, and it fixes a second thing on the way: the dirty-check is now split the
way the money sync's is, so a todo Postgres has already classified is copied
across for free instead of being re-classified on the user's own key. Before this
change every load re-derived nothing; after it, the first load would have
re-classified a whole year of planner if the split had been got wrong.

### It is not attribution, and the wording has to keep saying so

A day holds several todos across several categories and one pile of money.
Nothing ties a particular đồng to a particular task, and any UI that implies
otherwise is inventing a number.

So the figure is: *days on which you did X cost this much* — median spend across
those days, next to the median across all observed days.

Two rules keep it honest:

- **Only days with at least one money line count.** A day with no lines is not a
  day you spent nothing, it is a day you wrote nothing down; folding those in as
  zeroes would drag every category toward zero in exact proportion to how patchy
  the logging was. A day that *was* logged and came to nothing does count as
  zero, because that is a real observation.
- **Three days minimum.** Two is a coincidence, and a number nobody should read
  is worse than no number.

`TodoData` gains `categories: string[]`, `readTodoCategoriesByDate` takes the
per-day union, and `categoryLabel` in `taxonomy.ts` gives the todo taxonomy the
same identifier/label split the money taxonomy already had.

Coverage is bounded by `WEEKS_TO_SCAN` in `useClassificationSync` — the
correlation only sees as far back as classification has run. Since the answers
are now cached in the doc, that coverage only grows.

## 16. Still out

- receipt photo → entry
- feeding past corrections back as few-shot examples
- a runway figure, which needs a reliable notion of total balance across wallets
