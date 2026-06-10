import asyncio
import threading
from typing import TYPE_CHECKING

from app.config import settings

if TYPE_CHECKING:
    from sentence_transformers import SentenceTransformer


_model: "SentenceTransformer | None" = None
# Serializes the one-time model load. embed_async runs on worker threads
# (asyncio.to_thread), so a burst of first-calls on a cold server could enter
# get_model() concurrently. Double-checked locking guarantees the model is
# loaded EXACTLY once (not just one-at-a-time): late threads see the cached
# instance after the lock and skip the redundant load.
_model_lock = threading.Lock()


# NOTE: `sentence_transformers` (→ torch) is imported lazily, INSIDE get_model().
# Importing it at module load pulls torch into app startup, which on a cold Fly
# machine takes minutes — far longer than the health-check grace period, so the
# app 503s until it finally boots. Keeping the import lazy lets the server start
# in seconds; the model is warmed in the background at startup (see warm_model)
# so the first real RAG call usually doesn't pay the load cost.
def get_model() -> "SentenceTransformer":
    global _model
    if _model is None:
        with _model_lock:
            if _model is None:  # re-check inside the lock
                from sentence_transformers import SentenceTransformer

                _model = SentenceTransformer(settings.embedding_model)
    return _model


async def warm_model() -> None:
    """Load the model in a background thread so startup (health check) isn't
    blocked, yet the first request rarely waits on the cold load. Fire-and-forget
    from the app lifespan."""
    try:
        await asyncio.to_thread(get_model)
    except Exception:
        # A failed warm-up is non-fatal: the next embed() call retries the load.
        pass


def embed(text: str) -> list[float]:
    return get_model().encode(text, normalize_embeddings=True).tolist()


async def embed_async(text: str) -> list[float]:
    """
    Off-load the CPU-bound encode to a worker thread so it does not block the
    event loop. Without this, one embed() call (hundreds of ms) freezes every
    other request — including in-flight AI streams — until it finishes.
    """
    return await asyncio.to_thread(embed, text)
