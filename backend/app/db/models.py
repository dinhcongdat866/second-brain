from datetime import datetime, timezone
from sqlalchemy import String, DateTime, Text, LargeBinary, Integer, Numeric, Index
from sqlalchemy.orm import Mapped, mapped_column
from pgvector.sqlalchemy import Vector
from app.db.engine import Base

EMBEDDING_DIM = 384  # all-MiniLM-L6-v2 output size


class YjsDocument(Base):
    __tablename__ = "yjs_documents"

    # Composite PK: shared fixed doc_ids (__registry__, __weekly-planner__,
    # __memory__) are per-user, so doc_id alone is NOT unique across users.
    # A single-column PK let one user's save overwrite another's row (and steal
    # its user_id), 404-ing the original owner. The migration below converts
    # existing tables from the old single-column PK.
    doc_id: Mapped[str] = mapped_column(String, primary_key=True)
    user_id: Mapped[str] = mapped_column(String, primary_key=True)
    state: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )


class UsageLog(Base):
    """One row per AI response turn — queryable for cost analytics."""
    __tablename__ = "usage_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    doc_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    cell_id: Mapped[str] = mapped_column(String, nullable=False)
    input_tokens: Mapped[int] = mapped_column(Integer, nullable=False)
    output_tokens: Mapped[int] = mapped_column(Integer, nullable=False)
    cache_read_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    cache_creation_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    cost_usd: Mapped[float] = mapped_column(Numeric(10, 6), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        index=True,
    )


class Image(Base):
    """Standalone image blobs referenced by URL from the document."""
    __tablename__ = "images"

    id: Mapped[str] = mapped_column(String, primary_key=True)  # server-generated uuid
    user_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    doc_id: Mapped[str | None] = mapped_column(String, nullable=True, index=True)
    content_type: Mapped[str] = mapped_column(String, nullable=False)
    data: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
    )


class CellEmbedding(Base):
    __tablename__ = "cell_embeddings"

    id: Mapped[str] = mapped_column(String, primary_key=True)       # cell UUID from frontend
    user_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    doc_id: Mapped[str] = mapped_column(String, nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    embedding: Mapped[list[float]] = mapped_column(Vector(EMBEDDING_DIM))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )


class TodoClassification(Base):
    """AI-assigned categories for weekly planner todos (personal analytics)."""
    __tablename__ = "todo_classifications"

    todo_id: Mapped[str] = mapped_column(String, primary_key=True)   # YTodo id from frontend
    user_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    week_start: Mapped[str] = mapped_column(String, nullable=False)  # 'YYYY-MM-DD', indexed for range queries
    todo_text: Mapped[str] = mapped_column(Text, nullable=False)      # snapshot at classification time
    categories: Mapped[str] = mapped_column(Text, nullable=False)     # JSON array: '["Personal Project","Rest"]'
    taxonomy_version: Mapped[int] = mapped_column(Integer, default=1)
    classified_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
    )

    __table_args__ = (Index("ix_todo_classifications_user_week", "user_id", "week_start"),)


class MoodLog(Base):
    """Daily mood/energy log for personal analytics pattern detection."""
    __tablename__ = "mood_logs"

    id: Mapped[str] = mapped_column(String, primary_key=True)        # UUID from frontend
    user_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    date: Mapped[str] = mapped_column(String, nullable=False)        # 'YYYY-MM-DD'
    energy: Mapped[int] = mapped_column(Integer, nullable=False)     # 1-5
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
    )

    __table_args__ = (
        Index("ix_mood_logs_user_date", "user_id", "date", unique=True),
    )
