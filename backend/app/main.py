import asyncio
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.db.migrations import run_migrations
from app.embeddings import warm_model
from app.routers import embeddings, search, documents, usage, ai, images, analytics


@asynccontextmanager
async def lifespan(app: FastAPI):
    await run_migrations()
    # Warm the embedding model in the background so the first RAG call doesn't
    # pay the ~minute cold load. Not awaited: startup stays fast (health check
    # passes immediately) while the model loads in a worker thread.
    asyncio.create_task(warm_model())
    yield


app = FastAPI(title="Second Brain API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.origins,
    allow_origin_regex=settings.allowed_origin_regex,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(embeddings.router)
app.include_router(search.router)
app.include_router(documents.router)
app.include_router(usage.router)
app.include_router(ai.router)
app.include_router(images.router)
app.include_router(analytics.router)


@app.get("/health")
async def health():
    return {"status": "ok"}
