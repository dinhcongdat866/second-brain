"""
The access rules, as a truth table.

Runs under pytest if the project ever grows a test runner, and standalone
today: `python backend/tests/test_access.py`. It imports nothing but the module
under test, which is the point of keeping that module free of FastAPI and
SQLAlchemy — the rule that decides whether a stranger can read your notebook
should not need a database to check.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.access import AccessDenied, decide_access, require_write  # noqa: E402

OWNER = "owner-uuid"
VISITOR = "visitor-uuid"


def denied(**kwargs) -> int:
    try:
        decide_access(**kwargs)
    except AccessDenied as exc:
        return exc.status
    return 0


def test_own_copy_wins_over_someone_elses_share():
    # The 'default' collision: two accounts hold a document under the same id
    # and one of them published it. The other must still get their own.
    access = decide_access(
        viewer_id=VISITOR,
        viewer_owns_copy=True,
        share_owner_id=OWNER,
        share_link_access="write",
    )
    assert access.owner_id == VISITOR
    assert access.can_write is True


def test_unpublished_document_is_the_callers_own():
    access = decide_access(VISITOR, False, None, None)
    assert access.owner_id == VISITOR
    assert access.can_write is True


def test_anonymous_caller_on_an_unpublished_id_is_401():
    assert denied(
        viewer_id=None, viewer_owns_copy=False,
        share_owner_id=None, share_link_access=None,
    ) == 401


def test_private_document_is_404_for_everyone_else():
    # Not 403: a visitor should not be able to learn that the document exists.
    assert denied(
        viewer_id=VISITOR, viewer_owns_copy=False,
        share_owner_id=OWNER, share_link_access="none",
    ) == 404
    assert denied(
        viewer_id=None, viewer_owns_copy=False,
        share_owner_id=OWNER, share_link_access="none",
    ) == 404


def test_read_link_reads_the_owners_rows_and_cannot_write():
    for viewer in (VISITOR, None):
        access = decide_access(viewer, False, OWNER, "read")
        assert access.owner_id == OWNER, viewer
        assert access.can_write is False, viewer


def test_write_link_writes_the_owners_rows():
    # The edit has to be filed under the owner, or it lands in an account the
    # owner never reads and the work simply disappears.
    for viewer in (VISITOR, None):
        access = decide_access(viewer, False, OWNER, "write")
        assert access.owner_id == OWNER, viewer
        assert access.can_write is True, viewer


def test_owner_keeps_write_access_to_a_read_only_link():
    # Publishing read-only must not lock the author out of their own document.
    access = decide_access(OWNER, False, OWNER, "read")
    assert access.owner_id == OWNER
    assert access.can_write is True


def test_unknown_link_access_is_treated_as_private():
    # A value the backend does not recognise must fail closed.
    assert denied(
        viewer_id=VISITOR, viewer_owns_copy=False,
        share_owner_id=OWNER, share_link_access="public-please",
    ) == 404


def test_require_write_rejects_a_reader():
    reader = decide_access(VISITOR, False, OWNER, "read")
    try:
        require_write(reader)
    except AccessDenied as exc:
        assert exc.status == 403
    else:
        raise AssertionError("a read-only link was allowed to write")


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failed = 0
    for test in tests:
        try:
            test()
            print(f"PASS  {test.__name__}")
        except AssertionError as exc:
            failed += 1
            print(f"FAIL  {test.__name__}: {exc}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    sys.exit(1 if failed else 0)
