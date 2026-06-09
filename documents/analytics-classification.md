# Analytics & Classification

Two overlapping features: **classification** turns raw todo text into structured categories,
**analytics** aggregates those categories plus mood logs into charts, patterns, and an AI narrative.

---

## 1. Data models

```sql
-- One row per todo item, written by the classifier, read by analytics queries.
todo_classifications (
  todo_id          TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  week_start       TEXT NOT NULL,   -- 'YYYY-MM-DD' Monday of the todo's week
  todo_text        TEXT,            -- snapshot at classification time (dirty-check)
  categories       TEXT,            -- JSON array: '["Work","Job Search"]'
  taxonomy_version INT,             -- bump when CATEGORIES list changes → re-classify
  classified_at    TIMESTAMPTZ
)

-- One row per day the user logs their energy level.
mood_logs (
  id        UUID PRIMARY KEY,
  user_id   TEXT NOT NULL,
  date      TEXT NOT NULL,          -- 'YYYY-MM-DD'
  energy    INT CHECK (energy BETWEEN 1 AND 5),
  note      TEXT
)
```

---

## 2. Taxonomy

Defined in `backend/app/routers/analytics.py` (`CATEGORIES`) and mirrored on the
frontend in `src/lib/taxonomy.ts` (`CAT`).

Current categories (v3):
`Work`, `Job Search`, `Personal Project`, `Mental Work`, `Chores`,
`Social`, `Leisure`, `Rest`, `Health`, `Bad mental health`, `Bad physical health`

`taxonomy_version` in the DB must equal `CURRENT_TAXONOMY_VERSION` on the client
(`src/hooks/useClassificationSync.ts`). If the taxonomy changes, bump both constants
and all stored rows are re-classified automatically on next app load.

---

## 3. Classification flow

```
App load (auth users only)
  └─ useClassificationSync(plannerYdoc)          [src/hooks/useClassificationSync.ts]
       │
       ├─ 1. Read last 4 weeks of todos from plannerYdoc (Yjs in-memory)
       │       Yjs path: WEEKLY_PLANS_KEY → plan → weeks → weekStart → day → todo[]
       │       stripMarkup() removes {c=…}, **bold**, ~~strike~~ before sending to AI
       │
       ├─ 2. Fetch stored classifications per week
       │       GET /analytics/classifications?week_start=YYYY-MM-DD  (one call per week)
       │
       ├─ 3. Dirty check — mark todo as dirty if:
       │       • todo_id not in DB
       │       • todo_text changed since last classification
       │       • taxonomy_version in DB < CURRENT_TAXONOMY_VERSION
       │
       └─ 4. POST /analytics/classify  { todos: TodoItem[] }  (batches of 50)
               └─ backend calls Claude Haiku per todo → { "categories": ["Work"] }
                  upserts into todo_classifications
```

**The hook runs once on mount.** New todos added in the same session are classified on
the *next* page load (or when `sync()` is called manually — e.g. from the Generate Report button).

### Why classify on app load, not on Generate Report

- The analytics context string (injected into every AI chat system prompt) reads from
  classification data. If classify were deferred to report generation, AI chat would have
  no category context until the user opens the report page.
- The dirty-check makes repeated loads cheap: if nothing changed, `dirty.length === 0`
  and no API calls are made.

---

## 4. Analytics report flow

```
User opens /ai-report
  │
  ├─ GET /analytics/report-data?from_date=…&to_date=…
  │     SQL: unnest categories JSON array, COUNT per category, compare to prev period
  │     SQL: join mood_logs for every day in range (null for unlogged days)
  │     Returns: { categoryBreakdown: CategoryCount[], moodTimeline: MoodPoint[] }
  │
  ├─ evaluatePatterns(breakdown, timeline)      [src/lib/analyticsRules.ts — pure client]
  │     Rule 1  BURNOUT_SIGNAL       energy < 3 for 2+ consecutive days OR bad mental ≥ 2×
  │     Rule 2  HIGH_INTENSITY       demanding% ≥ 60 AND restorative% < 15
  │     Rule 3  RECOVERY_PERIOD      mood ≥ 3 sustained after burnout (child of Rule 1)
  │     Rule 4  MOOD_CORRELATION     very low days + correlating categories present
  │     Rule 5  CATEGORY_CONCENTRATION  single category > 40%
  │     Rule 6  JOB_SEARCH_ACTIVE    Job Search ≥ 10% of todos
  │     Rule 7  REFLECTION_WEEK      Mental Work ≥ 15%
  │
  └─ POST /analytics/generate  { period, categoryBreakdown, moodTimeline, detectedPatterns }
        backend formats data as plain text, calls Claude Sonnet (streaming)
        returns: { narrative, prediction { text, confidence }, proactiveQuestions[] }
```

### Report-data response shape

```json
{
  "categoryBreakdown": [
    { "category": "Work",       "count": 12, "pct": 40.0, "trend": "up"     },
    { "category": "Job Search", "count":  8, "pct": 26.7, "trend": "stable" },
    { "category": "Rest",       "count":  4, "pct": 13.3, "trend": "down"   }
  ],
  "moodTimeline": [
    { "date": "2026-05-11", "energy": 3,    "note": "tired" },
    { "date": "2026-05-12", "energy": null, "note": null    },
    { "date": "2026-05-13", "energy": 4,    "note": null    }
  ]
}
```

`trend` is computed by comparing the current period to the previous period of equal length:
ratio > 1.15 → `up`, < 0.85 → `down`, otherwise `stable`.

---

## 5. Analytics context in AI chat

`useAnalyticsContext` fetches report-data for the last 30 days on app load (once per session),
runs `evaluatePatterns`, then formats everything into a plain-text block injected as a
separate system prompt block (with `cache_control: ephemeral`) into every AI cell request.

Example output injected into system prompt:
```
--- PERSONAL ANALYTICS (2026-05-11 → 2026-06-09) ---
Category breakdown (30 todos classified):
  Work                    40.0% ↑
  Job Search              26.7% →
  Rest                    13.3% ↓
  Leisure                 10.0% →

Mood (22/30 days logged): avg 3.2/5, 3 low days, 8 high days

Active patterns:
  [ALERT] BURNOUT_SIGNAL — energy < 3 for 2 consecutive days (May 20–21).
  [INFO] JOB_SEARCH_ACTIVE — 8 todos (26.7%, → stable vs prior period).

Use this data when answering questions about the user's life, habits, or patterns.
```

---

## 6. Backend endpoints (analytics router)

| Endpoint | Purpose |
|----------|---------|
| `POST /analytics/classify` | Classify a batch of todos (max 50). Calls Haiku per item. Upserts into `todo_classifications`. |
| `GET /analytics/classifications?week_start=` | Fetch stored classifications for a week (for dirty-check). |
| `GET /analytics/report-data?from_date=&to_date=` | SQL aggregates: category breakdown + mood timeline. |
| `POST /analytics/generate` | Stream AI narrative from pre-formatted report data. |
| `POST /analytics/mood` | Log a mood entry (energy 1–5 + optional note). |
| `GET /analytics/mood?date=` | Fetch mood entry for a specific date. |
