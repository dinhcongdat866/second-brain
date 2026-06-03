"""Reverse proxy for the Anthropic API.

The frontend points its Anthropic SDK `baseURL` at `<backend>/anthropic`, with a
dummy key. This proxy forwards each request verbatim to api.anthropic.com and
injects the real key server-side — so the secret never reaches the browser
bundle, while all client-side streaming logic (thinking, web search, usage)
keeps working unchanged because it talks to the same API shape.
"""
import httpx
from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from app.config import settings

router = APIRouter(prefix="/anthropic", tags=["ai"])

ANTHROPIC_BASE = "https://api.anthropic.com"

# Only these client headers are forwarded upstream; x-api-key is injected by us.
_FORWARD_HEADERS = {"content-type", "accept", "anthropic-version", "anthropic-beta"}

# Hop-by-hop / length headers must NOT be copied back (body is re-streamed).
# Everything else (content-type, content-encoding: gzip, …) is passed through
# so the client can decode the response correctly.
_DROP_RESP_HEADERS = {"content-length", "transfer-encoding", "connection"}


@router.api_route("/{path:path}", methods=["GET", "POST"])
async def proxy(path: str, request: Request):
    body = await request.body()
    headers = {
        k: v for k, v in request.headers.items() if k.lower() in _FORWARD_HEADERS
    }
    user_key = request.headers.get("x-user-api-key", "").strip()
    headers["x-api-key"] = user_key if user_key else settings.anthropic_api_key
    headers.setdefault("anthropic-version", "2023-06-01")

    client = httpx.AsyncClient(timeout=None)
    upstream_req = client.build_request(
        request.method,
        f"{ANTHROPIC_BASE}/{path}",
        content=body,
        headers=headers,
        params=request.query_params,
    )
    upstream = await client.send(upstream_req, stream=True)

    async def relay():
        try:
            async for chunk in upstream.aiter_raw():
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()

    resp_headers = {
        k: v for k, v in upstream.headers.items() if k.lower() not in _DROP_RESP_HEADERS
    }
    return StreamingResponse(
        relay(),
        status_code=upstream.status_code,
        headers=resp_headers,
    )
