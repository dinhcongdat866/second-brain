"""Run once to set up schema. Called on app startup."""
from sqlalchemy import text
from app.db.engine import engine, Base


async def run_migrations() -> None:
    async with engine.begin() as conn:
        await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        await conn.run_sync(Base.metadata.create_all)

        # Phase 2: add user_id to tables that pre-date auth.
        # ADD COLUMN IF NOT EXISTS is idempotent — safe to run on every startup.
        for stmt in [
            "ALTER TABLE yjs_documents ADD COLUMN IF NOT EXISTS user_id VARCHAR NOT NULL DEFAULT ''",
            "ALTER TABLE usage_log     ADD COLUMN IF NOT EXISTS user_id VARCHAR NOT NULL DEFAULT ''",
            "ALTER TABLE images        ADD COLUMN IF NOT EXISTS user_id VARCHAR NOT NULL DEFAULT ''",
            "ALTER TABLE cell_embeddings ADD COLUMN IF NOT EXISTS user_id VARCHAR NOT NULL DEFAULT ''",
        ]:
            await conn.execute(text(stmt))

        # Phase 3: analytics tables (idempotent — create_all already handles new tables,
        # but the indexes below are explicit in case the table existed without them).
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_todo_classifications_user_week "
            "ON todo_classifications (user_id, week_start)"
        ))
        await conn.execute(text(
            "CREATE UNIQUE INDEX IF NOT EXISTS ix_mood_logs_user_date "
            "ON mood_logs (user_id, date)"
        ))

        # Phase 4: composite primary key (user_id, doc_id) on yjs_documents.
        # The original PK was doc_id alone, so the shared fixed doc_ids
        # (__registry__, __weekly-planner__, __memory__) collided across users:
        # the second user's save overwrote the first user's row, leaving the
        # original owner with a 404. Only run if the PK is still single-column,
        # so this is a no-op on every startup after the first conversion.
        is_single_col_pk = (await conn.execute(text(
            """
            SELECT COUNT(*) = 1
            FROM information_schema.key_column_usage
            WHERE table_name = 'yjs_documents'
              AND constraint_name = 'yjs_documents_pkey'
            """
        ))).scalar()
        if is_single_col_pk:
            await conn.execute(text(
                "ALTER TABLE yjs_documents DROP CONSTRAINT yjs_documents_pkey"
            ))
            await conn.execute(text(
                "ALTER TABLE yjs_documents ADD CONSTRAINT yjs_documents_pkey "
                "PRIMARY KEY (user_id, doc_id)"
            ))
        # The old standalone (user_id, doc_id) index is now redundant with the
        # composite PK's implicit index — drop it if it lingers from Phase 2.
        await conn.execute(text("DROP INDEX IF EXISTS ix_yjs_documents_user_doc"))

        # Phase 5: append-only Yjs deltas (yjs_updates). create_all above makes
        # the table; this index is stated explicitly so an existing table picks
        # it up too. Every read is "all rows for this owner+doc, in id order".
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_yjs_updates_owner "
            "ON yjs_updates (user_id, doc_id, id)"
        ))

        # Phase 6: money entries. Every read is a date range for one user, so
        # the index matches (user_id, date) — the same shape mood_logs uses.
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_money_entries_user_date "
            "ON money_entries (user_id, date)"
        ))

        # Phase 7: link sharing. create_all makes the table; the index is stated
        # explicitly so an existing table picks it up. Lookups go both ways —
        # by doc_id (a visitor resolving a link) and by user_id (the owner
        # listing what they have shared).
        await conn.execute(text(
            "CREATE INDEX IF NOT EXISTS ix_document_shares_user_id "
            "ON document_shares (user_id)"
        ))
        await conn.execute(text(
            "ALTER TABLE document_shares ADD COLUMN IF NOT EXISTS "
            "name VARCHAR NOT NULL DEFAULT ''"
        ))
