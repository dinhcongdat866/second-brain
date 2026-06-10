"""Reverse proxy for the Anthropic API.

The frontend points its Anthropic SDK `baseURL` at `<backend>/anthropic` and
forwards the caller's own Anthropic key via `x-user-api-key`. This proxy
forwards each request verbatim to api.anthropic.com so all client-side
streaming logic (thinking, web search, usage) keeps working unchanged.

Two guards prevent this from being an open relay that burns someone else's
quota:
  1. A valid Supabase JWT is required (Depends(get_current_user)) — anonymous
     callers who only know the backend URL are rejected.
  2. Each caller must supply their OWN key via `x-user-api-key`; there is no
     server-side fallback key. A missing key is a 400, never a silent charge
     to an operator-held key.

Usage metering happens HERE, not on the client. The proxy sees the real token
counts in the streamed response, so it computes cost and writes usage_log
itself — the client can no longer forge the numbers (it used to POST its own
counts to /usage/log). The client tags each request with `x-cell-id` /
`x-doc-id` so the row can be attributed to the originating cell.
"""
import json

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse

from app.auth import get_current_user
from app.db.engine import SessionLocal
from app.db.models import UsageLog

router = APIRouter(prefix="/anthropic", tags=["ai"])

ANTHROPIC_BASE = "https://api.anthropic.com"

# Only these client headers are forwarded upstream; x-api-key is injected by us.
# Note: x-cell-id / x-doc-id are intentionally NOT forwarded — they are read
# here for metering and have no meaning to Anthropic.
_FORWARD_HEADERS = {"content-type", "accept", "anthropic-version", "anthropic-beta"}

# Hop-by-hop / length headers must NOT be copied back (body is re-streamed).
# content-encoding is dropped because we force identity upstream (see below),
# so the bytes we relay are already plain text.
_DROP_RESP_HEADERS = {"content-length", "transfer-encoding", "connection", "content-encoding"}

# USD per million tokens: (input, output, cache_read, cache_creation).
# Mirror of ANTHROPIC_PRICE in src/collab/claudeStream.ts — kept server-side so
# the logged cost can't be forged. Update both together when prices change.
_PRICE_PER_M: dict[str, tuple[float, float, float, float]] = {
    "claude-haiku-4-5-20251001": (0.80, 4.0, 0.08, 0.80),
    "claude-sonnet-4-6":         (3.0, 15.0, 0.30, 3.0),
    "claude-opus-4-8":           (15.0, 75.0, 1.50, 15.0),
}

# Web search is billed as a flat per-request surcharge ($10 / 1,000 requests) on
# TOP of the result tokens (which already land in input_tokens). Counted from
# usage.server_tool_use.web_search_requests, not from any token field.
_WEB_SEARCH_PER_REQUEST = 10.0 / 1_000


def _parse_usage(text: str, acc: dict[str, int]) -> None:
    """Scan complete SSE `data:` lines for usage fields, updating acc in place.

    message_start carries input / cache tokens; message_delta carries the final
    cumulative output_tokens. Only keys actually present are overwritten, so the
    later delta (no input field) never clobbers the input count from start.
    """
    for line in text.split("\n"):
        line = line.strip()
        if not line.startswith("data:"):
            continue
        payload = line[len("data:"):].strip()
        if not payload or payload == "[DONE]":
            continue
        try:
            obj = json.loads(payload)
        except ValueError:
            continue
        usage = obj.get("usage")
        if usage is None and isinstance(obj.get("message"), dict):
            usage = obj["message"].get("usage")
        if not isinstance(usage, dict):
            continue
        if usage.get("input_tokens") is not None:
            acc["input"] = usage["input_tokens"]
        if usage.get("output_tokens") is not None:
            acc["output"] = usage["output_tokens"]
        if usage.get("cache_read_input_tokens") is not None:
            acc["cache_read"] = usage["cache_read_input_tokens"]
        if usage.get("cache_creation_input_tokens") is not None:
            acc["cache_creation"] = usage["cache_creation_input_tokens"]
        stu = usage.get("server_tool_use")
        if isinstance(stu, dict) and stu.get("web_search_requests") is not None:
            acc["web_search"] = stu["web_search_requests"]


