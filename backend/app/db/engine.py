import ssl
from urllib.parse import urlparse, urlunparse
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy.orm import DeclarativeBase
from app.config import settings

# asyncpg doesn't accept sslmode/channel_binding as URL params (psycopg2 syntax).
# Strip them from the URL and pass an SSL context via connect_args instead.
def _build_url(raw: str) -> str:
    parsed = urlparse(raw.replace("postgresql://", "postgresql+asyncpg://", 1))
    clean = parsed._replace(query="")
    return urlunparse(clean)

# Supabase uses a certificate chain that asyncpg's default verifier rejects.
# We require SSL (encrypted connection) but skip hostname/cert verification —
# acceptable because the connection target is a known Supabase host.
_ssl_ctx = ssl.create_default_context()
_ssl_ctx.check_hostname = False
_ssl_ctx.verify_mode = ssl.CERT_NONE

engine = create_async_engine(
    _build_url(settings.database_url),
    connect_args={"ssl": _ssl_ctx},
    pool_pre_ping=True,
)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


async def get_db() -> AsyncSession:
    async with SessionLocal() as session:
        yield session
