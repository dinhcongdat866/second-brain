from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.engine import get_db
from app.db.models import YjsDocument

router = APIRouter(prefix="/documents", tags=["documents"])


@router.get("/{doc_id}/state")
async def get_state(doc_id: str, db: AsyncSession = Depends(get_db)):
    doc = await db.get(YjsDocument, doc_id)
    if doc is None:
        raise HTTPException(status_code=404, detail="Not found")
    return Response(content=bytes(doc.state), media_type="application/octet-stream")


@router.post("/{doc_id}/state", status_code=204)
async def save_state(doc_id: str, request: Request, db: AsyncSession = Depends(get_db)):
    body = await request.body()
    if not body:
        raise HTTPException(status_code=400, detail="Empty body")
    now = datetime.now(timezone.utc)
    stmt = (
        pg_insert(YjsDocument)
        .values(doc_id=doc_id, state=body, updated_at=now)
        .on_conflict_do_update(
            index_elements=["doc_id"],
            set_={"state": body, "updated_at": now},
        )
    )
    await db.execute(stmt)
    await db.commit()


@router.delete("/{doc_id}/state", status_code=204)
async def delete_state(doc_id: str, db: AsyncSession = Depends(get_db)):
    doc = await db.get(YjsDocument, doc_id)
    if doc is not None:
        await db.delete(doc)
        await db.commit()
