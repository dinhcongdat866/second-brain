from datetime import datetime, timezone
from sqlalchemy import String, DateTime, Text, LargeBinary, BigInteger, Integer, Numeric, Index
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


class YjsUpdate(Base):
    """
    Append-only Yjs deltas for a document.

    A save used to send the whole document every few seconds; on a doc that only
    grows (gc is disabled for time-travel) that is hundreds of MB per hour of
    typing, and the read-merge-write cycle could drop a concurrent save. Deltas
    are appended here instead — nothing is ever overwritten, so a save cannot
    lose another device's work.

    Rows are consumed by a snapshot write into YjsDocument, which collapses
    everything up to a client-supplied id and deletes those rows.
    """
    __tablename__ = "yjs_updates"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    doc_id: Mapped[str] = mapped_column(String, nullable=False)
    user_id: Mapped[str] = mapped_column(String, nullable=False)
    update: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
    )

    __table_args__ = (Index("ix_yjs_updates_owner", "user_id", "doc_id", "id"),)


class DocumentShare(Base):
    """
    Who may reach a document through its link.

    `doc_id` alone is the primary key, unlike yjs_documents — a share row is the
    thing that makes an id resolvable to an owner without a session, which is
    exactly what a public URL needs. The cost is that legacy ids ('default',
    which every pre-registry account carries) can only be claimed once; the
    second claim is refused rather than silently pointing at the wrong account.
    """
    __tablename__ = "document_shares"

    doc_id: Mapped[str] = mapped_column(String, primary_key=True)
    user_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    # 'none' | 'read' | 'write' — what someone holding the link may do.
    link_access: Mapped[str] = mapped_column(String, nullable=False, default="none")
    # Copied from the owner's registry at publish time. The real name lives in a
    # Y.Doc the visitor cannot read, and a shared page with no title is worse
    # than a slightly stale one.
    name: Mapped[str] = mapped_column(String, nullable=False, default="")
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


class MoneyEntry(Base):
    """
    One money line, parsed out of free text by the LLM — the SQL projection of
    `moneyLog` in the planner Y.Doc.

    The Y.Doc keeps whatever is needed to render a day offline; this table
    exists for the questions SQL is good at: totals over a month, breakdown by
    category, and the per-counterparty debt balance.
    """
    __tablename__ = "money_entries"

    entry_id: Mapped[str] = mapped_column(String, primary_key=True)  # id of the Y.Doc entry
    user_id: Mapped[str] = mapped_column(String, nullable=False)
    date: Mapped[str] = mapped_column(String, nullable=False)        # 'YYYY-MM-DD'
    raw_text: Mapped[str] = mapped_column(Text, nullable=False)      # snapshot at parse time (dirty-check)

    # BigInteger, not Integer: 32 triệu fits in int32, 3 tỷ does not.
    # Signed đồng — negative is money out, positive is money in. NULL only when
    # the model found no amount; it is never defaulted to 0, because there is no
    # honest default for "how much money" (see status below).
    amount: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    category: Mapped[str] = mapped_column(String, nullable=False)
    counterparty: Mapped[str | None] = mapped_column(String, nullable=True)

    # Signed change to what this person is owed. Borrowing is positive (I owe
    # more), repaying negative. The balance is always SUM(debt_delta) — a stored
    # running balance would be unrecoverably wrong the first time two devices
    # both added to it.
    debt_delta: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)

    status: Mapped[str] = mapped_column(String, nullable=False)      # 'ok' | 'needs_amount'
    taxonomy_version: Mapped[int] = mapped_column(Integer, default=1)
    parsed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
    )

    __table_args__ = (Index("ix_money_entries_user_date", "user_id", "date"),)


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