def _cost_usd(model: str, acc: dict[str, int]) -> float:
    price = _PRICE_PER_M.get(model)
    if price is None:
        return 0.0
    p_in, p_out, p_cr, p_cc = price
    token_cost = (
        acc["input"] * p_in
        + acc["output"] * p_out
        + acc["cache_read"] * p_cr
        + acc["cache_creation"] * p_cc
    ) / 1_000_000
    return token_cost + acc["web_search"] * _WEB_SEARCH_PER_REQUEST


async def _log_usage(user_id: str, doc_id: str, cell_id: str, model: str, acc: dict[str, int]) -> None:
    async with SessionLocal() as db:
        db.add(UsageLog(
            user_id=user_id,
            doc_id=doc_id,
            cell_id=cell_id,
            input_tokens=acc["input"],
            output_tokens=acc["output"],
            cache_read_tokens=acc["cache_read"],
            cache_creation_tokens=acc["cache_creation"],
            cost_usd=_cost_usd(model, acc),
        ))
        await db.commit()


@router.api_route("/{path:path}", methods=["GET", "POST"])
async def proxy(
    path: str,
    request: Request,
    user_id: str = Depends(get_current_user),
):
    user_key = request.headers.get("x-user-api-key", "").strip()
    if not user_key:
        raise HTTPException(
            status_code=400,
            detail="No Anthropic API key provided. Set your key in the model settings panel.",
        )

    body = await request.body()
    headers = {
        k: v for k, v in request.headers.items() if k.lower() in _FORWARD_HEADERS
    }
    headers["x-api-key"] = user_key
    headers.setdefault("anthropic-version", "2023-06-01")
    # Force identity so the relayed bytes are plain SSE text — lets us meter
    # usage AND pass the stream through byte-for-byte without decompressing.
    headers["accept-encoding"] = "identity"

    # Metering attribution (set by the client per AI cell). Absent for non-cell
    # calls (e.g. memory extraction) — those simply aren't logged.
    cell_id = request.headers.get("x-cell-id")
    doc_id = request.headers.get("x-doc-id")
    model: str | None = None
    if body:
        try:
            model = json.loads(body).get("model")
        except ValueError:
            pass

    client = httpx.AsyncClient(timeout=None)
    upstream_req = client.build_request(
        request.method,
        f"{ANTHROPIC_BASE}/{path}",
        content=body,
        headers=headers,
        params=request.query_params,
    )
    upstream = await client.send(upstream_req, stream=True)

    acc = {"input": 0, "output": 0, "cache_read": 0, "cache_creation": 0, "web_search": 0}
    meter = bool(cell_id and doc_id and model) and upstream.status_code == 200

    async def relay():
        buffer = ""
        try:
            async for chunk in upstream.aiter_raw():
                if meter:
                    buffer += chunk.decode("utf-8", "ignore")
                    # Parse only complete lines; keep any trailing partial.
                    nl = buffer.rfind("\n")
                    if nl != -1:
                        _parse_usage(buffer[:nl], acc)
                        buffer = buffer[nl + 1:]
                yield chunk
        finally:
            if meter and buffer:
                _parse_usage(buffer, acc)
            await upstream.aclose()
            await client.aclose()
            # Usage logging must never break the response stream.
            if meter and acc["output"] > 0:
                try:
                    await _log_usage(user_id, doc_id, cell_id, model, acc)
                except Exception:
                    pass

    resp_headers = {
        k: v for k, v in upstream.headers.items() if k.lower() not in _DROP_RESP_HEADERS
    }
    return StreamingResponse(
        relay(),
        status_code=upstream.status_code,
        headers=resp_headers,
    )
