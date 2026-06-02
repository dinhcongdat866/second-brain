# The Editor (ProseMirror)

The editing layer. We use **raw ProseMirror** (no Tiptap) for full control over the schema and
the React integration.

## Schema — `src/schema.ts`

The structure is intentionally rigid so the rest of the code can assume invariants:

```
doc
└── cell+                          (only cells at the top level)
    ├── markdown_cell  → block+    (paragraph, heading, blockquote, hr, image)
    ├── ai_cell        → atom      (no PM content; React + Yjs render it)
    └── weekly_planner_cell → atom (no PM content; React + Yjs render it)
```

- **Group taxonomy**: `cell` (top-level only) vs `block` (inside a cell). They're mutually
  exclusive, so cells *cannot* nest — enforced by the schema, not by defensive code.
- **`isolating: true`** on cells so Backspace doesn't merge one cell into another.
- **Atom cells** (`ai_cell`, `weekly_planner_cell`) own no ProseMirror content; their data
  lives in Yjs and a NodeView draws them.
- **Marks**: `strong`, `em`, `code`, `link`, `strikethrough`, plus attribute-carrying style
  marks (`text_color`, `bg_color`, `font_size`) used by the floating toolbar.

Cells carry a `uuid` id + timestamps. Always create them through the `createMarkdownCell` /
`createAiCell` / `createWeeklyPlannerCell` helpers (schema defaults can't be functions).

## Commands — `src/commands.ts`

All editing actions are plain ProseMirror commands so they can be triggered from **both** a
keymap and the slash menu (single source of truth). Examples:

- Smart insert (Notion-style): convert an empty block to the new type, or insert a sibling
  below if non-empty.
- Cell insertion always happens at the doc level (walk up to the doc's direct child).
- Guards: don't merge a paragraph into a blockquote on Backspace; don't delete protected atom
  cells with Backspace.

## Plugins — `src/plugins/`

| Plugin | Role |
|--------|------|
| `slashMenuPlugin` | Detects `/`, tracks the query, handles keyboard nav, bridges state to Zustand. |
| `slashOptions` | The single list of slash commands (`{id, label, group, run}`). |
| `placeholderPlugin` | "Start writing…" decoration on empty cells. |
| `ensureCellPlugin` | Safety net: if the doc collapses to a single non-cell block, backfill a cell. |
| `selectionPlugin` | Pub/sub of selection changes for the floating toolbar. |
| `imagePastePlugin` | Paste/drop images in a markdown cell → resize → upload → insert image node. |

Plus `clipboard.ts` (`transformPastedHTML` flattens pasted lists/tables; `pasteNormPlugin`
exits a heading after paste).

## NodeViews — `src/nodeViews/` (the hard part)

A **NodeView** lets a React component own the rendering of a ProseMirror node. Two patterns:

**Atom node (`ai_cell`, `weekly_planner_cell`)** — React renders everything; PM owns nothing
inside:

```
dom (wrapper)
└── React renders the whole UI
    stopEvent() = true        ← React handles all events
    ignoreMutation() = true   ← PM ignores DOM mutations
```

**Sibling node (`markdown_cell`)** — PM owns the text, React owns extra controls (copy button,
timestamp) side-by-side:

```
dom (wrapper)
├── contentDOM (PM-owned: paragraphs, headings…)
└── reactHost (React-owned: copy button, timestamp)
```

> **The classic trap**: a sibling NodeView without a correct `ignoreMutation` filter creates an
> infinite loop — React re-renders → mutates `reactHost` → PM's MutationObserver fires →
> dispatches a transaction → re-renders → … The fix is to ignore mutations *only* within the
> React-owned subtree (`this.reactHost.contains(mutation.target)`).

The big AI cell component is split for readability into `nodeViews/ai/` (hooks: `useTurns`,
`useAiConfig`, `useAiStream`; views: `AiTurnList`, `AiConfigPanel`, `AiInput`).

## PM ⇆ React state bridge

ProseMirror plugin state is canonical; a plugin's `view().update()` (a side-effect-safe spot)
mirrors what React needs into a **Zustand** store. React subscribes to Zustand instead of
polling PM.

> Rule: never call into Zustand from a plugin's `apply()` — `apply` must be pure.
