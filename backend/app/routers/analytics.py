"""Personal analytics — todo classification and mood log endpoints."""
import json
from datetime import datetime, timezone, date as dt_date, timedelta
from typing import Literal

import anthropic
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select, delete, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_user
from app.config import settings
from app.db.engine import get_db
from app.db.models import MoodLog, TodoClassification

router = APIRouter(prefix="/analytics", tags=["analytics"])

# ---------------------------------------------------------------------------
# Category taxonomy v1 — must match PERSONAL-ANALYTICS.md
# ---------------------------------------------------------------------------

TAXONOMY_VERSION = 2  # v1→v2: renamed "Tìm việc"→"Job Search", "Công việc"→"Work", "Tài chính"→"Finance"

CATEGORIES: dict[str, str] = {
    "Mental Work":        "Journaling, reflection, trauma processing, metacognition, therapy sessions",
    "Job Search":         "Job applications, CV writing, interview prep, company research, networking",
    "Work":               "Current job tasks, freelance work, meetings, client deliverables",
    "Personal Project":   "Side projects, coding outside work hours, learning new skills",
    "Finance":            "Budgeting, bills, investments, expense tracking",
    "Relationships":      "Seeing friends or family, social events, weddings, social obligations",
    "Rest":               "Sleep, deliberate do-nothing recovery — passive recharge",
    "Leisure":            "Gaming, films, recreational reading, hobbies — active enjoyment",
    "Chores":             "Haircut, laundry, cleaning, admin errands",
    "Bad mental health":  "Anxiety, stress, burnout, insomnia from psychological causes",
    "Bad physical health":"Illness, physical fatigue, headaches, insufficient sleep",
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


# ---------------------------------------------------------------------------
# Report data — SQL aggregates for /ai-report page
# ---------------------------------------------------------------------------

class CategoryCount(BaseModel):
    category: str
    count: int
    pct: float
    trend: Literal["up", "down", "stable"]

class MoodPoint(BaseModel):
    date: str
    energy: int | None = None
    note: str | None = None

class ReportDataResponse(BaseModel):
    categoryBreakdown: list[CategoryCount]
    moodTimeline: list[MoodPoint]


@router.get("/report-data", response_model=ReportDataResponse)
async def get_report_data(
    from_date: str,
    to_date: str,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_current_user),
):
    """
    Aggregate category breakdown + mood timeline for a date range.
    Dates are inclusive ISO strings ('YYYY-MM-DD').
    Also computes the previous period of equal length for trend arrows.
    """
    # ── Current period: unnest JSON category arrays and count ─────────────
    cats_q = await db.execute(
        text("""
            SELECT
                cat_val  AS category,
                COUNT(*) AS cnt
            FROM todo_classifications,
                 jsonb_array_elements_text(categories::jsonb) AS cat_val
            WHERE user_id   = :uid
              AND week_start >= :fd
              AND week_start <= :td
            GROUP BY cat_val
            ORDER BY cnt DESC
        """),
        {"uid": user_id, "fd": from_date, "td": to_date},
    )
    curr_rows = cats_q.fetchall()
    total = sum(r.cnt for r in curr_rows) or 1

    # ── Previous period (same duration) for trend comparison ──────────────
    fd = dt_date.fromisoformat(from_date)
    td = dt_date.fromisoformat(to_date)
    period_days = (td - fd).days + 1
    prev_fd = (fd - timedelta(days=period_days)).isoformat()
    prev_td = (fd - timedelta(days=1)).isoformat()

    prev_q = await db.execute(
        text("""
            SELECT
                cat_val  AS category,
                COUNT(*) AS cnt
            FROM todo_classifications,
                 jsonb_array_elements_text(categories::jsonb) AS cat_val
            WHERE user_id   = :uid
              AND week_start >= :fd
              AND week_start <= :td
            GROUP BY cat_val
        """),
        {"uid": user_id, "fd": prev_fd, "td": prev_td},
    )
    prev_counts: dict[str, int] = {r.category: r.cnt for r in prev_q.fetchall()}

    def _trend(curr: int, cat: str) -> str:
        prev = prev_counts.get(cat, 0)
        if prev == 0:
            return "stable"
        ratio = curr / prev
        if ratio > 1.15:
            return "up"
        if ratio < 0.85:
            return "down"
        return "stable"

    breakdown = [
        CategoryCount(
            category=r.category,
            count=r.cnt,
            pct=round(r.cnt / total * 100, 1),
            trend=_trend(r.cnt, r.category),
        )
        for r in curr_rows
    ]

    # ── Mood timeline (every day in range, None for unlogged days) ─────────
    mood_q = await db.execute(
        select(MoodLog)
        .where(
            MoodLog.user_id == user_id,
            MoodLog.date >= from_date,
            MoodLog.date <= to_date,
        )
        .order_by(MoodLog.date),
    )
    mood_by_date = {r.date: r for r in mood_q.scalars().all()}

    timeline: list[MoodPoint] = []
    cur = fd
    while cur <= td:
        ds = cur.isoformat()
        r = mood_by_date.get(ds)
        timeline.append(MoodPoint(
            date=ds,
            energy=r.energy if r else None,
            note=r.note if r else None,
        ))
        cur += timedelta(days=1)

    return ReportDataResponse(categoryBreakdown=breakdown, moodTimeline=timeline)


