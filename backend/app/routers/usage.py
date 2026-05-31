from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.engine import get_db
from app.db.models import UsageLog

router = APIRouter(prefix="/usage", tags=["usage"])


class UsagePayload(BaseModel):
    doc_id: str
    cell_id: str
    input_tokens: int
    output_tokens: int
    cache_read_tokens: int = 0
    cache_creation_tokens: int = 0
    cost_usd: float


@router.post("/log", status_code=201)
async def log_usage(payload: UsagePayload, db: AsyncSession = Depends(get_db)):
    entry = UsageLog(
        doc_id=payload.doc_id,
        cell_id=payload.cell_id,
        input_tokens=payload.input_tokens,
        output_tokens=payload.output_tokens,
        cache_read_tokens=payload.cache_read_tokens,
        cache_creation_tokens=payload.cache_creation_tokens,
        cost_usd=payload.cost_usd,
    )
    db.add(entry)
    await db.commit()
    return {"ok": True}
