# AI

The AI layer turns an `ai_cell` into a streaming, context-aware chat with Claude (or a local
Ollama model). Conversations are stored in Yjs (`aiThreads`), so they sync and persist like
everything else.

## A conversation's data

`aiThreads` is `Map<cellId, Y.Array<turn>>`, where each turn is a `Y.Map`:

```
turn = { role: 'user' | 'assistant',
         content: Y.Text,          ← streamed into, token by token
         created_at, tokens_in, tokens_out, cost_usd,
         thinking?: Y.Text, search_query?, search_sources?, images? }
```

Storing `content` as a `Y.Text` is the trick that makes streaming cheap: appending a token is a
tiny CRDT op outside the ProseMirror document, so it doesn't churn the editor or undo history,
yet it still syncs live to every viewer.

## Submit flow — `nodeViews/ai/useAiStream.ts` + `collab/claudeStream.ts`

```
prompt → addTurn(user) + addTurn(assistant, empty)
       → compressHistory(...)        (shrink long threads)
       → searchCells(prompt)         (RAG, pgvector)
       → streamClaudeReply(...)
           system = local + doc context (+ RAG)   ← cached block
           for await (token) → assistantTurn.content.insert(token)
```

The assistant `Y.Text` is created up front and filled by the stream loop, so the aurora
"streaming" animation and the text appear live for everyone in the room.

## Context: 3 tiers

| Tier | Source | Mechanism |
|------|--------|-----------|
| 1 — Local | the few markdown cells just above the AI cell | `extractLocalContext` |
| 2 — Doc | the whole document, truncated | `extractDocContext` |
| 3 — RAG | semantically similar cells **across all docs** | `searchCells` → pgvector |

Tiers 1–2 go in the **system prompt** (sent with `cache_control: ephemeral`, so they're nearly
free after the first call). Tier 3 is dynamic, so it goes in the user message (uncached).

## Providers

- **Anthropic (Claude)** — via the backend reverse-proxy (`${VITE_BACKEND_URL}/anthropic`); the
  API key is injected server-side and never ships in the browser. Models: Haiku / Sonnet / Opus.
- **Ollama (local)** — talks directly to the local daemon; nothing leaves the machine. Models
  are auto-discovered (`/api/tags`); thinking / web-search / vision are skipped.

## Features

- **Extended thinking** (Sonnet/Opus) — streamed into a separate `thinking` `Y.Text`, shown in
  a collapsible block.
- **Web search** — Anthropic server tool; the query + source links are captured and persisted.
- **Vision (paste images)** — paste/drop an image into the AI prompt; it's downscaled to JPEG,
  stored as base64 on the user turn, and attached to the request as an image block. Images are
  sent only on the turn they appear (not re-sent later — cost).
- **History compression** — `historyCompressor.ts`: when a thread exceeds ~8k tokens, old turns
  are summarized (Haiku) and only the recent window is sent verbatim (~20× cheaper on long
  threads).
- **Cost tracking** — per-turn token usage + cost is stored on the turn and logged to Neon
  (`usage_log`); the header shows the running conversation total.

## A correctness detail: presentation state from Yjs

The "is streaming" aurora and the running cost are **derived from the thread**, not local React
state — otherwise a peer who didn't type the prompt would see neither. A turn is "streaming"
while its `created_at` is still empty (set in `onDone`), and the cost is `Σ turn.cost_usd`. This
keeps the UI consistent across all viewers.
