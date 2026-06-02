from functools import lru_cache
from typing import TYPE_CHECKING

from app.config import settings

if TYPE_CHECKING:
    from sentence_transformers import SentenceTransformer


# NOTE: `sentence_transformers` (→ torch) is imported lazily, INSIDE get_model().
# Importing it at module load pulls torch into app startup, which on a cold Fly
# machine takes minutes — far longer than the health-check grace period, so the
# app 503s until it finally boots. Keeping the import lazy lets the server start
# in seconds; only the first RAG call pays the one-time model-load cost.
@lru_cache(maxsize=1)
def get_model() -> "SentenceTransformer":
    from sentence_transformers import SentenceTransformer

    return SentenceTransformer(settings.embedding_model)


def embed(text: str) -> list[float]:
    return get_model().encode(text, normalize_embeddings=True).tolist()
