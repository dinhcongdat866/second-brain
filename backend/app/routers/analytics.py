"""Personal analytics — todo classification and mood log endpoints."""
import json
from datetime import datetime, timezone

import anthropic
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_user
from app.config import settings
from app.db.engine import get_db
from app.db.models import MoodLog, TodoClassification

router = APIRouter(prefix="/analytics", tags=["analytics"])

# ---------------------------------------------------------------------------
# Category taxonomy v1 — must match PERSONAL-ANALYTICS.md
# ---------------------------------------------------------------------------

TAXONOMY_VERSION = 1

CATEGORIES: dict[str, str] = {
    "Mental Work":        "Reflect, trauma processing, journaling, metacognition, therapy",
    "Tìm việc":           "Apply job, viết CV, prep interview, research công ty, networking",
    "Công việc":          "Tasks job hiện tại, freelance, meetings",
    "Personal Project":   "Side project, coding ngoài giờ, học kỹ năng mới",
    "Tài chính":          "Budget, bills, đầu tư, theo dõi chi tiêu",
    "Relationships":      "Gặp bạn bè, gia đình, social events, đám cưới",
    "Rest":               "Ngủ, nằm không làm gì, recovery có chủ đích — passive",
    "Leisure":            "Game, phim, đọc giải trí, hobby — active enjoyment",
    "Chores":             "Cắt tóc, giặt đồ, dọn nhà, admin tasks",
    "Bad mental health":  "Lo lắng, stress, burnout, mất ngủ do tâm lý",
    "Bad physical health":"Ốm, mệt thể xác, đau đầu, ngủ không đủ giấc",
}

_CATEGORY_LIST = "\n".join(f"- {name}: {desc}" for name, desc in CATEGORIES.items())

_CLASSIFY_SYSTEM = f"""You are a classifier for a personal analytics system.
Given a todo item, assign 1–3 categories from the list below that best describe it.

Categories:
{_CATEGORY_LIST}

Rules:
- Return ONLY valid JSON: {{"categories": ["Cat1", "Cat2"]}}
- Maximum 3 categories. Choose the most specific ones.
- Prioritise "Bad mental health" or "Bad physical health" when signals are clear.
- "Rest" = passive recovery; "Leisure" = active enjoyment.
- Never invent categories outside the list above."""

# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class TodoItem(BaseModel):
    todo_id: str
    week_start: str          # 'YYYY-MM-DD'
    text: str

class ClassifyRequest(BaseModel):
    todos: list[TodoItem] = Field(..., max_length=50)

class ClassifyResult(BaseModel):
    todo_id: str
    categories: list[str]

class ClassifyResponse(BaseModel):
    results: list[ClassifyResult]

class MoodUpsertRequest(BaseModel):
    id: str                  # UUID from frontend (stable per user+date)
    date: str                # 'YYYY-MM-DD'
    energy: int = Field(..., ge=1, le=5)
    note: str | None = None

class MoodEntry(BaseModel):
    id: str
    date: str
    energy: int
    note: str | None

# ---------------------------------------------------------------------------
# Classification
# ---------------------------------------------------------------------------

def _classify_one(text: str, client: anthropic.Anthropic) -> list[str]:
    """Call Claude to classify a single todo. Returns list of category names."""
    resp = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=64,
        system=_CLASSIFY_SYSTEM,
        messages=[{"role": "user", "content": f'Todo: "{text}"'}],
    )
    raw = resp.content[0].text.strip() if resp.content else "{}"
    try:
        data = json.loads(raw)
        cats = data.get("categories", [])
        # Validate — only accept known categories
        valid = [c for c in cats if c in CATEGORIES]
        return valid[:3] if valid else ["Chores"]   # fallback if nothing valid
    except (json.JSONDecodeError, AttributeError):
        return ["Chores"]


@router.post("/classify", response_model=ClassifyResponse)
async def classify_todos(
    body: ClassifyRequest,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_current_user),
):
    """Classify a batch of todos (max 50). Upserts results into todo_classifications."""
    if not body.todos:
        return ClassifyResponse(results=[])

    client = anthropic.Anthropic(api_key=settings.anthropic_api_key)
    results: list[ClassifyResult] = []

    for item in body.todos:
        categories = _classify_one(item.text, client)
        result = ClassifyResult(todo_id=item.todo_id, categories=categories)
        results.append(result)

        # Upsert into DB
        existing = await db.get(TodoClassification, item.todo_id)
        if existing:
            existing.todo_text = item.text
            existing.categories = json.dumps(categories, ensure_ascii=False)
            existing.classified_at = datetime.now(timezone.utc)
        else:
            db.add(TodoClassification(
                todo_id=item.todo_id,
                user_id=user_id,
                week_start=item.week_start,
                todo_text=item.text,
                categories=json.dumps(categories, ensure_ascii=False),
                taxonomy_version=TAXONOMY_VERSION,
                classified_at=datetime.now(timezone.utc),
            ))

    await db.commit()
    return ClassifyResponse(results=results)


@router.get("/classifications", response_model=list[ClassifyResult])
async def get_classifications(
    week_start: str,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_current_user),
):
    """Fetch all classifications for a given week."""
    rows = await db.execute(
        select(TodoClassification)
        .where(
            TodoClassification.user_id == user_id,
            TodoClassification.week_start == week_start,
        )
    )
    return [
        ClassifyResult(
            todo_id=r.todo_id,
            categories=json.loads(r.categories),
        )
        for r in rows.scalars().all()
    ]


# ---------------------------------------------------------------------------
# Mood log
# ---------------------------------------------------------------------------

@router.put("/mood", response_model=MoodEntry)
async def upsert_mood(
    body: MoodUpsertRequest,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_current_user),
):
    """Upsert a mood log entry for a given date. Uses frontend-supplied UUID as PK."""
    existing = await db.execute(
        select(MoodLog).where(MoodLog.user_id == user_id, MoodLog.date == body.date)
    )
    row = existing.scalar_one_or_none()

    if row:
        row.energy = body.energy
        row.note = body.note
    else:
        row = MoodLog(
            id=body.id,
            user_id=user_id,
            date=body.date,
            energy=body.energy,
            note=body.note,
        )
        db.add(row)

    await db.commit()
    return MoodEntry(id=row.id, date=row.date, energy=row.energy, note=row.note)


@router.get("/mood", response_model=list[MoodEntry])
async def get_mood(
    from_date: str,
    to_date: str,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_current_user),
):
    """Fetch mood logs for a date range (inclusive). Dates as 'YYYY-MM-DD'."""
    rows = await db.execute(
        select(MoodLog)
        .where(
            MoodLog.user_id == user_id,
            MoodLog.date >= from_date,
            MoodLog.date <= to_date,
        )
        .order_by(MoodLog.date)
    )
    return [
        MoodEntry(id=r.id, date=r.date, energy=r.energy, note=r.note)
        for r in rows.scalars().all()
    ]


@router.delete("/mood/{date}", status_code=204)
async def delete_mood(
    date: str,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_current_user),
):
    """Remove a mood log entry."""
    await db.execute(
        delete(MoodLog).where(MoodLog.user_id == user_id, MoodLog.date == date)
    )
    await db.commit()
