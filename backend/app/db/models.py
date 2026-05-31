from datetime import datetime, timezone
from sqlalchemy import String, DateTime, Text, LargeBinary
from sqlalchemy.orm import Mapped, mapped_column
from pgvector.sqlalchemy import Vector
from app.db.engine import Base

EMBEDDING_DIM = 384  # all-MiniLM-L6-v2 output size


class YjsDocument(Base):
    __tablename__ = "yjs_documents"

    doc_id: Mapped[str] = mapped_column(String, primary_key=True)
    state: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )


class CellEmbedding(Base):
    __tablename__ = "cell_embeddings"

    id: Mapped[str] = mapped_column(String, primary_key=True)       # cell UUID from frontend
    doc_id: Mapped[str] = mapped_column(String, nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    embedding: Mapped[list[float]] = mapped_column(Vector(EMBEDDING_DIM))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
