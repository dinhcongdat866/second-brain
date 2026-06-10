from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, text

from app.auth import get_current_user
from app.db.engine import get_db
from app.db.models import CellEmbedding
from app.embeddings import embed_async

router = APIRouter(prefix="/search", tags=["search"])


class SearchResult(BaseModel):
    cell_id: str
    doc_id: str
    content: str
    score: float


@router.get("", response_model=list[SearchResult])
async def search(
    q: str = Query(..., min_length=1),
    limit: int = Query(5, ge=1, le=20),
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_current_user),
):
    vector = await embed_async(q)
    rows = await db.execute(
        select(
            CellEmbedding.id,
            CellEmbedding.doc_id,
            CellEmbedding.content,
            (1 - CellEmbedding.embedding.cosine_distance(vector)).label("score"),
        )
        .where(CellEmbedding.user_id == user_id)
        .order_by(text("score DESC"))
        .limit(limit)
    )
    return [
        SearchResult(cell_id=r.id, doc_id=r.doc_id, content=r.content, score=r.score)
        for r in rows.all()
    ]