# ---------------------------------------------------------------------------
# AI report generation — Phase 3
# ---------------------------------------------------------------------------

_REPORT_SYSTEM = """You are a personal life analytics assistant.
You receive structured data from someone's week/month/quarter and generate a concise, honest report.

Return ONLY valid JSON matching this exact schema — no preamble, no markdown fences:
{
  "narrative": "3-4 sentences summarising the period. Reference actual numbers and categories. Acknowledge data gaps honestly.",
  "prediction": {
    "text": "One sentence about what the next period likely holds, based on current trends.",
    "confidence": "low | medium | high",
    "reasoning": "One sentence explaining the confidence level."
  },
  "proactiveQuestions": ["up to 2 short, specific questions tied to gaps or anomalies in THIS data — not generic wellness questions"]
}

Confidence rules:
- low: fewer than 7 mood logs OR fewer than 10 classified todos
- high: clear multi-week patterns with sufficient mood data
- medium: everything in between"""


def _format_report_context(
    period: dict,
    breakdown: list[dict],
    timeline: list[dict],
    patterns: list[dict],
) -> str:
    """Render the analytics data as a compact plaintext summary for the AI prompt."""
    lines: list[str] = []
    trend_sym = {"up": "↑", "down": "↓", "stable": "→"}

    # Period header
    start = period.get("start", "")
    end   = period.get("end", "")
    ptype = period.get("type", "custom")
    lines.append(f"Period: {ptype} ({start} → {end})\n")

    # Category breakdown
    total = sum(b.get("count", 0) for b in breakdown)
    if total > 0:
        lines.append(f"Category breakdown ({total} todos classified):")
        for b in breakdown[:10]:
            sym = trend_sym.get(b.get("trend", "stable"), "")
            lines.append(f"  {b['category']:<22} {b['pct']:>5.1f}% {sym}")
    else:
        lines.append("Category breakdown: no classified todos for this period.")
    lines.append("")

    # Mood stats
    logged = [p for p in timeline if p.get("energy") is not None]
    total_days = len(timeline)
    if logged:
        avg    = sum(p["energy"] for p in logged) / len(logged)
        low_d  = sum(1 for p in logged if p["energy"] <= 2)
        high_d = sum(1 for p in logged if p["energy"] >= 4)
        lines.append(f"Mood log ({len(logged)}/{total_days} days logged):")
        lines.append(f"  Average energy : {avg:.1f}/5")
        lines.append(f"  Low days  (≤2) : {low_d}")
        lines.append(f"  High days (≥4) : {high_d}")
    else:
        lines.append(f"Mood log: 0/{total_days} days — no mood data.")
    lines.append("")

    # Detected patterns
    if patterns:
        lines.append("Detected patterns:")
        for p in patterns:
            sev  = p.get("severity", "info").upper()
            rule = p.get("rule", "")
            desc = p.get("description", "")
            lines.append(f"  [{sev}] {rule} — {desc}")
    else:
        lines.append("Detected patterns: none.")

    return "\n".join(lines)


class PatternItem(BaseModel):
    rule: str
    description: str
    severity: str

class GenerateRequest(BaseModel):
    period: dict
    categoryBreakdown: list[dict]
    moodTimeline: list[dict]
    detectedPatterns: list[PatternItem]

class PredictionResult(BaseModel):
    text: str
    confidence: Literal["low", "medium", "high"]
    reasoning: str

class GenerateResponse(BaseModel):
    narrative: str
    prediction: PredictionResult
    proactiveQuestions: list[str]


@router.post("/report-generate", response_model=GenerateResponse)
async def generate_report(
    body: GenerateRequest,
    user_id: str = Depends(get_current_user),
):
    """
    Generate AI narrative, prediction, and proactive questions from pre-computed
    analytics data. The frontend passes SQL aggregates + evaluated pattern rules;
    the AI only does qualitative interpretation — no DB access.
    """
    context = _format_report_context(
        period=body.period,
        breakdown=body.categoryBreakdown,
        timeline=body.moodTimeline,
        patterns=[p.model_dump() for p in body.detectedPatterns],
    )

    client = anthropic.Anthropic(api_key=settings.anthropic_api_key)
    resp = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=512,
        system=_REPORT_SYSTEM,
        messages=[{"role": "user", "content": context}],
    )

    raw = resp.content[0].text.strip() if resp.content else "{}"
    try:
        data = json.loads(raw)
        prediction_raw = data.get("prediction", {})
        return GenerateResponse(
            narrative=data.get("narrative", ""),
            prediction=PredictionResult(
                text=prediction_raw.get("text", ""),
                confidence=prediction_raw.get("confidence", "low"),
                reasoning=prediction_raw.get("reasoning", ""),
            ),
            proactiveQuestions=data.get("proactiveQuestions", [])[:2],
        )
    except (json.JSONDecodeError, KeyError, ValueError):
        raise HTTPException(status_code=502, detail="AI returned malformed JSON.")
