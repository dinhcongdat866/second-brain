import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_user
from app.db.engine import get_db
from app.db.models import Image

router = APIRouter(prefix="/images", tags=["images"])

MAX_BYTES = 8 * 1024 * 1024  # 8 MB safety cap


@router.post("", status_code=201)
async def upload_image(
    request: Request,
    doc_id: str | None = None,
    content_type: str = Header(default="image/jpeg"),
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_current_user),
):
    body = await request.body()
    if not body:
        raise HTTPException(status_code=400, detail="Empty body")
    if len(body) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="Image too large")

    img_id = uuid.uuid4().hex
    db.add(Image(
        id=img_id,
        user_id=user_id,
        doc_id=doc_id,
        content_type=content_type,
        data=body,
        created_at=datetime.now(timezone.utc),
    ))
    await db.commit()
    return {"id": img_id, "url": f"/images/{img_id}"}


@router.get("/{img_id}")
async def get_image(img_id: str, db: AsyncSession = Depends(get_db)):
    # Images are served publicly by ID (the ID is already unguessable).
    img = await db.get(Image, img_id)
    if img is None:
        raise HTTPException(status_code=404, detail="Not found")
    return Response(
        content=bytes(img.data),
        media_type=img.content_type,
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


@router.delete("/by-doc/{doc_id}", status_code=204)
async def delete_doc_images(
    doc_id: str,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_current_user),
):
    await db.execute(
        delete(Image).where(Image.doc_id == doc_id, Image.user_id == user_id)
    )
    await db.commit()
