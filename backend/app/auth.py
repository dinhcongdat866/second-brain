"""
JWT validation for Supabase-issued tokens.

Supabase signs JWTs with RS256 and exposes its public keys via the standard
JWKS endpoint. PyJWT's PyJWKClient fetches + caches the keys automatically —
no secret needs to be copied into .env.

Usage in a route:
    @router.get("/something")
    async def handler(user_id: str = Depends(get_current_user)):
        ...
"""
import jwt
from jwt import PyJWKClient
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.config import settings

_security = HTTPBearer(auto_error=False)

# Lazily initialised so startup doesn't fail if SUPABASE_URL isn't set yet
# (e.g. local dev without auth).
_jwks_client: PyJWKClient | None = None


def _get_client() -> PyJWKClient:
    global _jwks_client
    if _jwks_client is None:
        if not settings.supabase_url:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Auth not configured (SUPABASE_URL missing)",
            )
        _jwks_client = PyJWKClient(
            f"{settings.supabase_url}/auth/v1/.well-known/jwks.json",
            cache_keys=True,
        )
    return _jwks_client


def _decode(token: str) -> dict:
    client = _get_client()
    signing_key = client.get_signing_key_from_jwt(token)
    return jwt.decode(
        token,
        signing_key.key,
        algorithms=["RS256"],
        audience="authenticated",
        options={"verify_exp": True},
    )


async def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(_security),
) -> str:
    """Require a valid Supabase JWT. Returns the user UUID (sub claim)."""
    if credentials is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    try:
        payload = _decode(credentials.credentials)
        return payload["sub"]
    except Exception:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")


async def get_optional_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(_security),
) -> str | None:
    """Return user UUID if JWT is present and valid, else None (guest/no-auth)."""
    if credentials is None:
        return None
    try:
        payload = _decode(credentials.credentials)
        return payload["sub"]
    except Exception:
        return None
