"""
Who may read and write a document.

Deliberately free of FastAPI, SQLAlchemy and the database: the rules here are
the ones that decide whether a stranger sees your notebook, and rules like that
should be readable and testable without standing a server up. The router does
the two lookups and hands the answers in.
"""
from dataclasses import dataclass


@dataclass(frozen=True)
class DocAccess:
    """Whose rows a request touches, and whether it may write to them."""
    owner_id: str
    can_write: bool
    link_access: str


class AccessDenied(Exception):
    """`status` is the HTTP status the router should return."""

    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


def decide_access(
    viewer_id: str | None,
    viewer_owns_copy: bool,
    share_owner_id: str | None,
    share_link_access: str | None,
) -> DocAccess:
    """
    Args:
        viewer_id: the caller, or None when the request carries no session.
        viewer_owns_copy: the caller already has a document under this id.
        share_owner_id / share_link_access: the share row, or None if unpublished.

    The first rule is the one that keeps sharing from breaking what already
    works. Document ids are not globally unique — every pre-registry account
    carries a document literally called 'default' — so if the caller has their
    own document under this id, that is the one they get. Without it, one person
    publishing 'default' would silently redirect everybody else's.
    """
    if viewer_id is not None and viewer_owns_copy:
        return DocAccess(viewer_id, True, "none")

    if share_owner_id is not None:
        access = share_link_access or "none"
        if viewer_id == share_owner_id:
            return DocAccess(share_owner_id, True, access)
        if access == "read":
            return DocAccess(share_owner_id, False, "read")
        if access == "write":
            return DocAccess(share_owner_id, True, "write")
        # Published to nobody, and the caller is not the owner. 404 rather than
        # 403: whether a private document exists is not a visitor's business.
        raise AccessDenied(404, "Not found")

    # Never published, or being created right now. Same as before sharing existed.
    if viewer_id is None:
        raise AccessDenied(401, "Not authenticated")
    return DocAccess(viewer_id, True, "none")


def require_write(access: DocAccess) -> DocAccess:
    if not access.can_write:
        raise AccessDenied(403, "Read-only link")
    return access
