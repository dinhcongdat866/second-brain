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
