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
