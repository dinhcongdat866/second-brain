from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.dialects.postgresql import insert

from app.db.engine import get_db
from app.db.models import CellEmbedding
from app.embeddings import embed

router = APIRouter(prefix="/embeddings", tags=["embeddings"])


class UpsertRequest(BaseModel):
    cell_id: str
    doc_id: str
    content: str


class UpsertResponse(BaseModel):
    cell_id: str


@router.post("/upsert", response_model=UpsertResponse)
async def upsert_embedding(body: UpsertRequest, db: AsyncSession = Depends(get_db)):
    vector = embed(body.content)
    stmt = (
        insert(CellEmbedding)
        .values(id=body.cell_id, doc_id=body.doc_id, content=body.content, embedding=vector)
        .on_conflict_do_update(
            index_elements=["id"],
            set_={"content": body.content, "embedding": vector},
        )
    )
    await db.execute(stmt)
    await db.commit()
    return UpsertResponse(cell_id=body.cell_id)
