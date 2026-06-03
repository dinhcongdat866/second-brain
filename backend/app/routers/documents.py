from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_user
from app.db.engine import get_db
from app.db.models import YjsDocument

router = APIRouter(prefix="/documents", tags=["documents"])

REGISTRY_DOC_ID = "__registry__"


@router.get("/{doc_id}/state")
async def get_state(
    doc_id: str,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_current_user),
):
    result = await db.execute(
        select(YjsDocument).where(
            YjsDocument.doc_id == doc_id,
            YjsDocument.user_id == user_id,
        )
    )
    doc = result.scalar_one_or_none()
    if doc is None:
        raise HTTPException(status_code=404, detail="Not found")
    return Response(content=bytes(doc.state), media_type="application/octet-stream")


@router.post("/{doc_id}/state", status_code=204)
async def save_state(
    doc_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_current_user),
):
    body = await request.body()
    if not body:
        raise HTTPException(status_code=400, detail="Empty body")
    now = datetime.now(timezone.utc)
    stmt = (
        pg_insert(YjsDocument)
        .values(doc_id=doc_id, user_id=user_id, state=body, updated_at=now)
        .on_conflict_do_update(
            index_elements=["doc_id"],
            set_={"state": body, "updated_at": now, "user_id": user_id},
        )
    )
    await db.execute(stmt)
    await db.commit()


@router.get("")
async def list_docs(
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_current_user),
):
    """Return all doc_ids + updated_at for the current user (excluding registry)."""
    result = await db.execute(
        select(YjsDocument.doc_id, YjsDocument.updated_at).where(
            YjsDocument.user_id == user_id,
            YjsDocument.doc_id != REGISTRY_DOC_ID,
        )
    )
    return [
        {"doc_id": row.doc_id, "updated_at": row.updated_at.isoformat()}
        for row in result.all()
    ]


@router.delete("/{doc_id}/state", status_code=204)
async def delete_state(
    doc_id: str,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_current_user),
):
    result = await db.execute(
        select(YjsDocument).where(
            YjsDocument.doc_id == doc_id,
            YjsDocument.user_id == user_id,
        )
    )
    doc = result.scalar_one_or_none()
    if doc is not None:
        await db.delete(doc)
        await db.commit()
