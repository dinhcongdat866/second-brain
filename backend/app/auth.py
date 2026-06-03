"""
JWT validation for Supabase-issued tokens.

Supports both HS256 (older Supabase projects, symmetric secret) and RS256
(newer Supabase projects, asymmetric JWKS). The algorithm is detected
automatically from the JWT header.

- HS256: set SUPABASE_JWT_SECRET in .env (Settings → API → JWT Settings)
- RS256: set SUPABASE_URL in .env; public key fetched from JWKS endpoint automatically
"""
import base64
import json
import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.config import settings

_security = HTTPBearer(auto_error=False)

# ---------------------------------------------------------------------------
# Lazy JWKS client (RS256 only)
# ---------------------------------------------------------------------------
try:
    from jwt import PyJWKClient as _PyJWKClient
    _jwks_client: "_PyJWKClient | None" = None

    def _get_jwks_client() -> "_PyJWKClient":
        global _jwks_client
        if _jwks_client is None:
            _jwks_client = _PyJWKClient(
                f"{settings.supabase_url}/auth/v1/.well-known/jwks.json",
                cache_keys=True,
            )
        return _jwks_client
except ImportError:
    _get_jwks_client = None  # type: ignore


def _peek_alg(token: str) -> str:
    """Decode the JWT header (no verification) to read the alg field."""
    try:
        header_b64 = token.split(".")[0]
        # Add padding
        header_b64 += "=" * (-len(header_b64) % 4)
        header = json.loads(base64.b64decode(header_b64))
        return header.get("alg", "HS256")
    except Exception:
        return "HS256"


def _decode(token: str) -> dict:
    alg = _peek_alg(token)

    if alg == "RS256":
        if not settings.supabase_url:
            raise ValueError("SUPABASE_URL not configured for RS256 validation")
        client = _get_jwks_client()
        signing_key = client.get_signing_key_from_jwt(token)
        return jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            audience="authenticated",
            options={"verify_exp": True},
        )
    else:
        # HS256 (default for many Supabase projects)
        if not settings.supabase_jwt_secret:
            raise ValueError("SUPABASE_JWT_SECRET not configured for HS256 validation")
        return jwt.decode(
            token,
            settings.supabase_jwt_secret,
            algorithms=["HS256"],
            audience="authenticated",
            options={"verify_exp": True},
        )


async def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(_security),
) -> str:
    """Require a valid Supabase JWT. Returns the user UUID (sub claim)."""
    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated — no token sent",
        )
    try:
        payload = _decode(credentials.credentials)
        return payload["sub"]
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=f"Invalid token: {exc}",
        )


async def get_optional_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(_security),
) -> str | None:
    """Return user UUID if JWT is present and valid, else None."""
    if credentials is None:
        return None
    try:
        payload = _decode(credentials.credentials)
        return payload["sub"]
    except Exception:
        return None
