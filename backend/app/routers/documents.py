import struct
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_user
from app.db.engine import get_db
from app.db.models import YjsDocument, YjsUpdate

router = APIRouter(prefix="/documents", tags=["documents"])

REGISTRY_DOC_ID = "__registry__"

# A Yjs update is opaque to this server and two updates cannot simply be
# concatenated, so /sync frames each blob as [4-byte big-endian length][bytes].
# The client splits the frames and applies them in order. Keeping the merge on
# the client is deliberate: the backend never needs to understand Yjs.
_LEN = struct.Struct(">I")


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


@router.get("/{doc_id}/sync")
async def get_sync(
    doc_id: str,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_current_user),
):
    """
    Everything the client needs to rebuild the document: the last snapshot
    followed by every delta appended since, framed as [len][bytes] pairs.

    `X-Max-Update-Id` tells the client how far it has consumed; it passes that
    value back when writing a snapshot so only the rows it actually merged are
    deleted. Without it, a snapshot could delete a delta that another device
    appended a moment earlier.
    """
    snapshot = (await db.execute(
        select(YjsDocument.state).where(
            YjsDocument.doc_id == doc_id,
            YjsDocument.user_id == user_id,
        )
    )).scalar_one_or_none()

    rows = (await db.execute(
        select(YjsUpdate.id, YjsUpdate.update)
        .where(YjsUpdate.doc_id == doc_id, YjsUpdate.user_id == user_id)
        .order_by(YjsUpdate.id)
    )).all()

    if snapshot is None and not rows:
        raise HTTPException(status_code=404, detail="Not found")

    parts: list[bytes] = []
    if snapshot is not None:
        parts.append(_LEN.pack(len(snapshot)) + bytes(snapshot))
    for row in rows:
        blob = bytes(row.update)
        parts.append(_LEN.pack(len(blob)) + blob)

    return Response(
        content=b"".join(parts),
        media_type="application/octet-stream",
        headers={"X-Max-Update-Id": str(rows[-1].id if rows else 0)},
    )


@router.post("/{doc_id}/updates", status_code=204)
async def append_update(
    doc_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_current_user),
):
    """
    Append one delta. This never overwrites anything, so two devices saving at
    the same moment cannot clobber each other — the reason this endpoint exists.
    """
    body = await request.body()
    if not body:
        raise HTTPException(status_code=400, detail="Empty body")
    db.add(YjsUpdate(doc_id=doc_id, user_id=user_id, update=body))
    await db.commit()


@router.post("/{doc_id}/state", status_code=204)
async def save_state(
    doc_id: str,
    request: Request,
    up_to: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_current_user),
):
    """
    Write a full snapshot, collapsing the deltas it already contains.

    `up_to` is the highest update id the client had merged when it built this
    body. Only rows at or below it are deleted; anything appended later by
    another device survives and is merged on the next read.
    """
    body = await request.body()
    if not body:
        raise HTTPException(status_code=400, detail="Empty body")
    now = datetime.now(timezone.utc)
    stmt = (
        pg_insert(YjsDocument)
        .values(doc_id=doc_id, user_id=user_id, state=body, updated_at=now)
        .on_conflict_do_update(
            # Composite key: a save only ever updates the caller's OWN row, never
            # another user's row that happens to share this doc_id.
            index_elements=["user_id", "doc_id"],
            set_={"state": body, "updated_at": now},
        )
    )
    await db.execute(stmt)
    if up_to > 0:
        await db.execute(
            delete(YjsUpdate).where(
                YjsUpdate.doc_id == doc_id,
                YjsUpdate.user_id == user_id,
                YjsUpdate.id <= up_to,
            )
        )
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
    # Deltas outlive the snapshot row, so they must go too — otherwise a
    # deleted document reappears from its leftover updates on the next read.
    await db.execute(
        delete(YjsUpdate).where(
            YjsUpdate.doc_id == doc_id,
            YjsUpdate.user_id == user_id,
        )
    )
    await db.commit()
