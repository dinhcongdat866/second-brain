from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.dialects.postgresql import insert

from app.auth import get_current_user
from app.db.engine import get_db
from app.db.models import CellEmbedding
from app.embeddings import embed_async

router = APIRouter(prefix="/embeddings", tags=["embeddings"])


class UpsertRequest(BaseModel):
    cell_id: str
    doc_id: str
    content: str


class UpsertResponse(BaseModel):
    cell_id: str


@router.post("/upsert", response_model=UpsertResponse)
async def upsert_embedding(
    body: UpsertRequest,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_current_user),
):
    vector = await embed_async(body.content)
    stmt = (
        insert(CellEmbedding)
        .values(
            id=body.cell_id,
            user_id=user_id,
            doc_id=body.doc_id,
            content=body.content,
            embedding=vector,
        )
        .on_conflict_do_update(
            index_elements=["id"],
            set_={"content": body.content, "embedding": vector, "user_id": user_id},
        )
    )
    await db.execute(stmt)
    await db.commit()
    return UpsertResponse(cell_id=body.cell_id)
