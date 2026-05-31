from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.db.migrations import run_migrations
from app.routers import embeddings, search, documents, usage


@asynccontextmanager
async def lifespan(app: FastAPI):
    await run_migrations()
    yield


app = FastAPI(title="Second Brain API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(embeddings.router)
app.include_router(search.router)
app.include_router(documents.router)
app.include_router(usage.router)


@app.get("/health")
async def health():
    return {"status": "ok"}
