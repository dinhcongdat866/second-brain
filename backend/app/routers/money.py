"""
Money log — extract structured entries from free-text Vietnamese money notes.

The sibling of analytics.classify_todos, with one important difference:
classification only *labels* text, this has to pull a number out of it. A wrong
label gives you a slightly wrong chart; a wrong number gives you a figure you
will believe and act on. Every rule below follows from that.
"""
import json
import logging
import re
from datetime import datetime, timezone

import anthropic
from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import delete, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import get_current_user
from app.db.engine import get_db
from app.db.models import MoneyEntry
from app.routers.analytics import _require_user_key

log = logging.getLogger(__name__)

router = APIRouter(prefix="/money", tags=["money"])

# ---------------------------------------------------------------------------
# Taxonomy
# ---------------------------------------------------------------------------

MONEY_TAXONOMY_VERSION = 1  # bump to re-parse every stored entry on next load

# Category names are stable identifiers, stored in money_entries.category and
# grouped on in SQL — not display text. English, like CATEGORIES in analytics.py
# (which was itself renamed from Vietnamese in taxonomy v1→v2 for this reason).
# The UI translates them; see moneyCategoryLabel in src/lib/moneyTaxonomy.ts.
#
# The *input* stays Vietnamese — that is user data, and the shorthand rules in
# the prompt below are about reading it, not about labelling the result.
MONEY_CATEGORIES: dict[str, str] = {
    "Food & Drink":    "Coffee, eating out, groceries, food delivery",
    "Transport":       "Fuel, ride-hailing, taxi, tickets, parking",
    "Housing":         "Rent, repairs, furniture",
    "Bills":           "Electricity, water, internet, phone, subscriptions",
    "Health":          "Doctor, medicine, insurance, gym",
    "Entertainment":   "Films, games, travel, hobbies",
    "Shopping":        "Clothes, electronics, household goods",
    "Education":       "Courses, books, exams",
    "Salary":          "Salary and bonuses from work",
    "Other Income":    "Freelance, selling things, gifts received, refunds",
    "Borrowing":       "Taking a loan from someone",
    "Debt Repayment":  "Paying back money that was borrowed",
    "Other":           "Does not fit any category above",
}

CATEGORY_FALLBACK = "Other"

# Case-insensitive lookup so the validator accepts "food & drink" == "Food & Drink".
_CATEGORY_LOWER: dict[str, str] = {k.lower(): k for k in MONEY_CATEGORIES}

_CATEGORY_LIST = "\n".join(f"- {name}: {desc}" for name, desc in MONEY_CATEGORIES.items())

_PARSE_SYSTEM = f"""You extract money entries from short Vietnamese notes.

Vietnamese money shorthand — read these carefully, they carry the amount:
  k, ng, nghìn    → x1,000              "85k"     -> 85000
  tr, triệu, củ   → x1,000,000          "5 củ"    -> 5000000
  lít, xị         → x100,000            "2 xị"    -> 200000
  tỷ              → x1,000,000,000      "1 tỷ"    -> 1000000000
  A digit group AFTER the unit is a fraction of that unit, not a separate number:
  "4tr5" -> 4500000    "1tr2" -> 1200000    "2ng5" -> 2500    "3k5" -> 3500
  Plain numbers with separators keep their value: "85.000" -> 85000, "1,500,000" -> 1500000

Sign of "amount":
  money leaving you  -> negative      "cà phê 85k"      -> -85000
  money arriving     -> positive      "lương 32tr"      -> +32000000
  Borrowing gives you cash now: positive amount.
  Repaying takes cash away: negative amount.

"debt_delta" — signed change in what you owe that person, 0 for ordinary entries:
  "mượn mẹ 5tr"          amount +5000000   debt_delta +5000000   (you owe more)
  "trả mẹ 2tr"           amount -2000000   debt_delta -2000000   (you owe less)
  "cho Tuấn mượn 1tr"    amount -1000000   debt_delta -1000000   (they owe you)
  "Tuấn trả 1tr"         amount +1000000   debt_delta +1000000
  Set debt_delta to 0 unless the line is clearly about lending or repaying.

"counterparty" is the person involved ("mẹ", "anh Tuấn"), or null. Not a shop name.
Copy it through exactly as written — it is the user's own words, not a label.

Categories. The input is Vietnamese but these names are identifiers: return them
in English, exactly as spelled here, never translated:
{_CATEGORY_LIST}

Return ONLY a JSON array — no prose, no markdown fences. One object per input
line, in the same order, with the same length as the input:
[{{"i":0,"amount":-85000,"category":"Food & Drink","counterparty":"anh Tuấn","debt_delta":0}}]

If a line has no recoverable amount, return "amount":null for it.
NEVER guess or invent a number. NEVER return an amount of 0.
"amount" and "debt_delta" must be JSON numbers, never strings like "85k".
Never invent a category outside the list above."""

# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

STATUS_OK = "ok"
STATUS_NEEDS_AMOUNT = "needs_amount"


class ParseItem(BaseModel):
    entry_id: str
    date: str                # 'YYYY-MM-DD'
    text: str


class ParseRequest(BaseModel):
    entries: list[ParseItem] = Field(..., max_length=50)


class ParsedEntry(BaseModel):
    entry_id: str
    amount: int | None
    category: str
    counterparty: str | None
    debt_delta: int
    status: str
    raw_text: str | None = None          # populated by GET, for the dirty-check
    taxonomy_version: int | None = None  # populated by GET


class ParseResponse(BaseModel):
    results: list[ParsedEntry]


class LedgerRow(BaseModel):
    counterparty: str
    borrowed: int
    repaid: int
    balance: int


# ---------------------------------------------------------------------------
# Validation — the model's output is a suggestion, not a result
# ---------------------------------------------------------------------------

def _coerce_int(value: object) -> int | None:
    """
    Accept only a genuine integer. A float is rejected outright rather than
    rounded: money is counted in whole đồng, and a model that answers 84999.99
    has misunderstood the line, so the safe move is to flag it, not to round it.
    """
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    return None


def _validate_one(raw: object) -> tuple[int | None, str, str | None, int, str]:
    """
    Turn one model-produced object into (amount, category, counterparty,
    debt_delta, status). Never raises — a malformed row degrades to a flagged
    entry rather than taking the batch down.
    """
    if not isinstance(raw, dict):
        return None, CATEGORY_FALLBACK, None, 0, STATUS_NEEDS_AMOUNT

    amount = _coerce_int(raw.get("amount"))
    # Zero is not a valid money line. It is what a model returns when it wants
    # to answer but has nothing to say, which is exactly the case to flag.
    if amount == 0:
        amount = None

    cat_raw = raw.get("category")
    # An unknown category degrades to "Other" — a real bucket, so this is an
    # honest answer. There is no equivalent honest default for an amount.
    category = (
        _CATEGORY_LOWER.get(cat_raw.lower(), CATEGORY_FALLBACK)
        if isinstance(cat_raw, str) else CATEGORY_FALLBACK
    )

    cp_raw = raw.get("counterparty")
    counterparty = cp_raw.strip() if isinstance(cp_raw, str) and cp_raw.strip() else None

    debt_delta = _coerce_int(raw.get("debt_delta")) or 0
    # A debt movement without a person cannot be summed into any ledger row.
    if counterparty is None:
        debt_delta = 0

    status = STATUS_OK if amount is not None else STATUS_NEEDS_AMOUNT
    return amount, category, counterparty, debt_delta, status


def _extract_json_array(raw: str) -> list[object]:
    """Pull the first JSON array out of the response, tolerating stray prose/fences."""
    cleaned = re.sub(r"^```(?:json)?\s*", "", raw.strip()).rstrip("`").strip()
    match = re.search(r"\[.*\]", cleaned, re.DOTALL)
    if match:
        cleaned = match.group(0)
    data = json.loads(cleaned)
    if not isinstance(data, list):
        raise ValueError("expected a JSON array")
    return data


# ---------------------------------------------------------------------------
# Parse
# ---------------------------------------------------------------------------

