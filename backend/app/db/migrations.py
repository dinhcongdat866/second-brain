"""Run once to set up schema. Called on app startup."""
from sqlalchemy import text
from app.db.engine import engine, Base


async def run_migrations() -> None:
    async with engine.begin() as conn:
        await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))
        await conn.run_sync(Base.metadata.create_all)
