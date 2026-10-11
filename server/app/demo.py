"""Demo mode: replay recorded Claude runs when no API key is present.

A fixture is keyed by the request that produced it. Preset requests carry a
stable `demoId`; anything else is keyed by a hash of the request body.
Fixtures live in `fixtures/<store>.json`.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from datetime import UTC, datetime
from functools import lru_cache
from pathlib import Path
from typing import Any

FIXTURE_DIR = Path(__file__).resolve().parent.parent / "fixtures"
_DEMO_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
_STORE = re.compile(r"^[a-z0-9-]+$")


def request_key(body: dict[str, Any]) -> str:
    """`demoId` when the body has a valid one, otherwise a hash of the whole body."""
    demo_id = body.get("demoId")
    if isinstance(demo_id, str) and _DEMO_ID.match(demo_id):
        return demo_id
    canonical = json.dumps(body, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(canonical.encode()).hexdigest()[:16]


@lru_cache(maxsize=32)
def load_store(store: str) -> dict[str, Any]:
    if not _STORE.match(store):
        raise ValueError(f"Invalid fixture store name: {store}")
    path = FIXTURE_DIR / f"{store}.json"
    return json.loads(path.read_text()) if path.exists() else {}


def find_fixture(store: str, key: str) -> dict[str, Any] | None:
    return load_store(store).get(key)


def recording_enabled() -> bool:
    return os.environ.get("RECORD_FIXTURES") == "1"


def save_fixture(store: str, key: str, fixture: dict[str, Any]) -> None:
    """Write one fixture, keeping keys sorted for clean diffs."""
    if not _STORE.match(store):
        raise ValueError(f"Invalid fixture store name: {store}")
    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    path = FIXTURE_DIR / f"{store}.json"
    current = json.loads(path.read_text()) if path.exists() else {}
    current[key] = fixture
    path.write_text(json.dumps(dict(sorted(current.items())), indent=2) + "\n")
    load_store.cache_clear()


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")