@router.post("/parse", response_model=ParseResponse)
async def parse_entries(
    body: ParseRequest,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_current_user),
    x_user_api_key: str | None = Header(default=None),
):
    """
    Parse a batch of money lines (max 50) and upsert them into money_entries.

    The whole batch goes in ONE Anthropic call, unlike /analytics/classify which
    spends one call per todo. Every line here needs the identical instructions,
    so repeating the system prompt per line would just bill the user more for
    the same answer.
    """
    if not body.entries:
        return ParseResponse(results=[])

    client = anthropic.AsyncAnthropic(api_key=_require_user_key(x_user_api_key))

    numbered = "\n".join(f"{i}. {item.text}" for i, item in enumerate(body.entries))
    resp = await client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=200 + 80 * len(body.entries),
        system=_PARSE_SYSTEM,
        messages=[{"role": "user", "content": numbered}],
    )
    raw = resp.content[0].text.strip() if resp.content else "[]"

    try:
        parsed = _extract_json_array(raw)
    except (json.JSONDecodeError, ValueError) as exc:
        log.error("[money/parse] malformed response: %s | raw: %s", exc, raw)
        raise HTTPException(status_code=502, detail="AI returned malformed JSON.")

    # Index by the model's own "i" rather than by position: a model that drops or
    # reorders a line would otherwise silently attach one line's amount to a
    # different line's text — the worst failure this endpoint could have.
    by_index: dict[int, object] = {}
    for row in parsed:
        if isinstance(row, dict):
            idx = _coerce_int(row.get("i"))
            if idx is not None and 0 <= idx < len(body.entries):
                by_index[idx] = row

    now = datetime.now(timezone.utc)
    results: list[ParsedEntry] = []

    for i, item in enumerate(body.entries):
        amount, category, counterparty, debt_delta, status = _validate_one(by_index.get(i))
        results.append(ParsedEntry(
            entry_id=item.entry_id,
            amount=amount,
            category=category,
            counterparty=counterparty,
            debt_delta=debt_delta,
            status=status,
        ))

        existing = await db.get(MoneyEntry, item.entry_id)
        if existing:
            existing.date = item.date
            existing.raw_text = item.text
            existing.amount = amount
            existing.category = category
            existing.counterparty = counterparty
            existing.debt_delta = debt_delta
            existing.status = status
            existing.taxonomy_version = MONEY_TAXONOMY_VERSION
            existing.parsed_at = now
        else:
            db.add(MoneyEntry(
                entry_id=item.entry_id,
                user_id=user_id,
                date=item.date,
                raw_text=item.text,
                amount=amount,
                category=category,
                counterparty=counterparty,
                debt_delta=debt_delta,
                status=status,
                taxonomy_version=MONEY_TAXONOMY_VERSION,
                parsed_at=now,
            ))

    await db.commit()
    return ParseResponse(results=results)


@router.get("/entries", response_model=list[ParsedEntry])
async def get_entries(
    from_date: str,
    to_date: str,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_current_user),
):
    """
    Entries in a date range, inclusive. Feeds the client dirty-check, which is
    why raw_text and taxonomy_version come along.

    A date range, not a list of week keys: moneyLog is keyed by day, so twelve
    months is one query instead of enumerating 52 Mondays and probing each.
    """
    rows = await db.execute(
        select(MoneyEntry)
        .where(
            MoneyEntry.user_id == user_id,
            MoneyEntry.date >= from_date,
            MoneyEntry.date <= to_date,
        )
        .order_by(MoneyEntry.date)
    )
    return [
        ParsedEntry(
            entry_id=r.entry_id,
            amount=r.amount,
            category=r.category,
            counterparty=r.counterparty,
            debt_delta=r.debt_delta,
            status=r.status,
            raw_text=r.raw_text,
            taxonomy_version=r.taxonomy_version,
        )
        for r in rows.scalars().all()
    ]


@router.get("/ledger", response_model=list[LedgerRow])
async def get_ledger(
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_current_user),
):
    """
    Per-person debt balance, recomputed from the entries on every call.

    Nothing here is stored. A running balance column would be permanently wrong
    the first time two devices each added to it, with no way to tell afterwards.

    Positive balance = you owe them. Negative = they owe you. Settled people are
    dropped by the HAVING clause rather than shown as a zero row.
    """
    rows = await db.execute(
        text("""
            SELECT counterparty,
                   SUM(debt_delta)                  AS balance,
                   SUM(GREATEST(debt_delta, 0))     AS borrowed,
                   -SUM(LEAST(debt_delta, 0))       AS repaid
            FROM money_entries
            WHERE user_id = :uid
              AND counterparty IS NOT NULL
              AND debt_delta <> 0
            GROUP BY counterparty
            HAVING SUM(debt_delta) <> 0
            ORDER BY ABS(SUM(debt_delta)) DESC
        """),
        {"uid": user_id},
    )
    return [
        LedgerRow(
            counterparty=r.counterparty,
            borrowed=int(r.borrowed),
            repaid=int(r.repaid),
            balance=int(r.balance),
        )
        for r in rows.fetchall()
    ]


@router.delete("/entries/{entry_id}", status_code=204)
async def delete_entry(
    entry_id: str,
    db: AsyncSession = Depends(get_db),
    user_id: str = Depends(get_current_user),
):
    """Drop the SQL projection of a line removed from the Y.Doc."""
    await db.execute(
        delete(MoneyEntry).where(
            MoneyEntry.user_id == user_id,
            MoneyEntry.entry_id == entry_id,
        )
    )
    await db.commit()
