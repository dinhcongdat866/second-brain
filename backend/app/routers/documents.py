import struct
from datetime import datetime, timedelta, timezone

import jwt
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.access import AccessDenied, DocAccess, decide_access, require_write
from app.auth import get_current_user, get_optional_user
from app.config import settings
from app.db.engine import get_db
from app.db.models import DocumentShare, YjsDocument, YjsUpdate

router = APIRouter(prefix="/documents", tags=["documents"])

REGISTRY_DOC_ID = "__registry__"

# Per-user singletons with fixed ids. They are never shareable: they hold the
# document list, the whole planner and the memory file, none of which belong to
# any one document a link might point at.
RESERVED_DOC_IDS = {REGISTRY_DOC_ID, "__weekly-planner__", "__memory__"}

LINK_ACCESS_VALUES = {"none", "read", "write"}

# How long a room token stays valid. Long enough that a normal working session
# never notices, short enough that revoking a share takes effect the same day.
ROOM_TOKEN_TTL = timedelta(hours=12)

# A Yjs update is opaque to this server and two updates cannot simply be
# concatenated, so /sync frames each blob as [4-byte big-endian length][bytes].
# The client splits the frames and applies them in order. Keeping the merge on
# the client is deliberate: the backend never needs to understand Yjs.
_LEN = struct.Struct(">I")


async def resolve_doc_access(
    doc_id: str,
    db: AsyncSession,
    viewer_id: str | None,
) -> DocAccess:
    """Gather the two facts decide_access needs, then apply the rules."""
    viewer_owns_copy = False
    if viewer_id is not None:
        viewer_owns_copy = (await db.execute(
            select(YjsDocument.doc_id).where(
                YjsDocument.doc_id == doc_id,
                YjsDocument.user_id == viewer_id,
            )
        )).scalar_one_or_none() is not None

    share = (await db.execute(
        select(DocumentShare).where(DocumentShare.doc_id == doc_id)
    )).scalar_one_or_none()

    try:
        return decide_access(
            viewer_id,
            viewer_owns_copy,
            share.user_id if share else None,
            share.link_access if share else None,
        )
    except AccessDenied as denied:
        raise HTTPException(status_code=denied.status, detail=denied.detail)


def _writable(access: DocAccess) -> DocAccess:
    try:
        return require_write(access)
    except AccessDenied as denied:
        raise HTTPException(status_code=denied.status, detail=denied.detail)


@router.get("/{doc_id}/state")
async def get_state(
    doc_id: str,
    db: AsyncSession = Depends(get_db),
    viewer_id: str | None = Depends(get_optional_user),
):
    access = await resolve_doc_access(doc_id, db, viewer_id)
    result = await db.execute(
        select(YjsDocument).where(
            YjsDocument.doc_id == doc_id,
            YjsDocument.user_id == access.owner_id,
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
    viewer_id: str | None = Depends(get_optional_user),
):
    """
    Everything the client needs to rebuild the document: the last snapshot
    followed by every delta appended since, framed as [len][bytes] pairs.

    `X-Max-Update-Id` tells the client how far it has consumed; it passes that
    value back when writing a snapshot so only the rows it actually merged are
    deleted. Without it, a snapshot could delete a delta that another device
    appended a moment earlier.
    """
    access = await resolve_doc_access(doc_id, db, viewer_id)

    snapshot = (await db.execute(
        select(YjsDocument.state).where(
            YjsDocument.doc_id == doc_id,
            YjsDocument.user_id == access.owner_id,
        )
    )).scalar_one_or_none()

    rows = (await db.execute(
        select(YjsUpdate.id, YjsUpdate.update)
        .where(YjsUpdate.doc_id == doc_id, YjsUpdate.user_id == access.owner_id)
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
    viewer_id: str | None = Depends(get_optional_user),
):
    """
    Append one delta. This never overwrites anything, so two devices saving at
    the same moment cannot clobber each other — the reason this endpoint exists.

    A delta from someone editing through a write link is stored under the
    OWNER's user_id, not theirs. Anything else would file the edit in an account
    the owner never reads, and the work would simply disappear.
    """
    access = _writable(await resolve_doc_access(doc_id, db, viewer_id))
    body = await request.body()
    if not body:
        raise HTTPException(status_code=400, detail="Empty body")
    db.add(YjsUpdate(doc_id=doc_id, user_id=access.owner_id, update=body))
    await db.commit()


@router.post("/{doc_id}/state", status_code=204)
async def save_state(
    doc_id: str,
    request: Request,
    up_to: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
    viewer_id: str | None = Depends(get_optional_user),
):
    """
    Write a full snapshot, collapsing the deltas it already contains.

    `up_to` is the highest update id the client had merged when it built this
    body. Only rows at or below it are deleted; anything appended later by
    another device survives and is merged on the next read.
    """
    access = _writable(await resolve_doc_access(doc_id, db, viewer_id))
    body = await request.body()
    if not body:
        raise HTTPException(status_code=400, detail="Empty body")
    now = datetime.now(timezone.utc)
    stmt = (
        pg_insert(YjsDocument)
        .values(doc_id=doc_id, user_id=access.owner_id, state=body, updated_at=now)
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
                YjsUpdate.user_id == access.owner_id,
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
    # The share row would otherwise keep the id resolvable after the document
    # behind it is gone, leaving a live link to nothing.
    await db.execute(
        delete(DocumentShare).where(
            DocumentShare.doc_id == doc_id,
            DocumentShare.user_id == user_id,
        )
    )
    await db.commit()


# ---------------------------------------------------------------------------
# Link sharing
# ---------------------------------------------------------------------------


class ShareIn(BaseModel):
    link_access: str
    name: str = Field(default="", max_length=200)


class ShareOut(BaseModel):
    doc_id: str
    owner_id: str
    link_access: str
    name: str
    is_owner: bool
    can_write: bool


@router.get("/{doc_id}/share", response_model=ShareOut)
async def get_share(
    doc_id: str,
    db: AsyncSession = Depends(get_db),
    viewer_id: str | None = Depends(get_optional_user),
):
    """
    What this caller may do with this document — the question the client asks
    before it decides whether to open an editor, a reader, or nothing at all.
    """
    access = await resolve_doc_access(doc_id, db, viewer_id)
    share = (await db.execute(
        select(DocumentShare).where(DocumentShare.doc_id == doc_id)
    )).scalar_one_or_none()
    is_owner = viewer_id is not None and viewer_id == access.owner_id
    return ShareOut(
        doc_id=doc_id,
        owner_id=access.owner_id,
        link_access=share.link_access if share else "none",
        name=share.name if share else "",
        is_owner=is_owner,
        can_write=access.can_write,
    )


@router.put("/{doc_id}/share", response_model=ShareOut)
async def set_share(
    doc_id: str,
    body: ShareIn,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_current_user),
):
    """
    Publish or unpublish. Owner only, and deliberately not routed through
    resolve_doc_access: someone editing through a write link must not be able to
    widen the access they were given.
    """
    if body.link_access not in LINK_ACCESS_VALUES:
        raise HTTPException(status_code=400, detail="Unknown link_access")
    if doc_id in RESERVED_DOC_IDS:
        raise HTTPException(status_code=400, detail="This document cannot be shared")

    existing = (await db.execute(
        select(DocumentShare).where(DocumentShare.doc_id == doc_id)
    )).scalar_one_or_none()

    if existing is not None and existing.user_id != user_id:
        # A share row is what makes an id resolvable without a session, so it
        # has to be globally unique — and legacy ids ('default') are not. The
        # honest answer is to refuse, not to point the link at the wrong account.
        raise HTTPException(
            status_code=409,
            detail="This document id is already published by another account",
        )

    now = datetime.now(timezone.utc)
    if existing is None:
        db.add(DocumentShare(
            doc_id=doc_id,
            user_id=user_id,
            link_access=body.link_access,
            name=body.name,
            updated_at=now,
        ))
    else:
        existing.link_access = body.link_access
        if body.name:
            existing.name = body.name
        existing.updated_at = now
    await db.commit()

    return ShareOut(
        doc_id=doc_id,
        owner_id=user_id,
        link_access=body.link_access,
        name=body.name or (existing.name if existing else ""),
        is_owner=True,
        can_write=True,
    )


# ---------------------------------------------------------------------------
# Room tokens for the y-websocket relay
# ---------------------------------------------------------------------------


class RoomTokenOut(BaseModel):
    room: str
    token: str
    can_write: bool
    expires_in: int


def _room_name(owner_id: str, doc_id: str) -> str:
    """Must stay identical to collabRoom() in src/collab/ydoc.ts."""
    return f"notebook-{owner_id}-{doc_id}"


@router.post("/{doc_id}/room-token", response_model=RoomTokenOut)
async def room_token(
    doc_id: str,
    db: AsyncSession = Depends(get_db),
    viewer_id: str | None = Depends(get_optional_user),
):
    """
    A short-lived ticket for one relay room.

    The relay cannot reach the database and knows nothing about Supabase, so the
    decision is made here and handed over signed. It carries the room name and
    one bit — may this connection write — which is the whole of what the relay
    needs to enforce, and the only place a read-only link is actually read-only:
    the client-side flag is a courtesy, this is the fence.
    """
    if not settings.sync_jwt_secret:
        raise HTTPException(status_code=503, detail="SYNC_JWT_SECRET is not configured")

    if doc_id in RESERVED_DOC_IDS:
        # The registry, the planner and the memory file are per-user singletons.
        # They are never shared, so the only valid answer is the caller's own room.
        if viewer_id is None:
            raise HTTPException(status_code=401, detail="Not authenticated")
        owner_id, can_write = viewer_id, True
    else:
        access = await resolve_doc_access(doc_id, db, viewer_id)
        owner_id, can_write = access.owner_id, access.can_write

    room = _room_name(owner_id, doc_id)
    now = datetime.now(timezone.utc)
    token = jwt.encode(
        {"room": room, "w": can_write, "iat": now, "exp": now + ROOM_TOKEN_TTL},
        settings.sync_jwt_secret,
        algorithm="HS256",
    )
    return RoomTokenOut(
        room=room,
        token=token,
        can_write=can_write,
        expires_in=int(ROOM_TOKEN_TTL.total_seconds()),
    )
